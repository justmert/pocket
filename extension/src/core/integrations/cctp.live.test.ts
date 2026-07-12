import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import {
  TransactionBuilder,
  Contract,
  Address,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { NETWORKS } from "../config";
import { CCTP, evmAddressToBytes32, zeroBytes32 } from "./cctp";

// Hits live testnet. This is the encoding-regression guard: it SIMULATES the
// exact contract invocations the controller builds and asserts the deployed
// contracts ACCEPT the argument encoding. Simulation never submits. A semantic
// failure (no allowance, dummy attestation) surfaces as Error(Contract, #N),
// which proves the encoding was accepted; a host type/convert error would mean
// an encoding bug and fails the test.
const server = new rpc.Server(NETWORKS.testnet.rpcUrl);
const USER = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";
const chain = CCTP.testnet;
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const addr = (a: string) => nativeToScVal(Address.fromString(a));

async function encodingAccepted(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<void> {
  const source = await server.getAccount(USER);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS.testnet.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  try {
    await server.prepareTransaction(tx);
    // Resolved: the contract accepted the args and the simulated state was valid.
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Accepted-but-semantic failures are reported as Error(Contract, #N).
    // Anything else means the host rejected the argument SHAPES: an encoding bug.
    expect(msg, `non-contract (encoding) error: ${msg}`).toMatch(/Error\(Contract/);
  }
}

describe("live testnet CCTP: the deployed contracts accept the built encoding", () => {
  it("approve (SEP-41) on the USDC SAC", async () => {
    const exp = (await server.getLatestLedger()).sequence + 6000;
    await encodingAccepted(USDC_SAC, "approve", [
      addr(USER),
      addr(chain.tokenMessengerMinter),
      nativeToScVal(10_000000n, { type: "i128" }),
      nativeToScVal(exp, { type: "u32" }),
    ]);
  });

  it("deposit_for_burn on the TokenMessengerMinter", async () => {
    await encodingAccepted(chain.tokenMessengerMinter, "deposit_for_burn", [
      addr(USER),
      nativeToScVal(10_000000n, { type: "i128" }),
      nativeToScVal(6, { type: "u32" }),
      xdr.ScVal.scvBytes(
        Buffer.from(evmAddressToBytes32("0x0000000000000000000000000000000000000001")),
      ),
      addr(USDC_SAC),
      xdr.ScVal.scvBytes(Buffer.from(zeroBytes32())),
      nativeToScVal(0n, { type: "i128" }),
      nativeToScVal(2000, { type: "u32" }),
    ]);
  });

  it("mint_and_forward on the CctpForwarder", async () => {
    await encodingAccepted(chain.forwarder, "mint_and_forward", [
      xdr.ScVal.scvBytes(Buffer.from("00", "hex")),
      xdr.ScVal.scvBytes(Buffer.from("00", "hex")),
    ]);
  });
});
