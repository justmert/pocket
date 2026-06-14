// Trap 14, from SDK.md 8.2: a client MUST verify that the verification key its
// artifact implies is the one the deployment actually holds.
//
// Why this is not paranoia. The wallet proves against a circuit it ships. The
// chain verifies against a key the verifier contract holds. If those disagree,
// every proof the wallet builds is rejected, and the failure surfaces as an
// opaque contract error at submit time rather than as the version mismatch it
// is. Worse in the other direction: a verifier holding a key from a DIFFERENT
// circuit revision accepts proofs of a different statement, and nothing on
// chain can tell.
//
// The check is a hash comparison. The keys are 1760 bytes and the sha256 of
// each is pinned in vk-hashes.json, reproduced from circuit source by gate 2.
import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk/base";
import type { Account } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import PINNED from "../vk-hashes.json";

/** The six circuits, in the order the verifier contract indexes them. */
export const CIRCUITS = [
  "register",
  "withdraw",
  "transfer",
  "spender_transfer",
  "set_spender",
  "revoke_spender",
] as const;

export type CircuitName = (typeof CIRCUITS)[number];

export class VerificationKeyMismatchError extends Error {
  override readonly name = "VerificationKeyMismatchError";
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Read one verification key from the deployed verifier. */
export async function readVerificationKey(
  server: rpc.Server,
  verifierId: string,
  circuit: CircuitName,
  source: Account,
  networkPassphrase: string,
): Promise<Uint8Array | null> {
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      new Contract(verifierId).call(
        "get_verification_key",
        nativeToScVal(CIRCUITS.indexOf(circuit), { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) return null;
  const raw = (sim as { result?: { retval: xdr.ScVal } }).result?.retval;
  if (!raw || raw.switch().name !== "scvBytes") return null;
  return new Uint8Array(raw.bytes());
}

/**
 * The verifier the TOKEN is actually bound to, read from its instance storage.
 *
 * `ConfidentialTokenStorageKey::Verifier` is a `#[contracttype]` enum variant,
 * so on the wire the key is a one-element vector holding the symbol. The token
 * binds it in its constructor and exposes no getter, but instance storage is
 * public ledger state, so a client can read it without the contract's help.
 *
 * Returns null on anything unexpected, and every caller treats null as a
 * refusal.
 */
export async function readBoundVerifier(
  server: rpc.Server,
  tokenId: string,
): Promise<string | null> {
  let entry;
  try {
    entry = await server.getContractData(tokenId, xdr.ScVal.scvLedgerKeyContractInstance());
  } catch {
    return null;
  }
  let storage;
  try {
    storage = entry.val.contractData().val().instance().storage();
  } catch {
    return null;
  }
  for (const kv of storage ?? []) {
    const key = kv.key();
    if (key.switch().name !== "scvVec") continue;
    const head = key.vec()?.[0];
    if (!head || head.switch().name !== "scvSymbol") continue;
    if (head.sym().toString() !== "Verifier") continue;
    const val = kv.val();
    if (val.switch().name !== "scvAddress") return null;
    return Address.fromScVal(val).toString();
  }
  return null;
}

/**
 * Check that the token routes its proofs to the verifier we are about to check.
 *
 * Without this, trap 14 compares a key held by whatever address our own config
 * names against a hash pinned by our own build: two values we chose, agreeing
 * with each other and saying nothing about the deployment. If the token is
 * bound to a different verifier, every proof still goes to that one, and the
 * mismatch resurfaces as the opaque submit-time contract error trap 14 exists
 * to prevent.
 *
 * Fails CLOSED, as the key check does: an unreadable binding is a refusal.
 */
export async function assertVerifierBinding(
  server: rpc.Server,
  tokenId: string,
  expectedVerifier: string,
): Promise<void> {
  const bound = await readBoundVerifier(server, tokenId);
  if (!bound) {
    throw new VerificationKeyMismatchError(
      `Pocket could not read which verifier this deployment uses, so it will not build a ` +
        `proof against it.`,
    );
  }
  if (bound !== expectedVerifier) {
    throw new VerificationKeyMismatchError(
      `This deployment sends its proofs to a verifier Pocket does not recognise. ` +
        `The extension and the contract are different versions; updating Pocket is the fix.`,
    );
  }
}

/**
 * Check that the deployment's key for one circuit is the key we prove against.
 *
 * Fails CLOSED. An unreadable key is reported as a mismatch, not waved through:
 * the whole point is to refuse to build a proof whose verification key we could
 * not confirm.
 *
 * Pass `tokenId` to also confirm the token is bound to `verifierId`. Callers
 * that know the token SHOULD pass it: without it this confirms only that some
 * named contract holds the expected key, not that the contract verifying our
 * proof is that one.
 */
export async function assertVerificationKey(
  server: rpc.Server,
  verifierId: string,
  circuit: CircuitName,
  source: Account,
  networkPassphrase: string,
  tokenId?: string,
): Promise<void> {
  if (tokenId) await assertVerifierBinding(server, tokenId, verifierId);
  const onChain = await readVerificationKey(server, verifierId, circuit, source, networkPassphrase);
  if (!onChain) {
    throw new VerificationKeyMismatchError(
      `Pocket could not read the ${circuit} verification key from this deployment, so it will ` +
        `not build a proof against it.`,
    );
  }
  const want = (PINNED as Record<string, string>)[circuit];
  const got = await sha256Hex(onChain);
  if (got !== want) {
    throw new VerificationKeyMismatchError(
      `This deployment's ${circuit} verification key is not the one Pocket proves against. ` +
        `The extension and the contract are different versions; updating Pocket is the fix.`,
    );
  }
}

/** The pinned hashes, exposed so tests can pin them against the built artifacts. */
export const PINNED_VK_HASHES = PINNED as Record<CircuitName, string>;
