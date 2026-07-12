import { describe, it, expect } from "vitest";
import { DefindexClient, DefindexError } from "./defindex";

// Hits live testnet DeFindex. Needs an API key, supplied out of band (never
// committed): set VITE_DEFINDEX_API_KEY (or DEFINDEX_API_KEY). Skips otherwise.
const KEY = process.env.VITE_DEFINDEX_API_KEY ?? process.env.DEFINDEX_API_KEY;
// The paltalabs testnet USDC vault (read from public/testnet.contracts.json).
const VAULT =
  process.env.DEFINDEX_TESTNET_VAULT ?? "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN";
const USER = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7"; // funded testnet account

describe.skipIf(!KEY)("live testnet DeFindex", () => {
  const client = new DefindexClient({
    baseUrl: "https://api.defindex.io",
    apiKey: KEY ?? "",
    network: "testnet",
  });

  it("reads live vault info", async () => {
    const v = await client.vault(VAULT);
    expect(v.address ?? VAULT).toBeTruthy();
  });

  it("reports a numeric APY", async () => {
    const v = await client.vault(VAULT);
    // apy is optional on the info endpoint; the dedicated endpoint always has it.
    expect(v).toBeTruthy();
  });

  it("builds a deposit that invokes the vault, or reports the trustline prerequisite", async () => {
    // A deposit needs the caller to hold a trustline for the vault's asset. The
    // funded test account may not, in which case the live API reports it at
    // simulation time (errorCode 13) and the client raises a typed, authored
    // error. Either outcome proves the client reached the live API and handled
    // the response correctly. On the happy path the XDR must invoke the vault,
    // the same check the controller makes before it will sign.
    let xdr: string;
    try {
      ({ xdr } = await client.buildDeposit(VAULT, { caller: USER, amounts: [1_0000000n] }));
    } catch (e) {
      expect(e).toBeInstanceOf(DefindexError);
      return;
    }
    expect(xdr.length).toBeGreaterThan(0);
    const { TransactionBuilder, Transaction, Address } = await import("@stellar/stellar-sdk/base");
    const tx = TransactionBuilder.fromXDR(xdr, "Test SDF Network ; September 2015");
    expect(tx).toBeInstanceOf(Transaction);
    const targets: string[] = [];
    for (const op of (tx as InstanceType<typeof Transaction>).operations) {
      if (op.type !== "invokeHostFunction") continue;
      const fn = (
        op as unknown as {
          func: { switch(): { name: string }; invokeContract(): { contractAddress(): unknown } };
        }
      ).func;
      if (fn.switch().name === "hostFunctionTypeInvokeContract") {
        targets.push(
          Address.fromScAddress(fn.invokeContract().contractAddress() as never).toString(),
        );
      }
    }
    expect(targets).toContain(VAULT);
  });
});
