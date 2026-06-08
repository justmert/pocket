import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { rpc } from "@stellar/stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { readConfidentialAccount, readAuditorKey, describeContractError } from "./confidential";
import { NETWORKS } from "../config";
import { isOnCurve } from "../crypto/grumpkin";

// Reads our REAL deployed contracts on testnet, using the account registered in
// the phase 6 end-to-end run.
const dep = JSON.parse(
  readFileSync("/Users/mert/Projects/pocket/resources/deployment-testnet.json", "utf8"),
);
const net = NETWORKS.testnet;
const server = new rpc.Server(net.rpcUrl);
const REGISTERED = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

async function source() {
  return await server.getAccount(REGISTERED);
}

describe("live confidential reads", () => {
  it("reads a registered account's confidential state", async () => {
    const acct = await readConfidentialAccount(
      server,
      dep.token,
      REGISTERED,
      await source(),
      net.passphrase,
    );
    expect(acct).not.toBeNull();
    expect(acct!.auditorId).toBe(0);
    // Every published key must be a valid curve point.
    expect(isOnCurve(acct!.spendingPublicKey)).toBe(true);
    expect(isOnCurve(acct!.viewingPublicKey)).toBe(true);
    // After deposit + merge the spendable side is non-identity and the
    // receiving side is back to the identity.
    expect(isOnCurve(acct!.spendableCommitment)).toBe(true);
  }, 30_000);

  it("returns null for an account with no private pocket", async () => {
    // Not an error: most accounts do not have one, and the UI needs to tell
    // "not set up" apart from "failed to read".
    const ghost = Keypair.random().publicKey();
    const acct = await readConfidentialAccount(
      server,
      dep.token,
      ghost,
      await source(),
      net.passphrase,
    );
    expect(acct).toBeNull();
  }, 30_000);

  it("reads the auditor key we registered", async () => {
    const key = await readAuditorKey(server, 0, dep.auditor, await source(), net.passphrase);
    expect(key).not.toBeNull();
    expect(isOnCurve(key!)).toBe(true);
  }, 30_000);

  it("returns null for an unregistered auditor id", async () => {
    expect(
      await readAuditorKey(server, 9999, dep.auditor, await source(), net.passphrase),
    ).toBeNull();
  }, 30_000);
});

describe("contract error taxonomy", () => {
  it("explains 3501 as an actionable state, not a failure", () => {
    expect(describeContractError(3501)).toMatch(/no private pocket/i);
  });

  it("names 3506 without blaming the user", () => {
    // 3506 is almost never the user's fault: stale commitment, rotated auditor
    // key, or a VK mismatch. Diagnosis happens from public inputs.
    expect(describeContractError(3506)).toMatch(/proof was rejected/i);
  });

  it("falls back rather than throwing on an unknown code", () => {
    expect(describeContractError(9999)).toContain("9999");
  });
});
