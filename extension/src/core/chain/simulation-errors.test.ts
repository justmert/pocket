// A contract refusal has to say what the contract said.
//
// `prepareTransaction` is the wallet's only route from an envelope to the
// ledger, and stellar-sdk implements its failure as
// `throw new Error(simResponse.error)` (rpc/server.js:1098). `name` is
// therefore "Error", which is on neither allowlist in `dispatch.ts`, so EVERY
// contract refusal on EVERY write path rendered "Something went wrong. Try
// again, and check your connection."
//
// Measured live against CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6:
// six of six real failures produced that sentence, including #3506, for which
// the wallet already holds the words "The proof was rejected." The message it
// discarded is 636 characters beginning "HostError: Error(Contract, #3501)".
//
// That sentence is worse than silence. It names a cause that is not the cause
// and invites a retry of something deterministic: a diverged private transfer
// re-proves the same state and fails identically, forever.
import { describe, it, expect, vi } from "vitest";
import { explainSimulationFailure, ContractRefusedError, CONTRACT_ERRORS } from "./confidential";

/** The shape stellar-sdk actually throws, captured from a live simulation. */
function sdkThrow(message: string): Error {
  const e = new Error(message);
  e.name = "Error";
  return e;
}

/** The head of the real 636-character body for an unregistered account. */
const LIVE_3501 =
  "HostError: Error(Contract, #3501)\n\nEvent log (newest first):\n" +
  "   0: [Diagnostic Event] topics:[error, Error(Contract, #3501)], data:" +
  '["contract call failed", confidential_transfer, [GABC..., GDEF...]]\n' +
  "Backtrace (newest first):\n   0: soroban_env_host::vm::Vm::metered_func_call";

describe("a contract refusal reaching the user", () => {
  it("becomes the sentence the wallet already wrote for that code", () => {
    const out = explainSimulationFailure(sdkThrow(LIVE_3501));
    expect(out).toBeInstanceOf(ContractRefusedError);
    expect((out as Error).message).toBe(CONTRACT_ERRORS[3501]);
    expect((out as Error).message).toMatch(/no private pocket yet/);
  });

  it("names the proof rejection instead of blaming the connection", () => {
    // The case that mattered most: retrying re-proves the same diverged state
    // and fails identically, so "try again" is advice that can never work.
    const out = explainSimulationFailure(sdkThrow("HostError: Error(Contract, #3506)"));
    expect((out as Error).message).toBe("The proof was rejected.");
    expect((out as Error).message).not.toMatch(/connection/i);
  });

  it("carries a name the dispatcher's allowlist can pass through", () => {
    // The whole mechanism. Without the name the best sentence in the world
    // still renders as the generic one.
    const out = explainSimulationFailure(sdkThrow(LIVE_3501));
    expect((out as Error).name).toBe("ContractRefusedError");
  });

  it("never lets the RPC's own text reach the user", () => {
    // 636 characters carrying a backtrace, an event log and addresses decoded
    // from the reply. That is the reason the allowlist is by name at all.
    const out = explainSimulationFailure(sdkThrow(LIVE_3501));
    const msg = (out as Error).message;
    expect(msg).not.toMatch(/HostError|Backtrace|Diagnostic|soroban_env_host/);
    expect(msg).not.toMatch(/GABC|GDEF/);
    expect(msg.length).toBeLessThan(200);
  });

  it("still says something honest for a code it has no sentence for", () => {
    // The SAC's own error namespace overlaps nothing in CONTRACT_ERRORS: #13 is
    // its missing-trustline refusal. Naming the number is not a good sentence,
    // and it is a true one, which "check your connection" is not.
    const out = explainSimulationFailure(sdkThrow("HostError: Error(Contract, #13)"));
    expect((out as Error).message).toMatch(/rejected this \(error 13\)/);
    expect((out as Error).name).toBe("ContractRefusedError");
  });

  it("answers getAccount's not-found in our words, not the RPC's", () => {
    // The SDK interpolates the address it decoded from the reply into this
    // message. Matched, then answered with a sentence of our own.
    const addr = "GDMTDHE4PIGI57CKHR4DBUDK5IQBMC6WZUA3RCGLCITJRIFBRMFAJ7UQ";
    const out = explainSimulationFailure(sdkThrow(`Account not found: ${addr}`));
    expect((out as Error).message).toMatch(/does not exist on the network yet/);
    expect((out as Error).message).not.toContain(addr);
  });

  it("leaves an already-named error completely alone", () => {
    // Errors that arrive with their own name have already been explained by
    // whoever threw them, and re-wrapping would lose that.
    const named = new Error("You need a USDC trustline before you can receive it.");
    named.name = "TrustlineRequiredError";
    expect(explainSimulationFailure(named)).toBe(named);
  });

  it("leaves a plain transport failure alone, so it is not mislabelled", () => {
    // A fetch that never reached the RPC says nothing about any contract, and
    // "check your connection" is the RIGHT sentence for it. Turning that into a
    // contract refusal would be the same defect pointing the other way.
    const network = sdkThrow("fetch failed");
    expect(explainSimulationFailure(network)).toBe(network);
  });

  it("passes a non-Error through untouched", () => {
    const weird = { nope: true };
    expect(explainSimulationFailure(weird)).toBe(weird);
  });
});

describe("the controller actually routes its simulations through it", () => {
  // The function above can be perfect and unused. Deleting the call site in
  // `simulate()` leaves every test above green while the wallet goes straight
  // back to "check your connection", so the wiring needs its own assertion.
  it("maps a refusal thrown by prepareTransaction on a real build path", async () => {
    const store = new Map<string, unknown>();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (k: string | null) =>
            k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
          set: async (o: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(o)) store.set(k, v);
          },
          remove: async (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
          },
        },
      },
    });
    const { WalletController } = await import("../controller");
    const { Account } = await import("@stellar/stellar-sdk/base");

    const c = new WalletController();
    await c.init();
    const { address } = await c.create("pw");
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account(address, "100"),
      getLatestLedger: async () => ({ sequence: 1000 }),
      // Exactly what the SDK does on a failed simulation.
      prepareTransaction: async () => {
        throw sdkThrow(LIVE_3501);
      },
      getLedgerEntries: async () => ({ entries: [] }),
    });

    // `prepareForReview` is the shared helper EVERY builder simulates through
    // (the five private ops, the swap, both CCTP legs), and `signAndSubmit`
    // goes through the same `simulate`. Driving it directly asserts the wiring
    // without dragging a proof, a verification key or a third-party API into a
    // test about error mapping.
    const { TransactionBuilder, Operation, Asset, BASE_FEE, Networks } = await import(
      "@stellar/stellar-sdk/base"
    );
    const tx = new TransactionBuilder(new Account(address, "100"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", address) }))
      .setTimeout(180)
      .build();

    const err = await (c as unknown as { prepareForReview(t: unknown): Promise<unknown> })
      .prepareForReview(tx)
      .catch((e: Error) => e);
    expect((err as Error).name).toBe("ContractRefusedError");
    expect((err as Error).message).toBe(CONTRACT_ERRORS[3501]);
  });
});

describe("the authored table these sentences come from", () => {
  it("covers the codes the deployed contract can actually return", () => {
    // 3500 to 3514 is the confidential token's own range. If the contract gains
    // a code this list will not have a sentence for it, and the fallback above
    // names the number rather than inventing a meaning.
    for (let code = 3500; code <= 3514; code++) {
      expect(CONTRACT_ERRORS[code], `no sentence for #${code}`).toBeTruthy();
    }
  });
});
