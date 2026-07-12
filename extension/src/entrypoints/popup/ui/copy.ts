// sentences that more than one screen has to say identically.
//
// there are two doors to erasing this wallet, one from settings and one from
// the locked screen, and they described the same consequence differently: the
// settings door said a rebuild "needs your history from an archive", which
// reads as though a rebuild exists, while the other read the config and said
// which of the two situations this build is actually in. the softer wording was
// on the door more people reach. so the sentence lives here and is read from
// the same place by both.
import { NETWORKS } from "../../../core/config";
import type { NetworkId } from "../../../core/config";

/**
 * what happens to private balances when the vault on this device is destroyed.
 *
 * the phrase reproduces the address and the ledger holds the public balance, so
 * the public pocket always returns. the private one is opened by keys held only
 * here, and whether it can be rebuilt depends on whether this build has an
 * archive to replay.
 */
export function privateLossAfterErase(network: NetworkId): string {
  return NETWORKS[network].archiveUrl
    ? "Your private balances are on the ledger too, but only this device holds the keys that unlock them. Erasing deletes those keys; they can be rebuilt afterwards by replaying your history from the archive."
    : "Your private balances are on the ledger too, but only this device holds the keys that unlock them. Erasing deletes those keys, and rebuilding them would need a durable archive of your history to replay. This build has none, so those balances could not be recovered.";
}

/**
 * what an absent memo means.
 *
 * the wallet's own review said this and the screen that authorises a site's
 * transaction said only "None.", which is the same fact with the consequence
 * removed on the screen where the wallet knows least about what it is signing.
 */
export const NO_MEMO = "None. Exchanges usually require one; a deposit without it can be lost.";

/**
 * whether this build can rebuild private balances at all.
 *
 * the rebuild replays the confidential event history from a durable archive.
 * `archiveUrl` is supplied at build time and no shipped build sets it —
 * config.ts records that the release gate refuses the only value that exists,
 * a loopback address. so on every artifact a user can install, the answer is no.
 *
 * this is the same read `privateLossAfterErase` makes, and it exists because the
 * copy branched on it and the CONTROLS did not: a settings row, a sheet and a
 * primary button all offered a rebuild that answers with a refusal, one of them
 * three lines under the worker's own sentence saying it cannot be done. a user
 * was told "your balances cannot be rebuilt" and handed a button labelled
 * "Rebuild from history", and could only learn which was true by pressing it.
 */
export function canRebuild(network: NetworkId): boolean {
  return Boolean(NETWORKS[network].archiveUrl);
}

/**
 * The dormancy warning, in one place because it was written in two and both
 * were wrong the same way.
 *
 * Both said "opening the wallet before then keeps it alive". It does not.
 * Opening the wallet performs a SIMULATED read, and `chain/confidential.ts`
 * states in its own words that a simulated read does not bump the entry: only
 * a submitted transaction does. So the wallet gave an instruction that someone
 * could follow exactly and still lose access to their private pocket, which is
 * a worse failure than saying nothing.
 *
 * What is true is one step removed. Pocket submits a keep-alive itself, from
 * `runKeepAlive`, whenever the wallet is unlocked with the deadline close. So
 * opening it IS sufficient, not because opening bumps anything, but because
 * being open is what lets the wallet send the transaction that does. The
 * sentence has to say that, or the next person to read the TTL code will
 * "correct" it back.
 */
export function dormancyWarning(days: number): string {
  return (
    `This pocket goes dormant in ${days} ${days === 1 ? "day" : "days"} unless a transaction is ` +
    `submitted for it. Pocket sends one for you whenever the wallet is unlocked in time, so ` +
    `opening it once before then is enough. Viewing a balance alone is not.`
  );
}
