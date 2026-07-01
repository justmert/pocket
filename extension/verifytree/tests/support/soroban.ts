// Contract reads for assertions, made independently of the wallet.
//
// This uses @stellar/stellar-sdk as an ordinary client, the way any third party
// would. It does NOT import anything under src/: not the controller, not the
// confidential read path, not even the network config. Contract addresses come
// from resources/deployment-testnet.json, the record of what was actually
// deployed, so a spec that reads through here is also checking the wallet is
// pointed at that deployment rather than at whatever its own constants say.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

export interface Deployment {
  network: string;
  deployer: string;
  underlying: string;
  verifier: string;
  auditor: string;
  token: string;
}

export const DEPLOYMENT: Deployment = JSON.parse(
  readFileSync(resolve(here, "../../../resources/deployment-testnet.json"), "utf8"),
) as Deployment;

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * `owner_of(id)` on the auditor registry, read straight from RPC.
 *
 * Simulation only: nothing is signed and nothing is submitted, so the source
 * account just has to exist. This is the evidence behind D8 -- that a wallet
 * bound ITS OWN auditor key rather than the deployer's, which is permanent for
 * the life of the confidential account and cannot be repaired afterwards.
 */
export async function auditorOwner(auditorId: number, sourceAddress: string): Promise<string> {
  const { rpc, TransactionBuilder, Contract, Account, nativeToScVal, BASE_FEE, scValToNative } =
    await import("@stellar/stellar-sdk");
  const server = new rpc.Server(RPC_URL);
  const source = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(new Account(sourceAddress, source.sequenceNumber()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      new Contract(DEPLOYMENT.auditor).call("owner_of", nativeToScVal(auditorId, { type: "u32" })),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) throw new Error(`owner_of(${auditorId}) simulation failed: ${sim.error}`);
  const result = (sim as { result?: { retval: unknown } }).result;
  if (!result) throw new Error(`owner_of(${auditorId}) returned no value`);
  return scValToNative(result.retval as never) as string;
}
