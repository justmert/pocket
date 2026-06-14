// The private-pocket operations, orchestrated end to end.
//
// This is where the layers meet: derive keys, read chain state, build a
// witness, prove in the offscreen document, encode the payload, submit, and
// persist the resulting openings.
//
// The openings are the part that must not be got wrong. The chain stores
// commitments; only this store knows what opens them. Losing it makes funds
// visible on chain and permanently unspendable, so it is written BEFORE the
// operation is considered done and is never treated as a cache.
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Keypair,
  type Transaction,
} from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import { addressToField } from "./crypto/address";
import { signerRoot, verifyRoot } from "./keys/root";
import { deriveSk } from "./keys/sk";
import { buildRegisterWitness } from "./witness/register";
import { buildWithdrawWitness } from "./witness/withdraw";
import { buildTransferWitness, decryptIncomingTransfer } from "./witness/transfer";
import { encodeRegisterData, encodeWithdrawData, encodeTransferData } from "./witness/payload";
import { circuitInputs } from "./witness/inputs";
import { sampleSalt } from "./witness/salt";
import { spendRandomness } from "./crypto/derive";
import { commit, type Point } from "./crypto/grumpkin";
import { prove } from "./prover/client";
import { DEFAULT_TIMEOUT_SECONDS } from "./chain/submit";
import type { Opening } from "./witness/types";

/** Everything an operation needs about the deployment and the signer. */
export interface OpContext {
  server: rpc.Server;
  networkPassphrase: string;
  tokenId: string;
  auditorRegistryId: string;
  keypair: Keypair;
  /** Compiled circuit artifacts, fetched from the extension package. */
  circuits: CircuitSource;
}

export interface CircuitSource {
  /** Decompressed ACIR for a circuit. */
  acir(name: string): Promise<Uint8Array>;
  /** Solve a witness into the bytes the prover takes. */
  solve(name: string, inputs: Record<string, bigint>): Promise<Uint8Array>;
}

/** Derive this account's confidential keys for this deployment. */
export async function deriveConfidentialKeys(ctx: OpContext): Promise<{
  sk: bigint;
  vk: bigint;
  addrF: bigint;
  acctF: bigint;
}> {
  const account = ctx.keypair.publicKey();
  const addrF = addressToField(ctx.tokenId);
  const acctF = addressToField(account);

  const root = signerRoot(ctx.keypair, ctx.tokenId, account);
  // MUST verify. A signature from a different account is well-formed and
  // yields a wrong-but-usable sk; register being single-use makes that
  // unrepairable.
  if (!verifyRoot(root, ctx.keypair.publicKey(), ctx.tokenId, account)) {
    throw new Error("the signer produced a root that does not verify against its own key");
  }

  const { sk, vk } = await deriveSk(root, addrF, acctF);
  return { sk, vk, addrF, acctF };
}

/** Build an invocation of the confidential token. */
function invoke(ctx: OpContext, source: Account, method: string, args: xdr.ScVal[]): Transaction {
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: ctx.networkPassphrase,
  })
    .addOperation(new Contract(ctx.tokenId).call(method, ...args))
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
    .build();
}

const addr = (a: string) => nativeToScVal(Address.fromString(a));
const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

/**
 * Register a confidential account.
 *
 * One-time, publicly visible, and it binds an auditor permanently. The caller
 * must have told the user all three before reaching here.
 */
export async function buildRegister(
  ctx: OpContext,
  auditorId: number,
): Promise<{ tx: Transaction; vk: bigint; openings: { spendable: Opening; receiving: Opening } }> {
  const { sk, vk, addrF, acctF } = await deriveConfidentialKeys(ctx);
  const w = buildRegisterWitness({ sk, addrF, acctF });

  const acir = await ctx.circuits.acir("register");
  const solved = await ctx.circuits.solve("register", circuitInputs(w));

  const { proof } = await prove("register", acir, solved);
  const data = encodeRegisterData(w.payload.Y as Point, w.payload.PVK as Point, proof);

  const account = ctx.keypair.publicKey();
  const source = await ctx.server.getAccount(account);
  return {
    tx: invoke(ctx, source, "register", [
      addr(account),
      nativeToScVal(auditorId, { type: "u32" }),
      bytes(data),
    ]),
    vk,
    // A fresh account holds the identity on both sides.
    openings: {
      spendable: { value: 0n, randomness: 0n },
      receiving: { value: 0n, randomness: 0n },
    },
  };
}

/**
 * Shield: deposit then merge, as TWO transactions.
 *
 * A deposit credits the RECEIVING side, so shielding without the merge leaves
 * the user with a zero spendable balance and no idea why. Both are returned so
 * the caller chains them; neither needs a proof.
 */
