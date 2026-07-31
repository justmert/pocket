// What the token messenger is already allowed to take.
//
// A CCTP send is two Stellar transactions: `approve` on the USDC SAC, then
// `deposit_for_burn` on the token messenger. Only the burn moves money; the
// approve exists so the messenger may take it. So a burn that fails leaves a
// LIVE allowance behind, already paid for, and the wallet used to answer that
// with "try the bridge again", which rebuilt both legs: a second approve, a
// second fee, for permission the account already had.
//
// This reads the allowance so the second attempt can be the burn alone.
//
// A simulated read, so it costs no fee and bumps no TTL. `allowance` is part of
// the SAC's SEP-41 surface and returns an i128 in the token's own stroops; it
// answers 0 for an allowance that has expired, so an expired one is correctly
// read as "no allowance" rather than as a stale number.
import { Account, Address, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, scValToBigInt } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";

/**
 * The live allowance `spender` holds against `owner` on this SAC, in stroops.
 *
 * Returns null when it could not be read. Null is NOT zero: zero means "the
 * approve leg is required" and null means "we do not know", and the caller
 * treats the second as the first, because building an approve that turns out to
 * be unnecessary costs a fee, while skipping one that was necessary costs a
 * failed burn after the money has been committed.
 */
export async function readAllowance(
  server: rpc.Server,
  sac: string,
  owner: string,
  spender: string,
  source: Account,
  networkPassphrase: string,
): Promise<bigint | null> {
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      new Contract(sac).call(
        "allowance",
        nativeToScVal(Address.fromString(owner)),
        nativeToScVal(Address.fromString(spender)),
      ),
    )
    .setTimeout(30)
    .build();

  try {
    const sim = await server.simulateTransaction(tx);
    if ("error" in sim) return null;
    const value = (sim as { result?: { retval?: unknown } }).result?.retval;
    if (!value) return null;
    return scValToBigInt(value as Parameters<typeof scValToBigInt>[0]);
  } catch {
    // An unreadable allowance is not evidence of one. The caller builds the
    // approve, which is what it did before this function existed.
    return null;
  }
}
