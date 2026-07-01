import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Asset, Keypair } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { readNative, readTrustline, minimumBalance, AccountNotFoundError } from "./balances";
import { NETWORKS } from "../config";

// Hits live testnet. Not mocked: the point is that these calls actually work.
const server = new rpc.Server(NETWORKS.testnet.rpcUrl);
const FUNDED = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";

describe("live testnet balance reads", () => {
  it("reads a funded account's native balance", async () => {
    const acc = await readNative(server, FUNDED);
    expect(acc.raw).toBeGreaterThan(0n);
    expect(acc.subEntryCount).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes a nonexistent account from a zero balance", async () => {
    // A never-funded key: the entry does not exist at all, which is a different
    // state from an account holding zero, and the UI must not conflate them.
    const ghost = Keypair.random().publicKey();
    await expect(readNative(server, ghost)).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("returns null for an asset with no trustline rather than a zero balance", async () => {
    const usdc = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(await readTrustline(server, FUNDED, usdc)).toBeNull();
  });

  it("computes a minimum balance consistent with the live account", async () => {
    const acc = await readNative(server, FUNDED);
    // Base reserve is 0.5 XLM = 5_000_000 stroops on both networks today.
    const min = minimumBalance(acc, 5_000_000n);
    expect(min).toBeGreaterThanOrEqual(10_000_000n); // at least the 2-entry floor
    expect(acc.raw).toBeGreaterThan(min); // funded account is above its reserve
  });
});
