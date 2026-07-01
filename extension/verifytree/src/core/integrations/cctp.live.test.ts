import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Address, xdr } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { CCTP } from "./cctp";
import { NETWORKS } from "../config";

// The forwarder addresses are the difference between a bridge that works and
// funds that cannot be recovered, so they are checked against the chain rather
// than trusted from a document.
const server = new rpc.Server(NETWORKS.testnet.rpcUrl);

async function contractExists(id: string): Promise<boolean> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await server.getLedgerEntries(key);
  return res.entries.length > 0;
}

describe("live CCTP contracts on testnet", () => {
  it("the CctpForwarder exists at the address we would send funds to", async () => {
    expect(await contractExists(CCTP.testnet.forwarder)).toBe(true);
  }, 30_000);

  it("the TokenMessengerMinter exists", async () => {
    expect(await contractExists(CCTP.testnet.tokenMessengerMinter)).toBe(true);
  }, 30_000);

  it("the MessageTransmitter exists", async () => {
    expect(await contractExists(CCTP.testnet.messageTransmitter)).toBe(true);
  }, 30_000);

  it("testnet and mainnet addresses are distinct", () => {
    // Using a mainnet forwarder on testnet, or the reverse, strands the funds.
    for (const k of ["forwarder", "tokenMessengerMinter", "messageTransmitter"] as const) {
      expect(CCTP.testnet[k]).not.toBe(CCTP.mainnet[k]);
    }
  });

  it("every configured address is a well-formed contract id", () => {
    for (const net of ["testnet", "mainnet"] as const) {
      for (const k of ["forwarder", "tokenMessengerMinter", "messageTransmitter"] as const) {
        expect(CCTP[net][k]).toMatch(/^C[A-Z2-7]{55}$/);
      }
    }
  });
});
