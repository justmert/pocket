import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import { Account } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import { readAuditorKey, readConfidentialAccount, ConfidentialReadError } from "./confidential";

const PASSPHRASE = "Test SDF Network ; September 2015";
const SOURCE = new Account("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", "1");
const REGISTRY = "CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

const simulating = (sim: unknown): rpc.Server =>
  ({ simulateTransaction: async () => sim }) as unknown as rpc.Server;

describe("an unreachable registry is not evidence about the registry's contents", () => {
  // The caller turns null into "auditor #N has no registered key". Saying that
  // because a simulation failed is a claim about the ledger asserted from a
  // request that never reached it, and it points the user at the wrong remedy.
  it("returns null only for AuditorNotRegistered", async () => {
    expect(
      await readAuditorKey(
        simulating({ error: "HostError: Error(Contract, #3301)" }),
        7,
        REGISTRY,
        SOURCE,
        PASSPHRASE,
      ),
    ).toBeNull();
  });

  it("refuses to call any other simulation error 'unregistered'", async () => {
    await expect(
      readAuditorKey(
        simulating({ error: "HostError: Error(WasmVm, InvalidAction)" }),
        7,
        REGISTRY,
        SOURCE,
        PASSPHRASE,
      ),
    ).rejects.toBeInstanceOf(ConfidentialReadError);
  });

  it("says the registry is dormant rather than that the auditor is missing", async () => {
    // An archived persistent entry simulates with a restore preamble. Reading
    // that as "no such auditor" sends the user to change auditors when the
    // remedy is to restore an entry.
    await expect(
      readAuditorKey(
        simulating({ restorePreamble: { transactionData: {}, minResourceFee: "1" } }),
        7,
        REGISTRY,
        SOURCE,
        PASSPHRASE,
      ),
    ).rejects.toThrow(/dormant/i);
  });

  it("refuses a value of the wrong shape instead of decoding whatever arrived", async () => {
    await expect(
      readAuditorKey(
        simulating({ result: { retval: { switch: () => ({ name: "scvVoid" }) } } }),
        7,
        REGISTRY,
        SOURCE,
        PASSPHRASE,
      ),
    ).rejects.toBeInstanceOf(ConfidentialReadError);
  });

  it("never leaks the RPC's own words into the message", async () => {
    // SDK.md 13: an RPC-authored string must not reach a user, so every branch
    // here carries text this repository wrote.
    const rpcSaid = "connect ECONNREFUSED 10.0.0.1:8000 /secret-path";
    await expect(
      readAuditorKey(simulating({ error: rpcSaid }), 7, REGISTRY, SOURCE, PASSPHRASE),
    ).rejects.toThrow(/^(?!.*ECONNREFUSED).*$/);
  });
});

describe("a dormant private pocket reads as dormant, not as absent", () => {
  it("returns null for a restore preamble so the caller can report 'dormant'", async () => {
    // Deliberate: the private-pocket screen distinguishes this from
    // unregistered by reading the TTL, and raising here would show a failure
    // where the right answer is "reactivate it".
    expect(
      await readConfidentialAccount(
        simulating({ restorePreamble: { transactionData: {}, minResourceFee: "1" } }),
        TOKEN,
        SOURCE.accountId(),
        SOURCE,
        PASSPHRASE,
      ),
    ).toBeNull();
  });

  it("returns null for AccountNotRegistered, which is a normal state", async () => {
    expect(
      await readConfidentialAccount(
        simulating({ error: "Error(Contract, #3501)" }),
        TOKEN,
        SOURCE.accountId(),
        SOURCE,
        PASSPHRASE,
      ),
    ).toBeNull();
  });

  it("raises an authored message for anything else", async () => {
    await expect(
      readConfidentialAccount(
        simulating({ error: "connect ECONNREFUSED 10.0.0.1:8000" }),
        TOKEN,
        SOURCE.accountId(),
        SOURCE,
        PASSPHRASE,
      ),
    ).rejects.toThrow(/^(?!.*ECONNREFUSED).*$/);
  });
});