export async function buildShield(
  ctx: OpContext,
  amount: bigint,
): Promise<{ deposit: Transaction; merge: Transaction }> {
  const account = ctx.keypair.publicKey();
  const source = await ctx.server.getAccount(account);
  const deposit = invoke(ctx, source, "deposit", [
    addr(account),
    addr(account),
    nativeToScVal(amount, { type: "i128" }),
  ]);
  // Sequence advances, so the merge builds on the next number.
  const next = new Account(account, (BigInt(source.sequenceNumber()) + 1n).toString());
  const merge = invoke(ctx, next, "merge", [addr(account)]);
  return { deposit, merge };
}

/** Fold the receiving side into spendable. Needs auth, needs no proof. */
export async function buildMerge(ctx: OpContext): Promise<Transaction> {
  const account = ctx.keypair.publicKey();
  const source = await ctx.server.getAccount(account);
  return invoke(ctx, source, "merge", [addr(account)]);
}

export interface TransferInput {
  recipient: string;
  recipientPvk: Point;
  recipientAuditorKey: Point;
  senderAuditorKey: Point;
  amount: bigint;
  spendable: Opening;
  onChainSpendable: Point;
}

/**
 * A confidential transfer.
 *
 * A FRESH salt per attempt, including a retry after a revert. The salt is the
 * only freshness input to every derived pad in the operation, the ephemeral
 * included, so reuse repeats the ephemeral key and every channel mask.
 */
export async function buildTransfer(
  ctx: OpContext,
  input: TransferInput,
): Promise<{ tx: Transaction; newSpendable: Opening; sigma: bigint }> {
  const { sk, vk, addrF } = await deriveConfidentialKeys(ctx);
  const sigma = sampleSalt();

  const w = buildTransferWitness({
    sk,
    addrF,
    spendable: input.spendable,
    amount: input.amount,
    sigma,
    recipientPvk: input.recipientPvk,
    recipientAuditorKey: input.recipientAuditorKey,
    senderAuditorKey: input.senderAuditorKey,
    onChainSpendable: input.onChainSpendable,
  });

  const acir = await ctx.circuits.acir("transfer");
  const solved = await ctx.circuits.solve("transfer", circuitInputs(w));

  const { proof } = await prove("transfer", acir, solved);
  const data = encodeTransferData(w.payload as Parameters<typeof encodeTransferData>[0], proof);

  const account = ctx.keypair.publicKey();
  const source = await ctx.server.getAccount(account);

  return {
    tx: invoke(ctx, source, "confidential_transfer", [
      addr(account),
      addr(input.recipient),
      bytes(data),
    ]),
    // The new spendable opening, deterministic in (vk, sigma). Persist this
    // BEFORE treating the operation as done: without it the remaining balance
    // is visible on chain and unspendable.
    newSpendable: {
      value: input.spendable.value - input.amount,
      randomness: spendRandomness(vk, sigma),
    },
    sigma,
  };
}

/** Unshield: prove and withdraw. The amount becomes PUBLIC at this boundary. */
export async function buildUnshield(
  ctx: OpContext,
  input: {
    amount: bigint;
    spendable: Opening;
    onChainSpendable: Point;
    auditorKey: Point;
    destination: string;
  },
): Promise<{ tx: Transaction; newSpendable: Opening; sigma: bigint }> {
  const { sk, vk, addrF } = await deriveConfidentialKeys(ctx);
  const sigma = sampleSalt();

  const w = buildWithdrawWitness({
    sk,
    addrF,
    spendable: input.spendable,
    amount: input.amount,
    sigma,
    auditorKey: input.auditorKey,
    onChainSpendable: input.onChainSpendable,
  });

  const acir = await ctx.circuits.acir("withdraw");
  const solved = await ctx.circuits.solve("withdraw", circuitInputs(w));

  const { proof } = await prove("withdraw", acir, solved);
  const data = encodeWithdrawData(w.payload as Parameters<typeof encodeWithdrawData>[0], proof);

  const account = ctx.keypair.publicKey();
  const source = await ctx.server.getAccount(account);

  return {
    tx: invoke(ctx, source, "withdraw", [
      addr(account),
      addr(input.destination),
      nativeToScVal(input.amount, { type: "i128" }),
      bytes(data),
    ]),
    newSpendable: {
      value: input.spendable.value - input.amount,
      randomness: spendRandomness(vk, sigma),
    },
    sigma,
  };
}

/** Re-export so callers need not reach across layers. */
export { decryptIncomingTransfer, commit };
