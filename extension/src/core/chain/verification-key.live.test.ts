// Trap 14 against the real deployment.
//
// This is the check that would have caught building against the upstream
// demo's testnet verifier, which holds PRE-AUDIT keys: same six circuits, same
// 1760-byte layout, different hashes.
import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { NETWORKS } from "../config";
import {
  readVerificationKey,
  readBoundVerifier,
  assertVerificationKey,
  assertVerifierBinding,
  VerificationKeyMismatchError,
  PINNED_VK_HASHES,
  CIRCUITS,
} from "./verification-key";

/** Addresses come from the tracked config, never from an untracked file. */
function deployment() {
  const c = NETWORKS.testnet.confidential[0];
  if (!c) throw new Error("no confidential deployment configured for testnet");
  return c;
}

const dep = deployment();
const net = NETWORKS.testnet;
const server = new rpc.Server(net.rpcUrl);
const SECRET = process.env.POCKET_TESTNET_SECRET;

async function source() {
  // Any funded account works: simulation does not consume a sequence number.
  return server.getAccount(Keypair.fromSecret(SECRET!).publicKey());
}

const hex = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

describe.skipIf(!SECRET)("verification keys on the deployed verifier", () => {
  it("holds all six keys at the 1760-byte on-chain layout", async () => {
    const src = await source();
    for (const c of CIRCUITS) {
      const vk = await readVerificationKey(server, dep.verifier, c, src, net.passphrase);
      expect(vk, `${c} must be registered`).not.toBeNull();
      expect(vk!.length, `${c} layout`).toBe(1760);
    }
  }, 90_000);

  it("every on-chain key hashes to the value pinned from circuit source", async () => {
    const src = await source();
    for (const c of CIRCUITS) {
      const vk = await readVerificationKey(server, dep.verifier, c, src, net.passphrase);
      // The pinned hashes are reproduced by release gate 2 with
      // `bb write_vk --oracle_hash keccak`, so agreement here means the chain
      // holds keys derived from the circuits this build proves against.
      expect(await hex(vk!), `${c}`).toBe(PINNED_VK_HASHES[c]);
    }
  }, 90_000);

  it("passes the assertion the operation path runs before proving", async () => {
    const src = await source();
    await expect(
      assertVerificationKey(server, dep.verifier, "transfer", src, net.passphrase),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("fails closed against a contract that is not a verifier", async () => {
    const src = await source();
    // The token contract has no get_verification_key, so the read fails. It
    // must be reported as a mismatch, never waved through: the entire point is
    // to refuse a proof whose key could not be confirmed.
    await expect(
      assertVerificationKey(server, dep.token, "transfer", src, net.passphrase),
    ).rejects.toBeInstanceOf(VerificationKeyMismatchError);
  }, 60_000);
});

describe.skipIf(!SECRET)("the verifier the token is actually bound to", () => {
  it("reads the binding from the token's instance storage", async () => {
    // The token has no get_verifier entry point. The address is nonetheless
    // public ledger state, which is what makes checking it possible at all.
    expect(await readBoundVerifier(server, dep.token)).toBe(dep.verifier);
  }, 60_000);

  it("accepts the configured pair", async () => {
    await expect(assertVerifierBinding(server, dep.token, dep.verifier)).resolves.toBeUndefined();
  }, 60_000);

  it("refuses a verifier the token does not route to", async () => {
    // The auditor registry is a real, live contract that is simply not this
    // token's verifier. Checking a key it does not hold would otherwise be a
    // pass on a config we chose, agreeing with a hash we chose.
    await expect(assertVerifierBinding(server, dep.token, dep.auditor)).rejects.toBeInstanceOf(
      VerificationKeyMismatchError,
    );
  }, 60_000);

  it("refuses when the binding cannot be read at all", async () => {
    // The verifier contract is not a confidential token, so it has no Verifier
    // entry in its instance storage. Fail closed, never wave through.
    await expect(assertVerifierBinding(server, dep.verifier, dep.verifier)).rejects.toBeInstanceOf(
      VerificationKeyMismatchError,
    );
  }, 60_000);

  it("rejects the whole assertion when the token is bound elsewhere", async () => {
    const src = await source();
    // Passing the token makes the assertion cover the binding as well as the
    // key, so a verifier holding the right key but wired to nothing is refused
    // before the key is even read.
    await expect(
      assertVerificationKey(server, dep.verifier, "transfer", src, net.passphrase, dep.auditor),
    ).rejects.toBeInstanceOf(VerificationKeyMismatchError);
  }, 60_000);

  it("passes end to end with the real token and verifier", async () => {
    const src = await source();
    await expect(
      assertVerificationKey(server, dep.verifier, "transfer", src, net.passphrase, dep.token),
    ).resolves.toBeUndefined();
  }, 60_000);
});
