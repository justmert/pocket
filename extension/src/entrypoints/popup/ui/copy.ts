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
    ? // NOT a promise, and it used to be one: "they can be rebuilt afterwards"
      // was returned on `Boolean(archiveUrl)` alone, which says only that a URL
      // is configured. It does not say the archive is reachable, that it is
      // current, or that it holds this account's history. Measured against the
      // archive this checkout configures: ingested_through 4033277 against a
      // chain at 4035534, about three hours behind, so any private movement in
      // that window would meet RecoveryMismatchError and come back with
      // nothing. This is the last sentence a user reads before the one
      // irreversible act in the product, so it states the dependency instead of
      // guaranteeing the outcome.
      "Your private balances are on the ledger too, but only this device holds the keys that unlock them. Erasing deletes those keys. Rebuilding them afterwards replays your history from the archive, which works only if the archive is reachable and has already recorded everything you have done. Check below before you erase."
    : "Your private balances are on the ledger too, but only this device holds the keys that unlock them. Erasing deletes those keys, and rebuilding them would need a durable archive of your history to replay. This build has none, so those balances could not be recovered.";
}

/**
 * whether the archive could actually rebuild what erasing is about to delete,
 * as a sentence, from what the archive itself reports.
 *
 * `canRebuild` answers "is a URL configured", which is the question the copy
 * above used to answer with. This one answers "is it ready", and only a live
 * read can: unreachable, behind the chain, or missing this contract are three
 * different states and all three end the same way, with the rebuild refusing
 * after the keys are already gone.
 */
export function archiveReadiness(
  health: { ingestedThrough: number | null } | null,
  chainLedger: number | null,
): { ok: boolean; sentence: string } {
  if (!health) {
    return {
      ok: false,
      sentence:
        "Pocket could not reach the archive just now, so it cannot promise your private balances could be rebuilt. Try again before erasing.",
    };
  }
  const through = health.ingestedThrough;
  if (through === null) {
    return {
      ok: false,
      sentence:
        "The archive has recorded nothing for this deployment yet, so there is nothing to rebuild from.",
    };
  }
  // A lag in LEDGERS, not seconds: seconds is what the archive believes about
  // the clock, and ledgers is what the replay actually needs.
  const behind = chainLedger === null ? null : chainLedger - through;
  if (behind === null) {
    return {
      ok: false,
      sentence: `The archive has recorded your history up to ledger ${through}. Pocket could not read the chain's own position to check whether that is current.`,
    };
  }
  if (behind > 0) {
    return {
      ok: false,
      sentence: `The archive is ${behind} ledgers behind the chain. Anything you have done in that window could not be rebuilt after erasing.`,
    };
  }
  return {
    ok: true,
    sentence:
      "The archive is up to date with the chain, so your private balances could be rebuilt.",
  };
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
 * `archiveUrl` is supplied at build time, so whether a build can rebuild is a
 * property OF THAT BUILD and this function is the only honest way to ask.
 *
 * it used to assert that "no shipped build sets it", which is a claim about
 * every artifact that will ever exist and is not this file's to make:
 * `.env.production` exists precisely to supply one at release time, and the
 * release gate refuses a LOOPBACK url rather than refusing the variable. a
 * comment that decides the answer in advance is how a control comes to be
 * hidden on a build that could have used it.
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
 * every recovery-phrase length this wallet accepts.
 *
 * BIP-39 defines five, and the worker accepts all five: `doImport` and
 * `doRecoverFromMnemonic` both gate on `validateMnemonic`, which passes 128,
 * 160, 192, 224 and 256 bits of entropy. Executed against the shipped worker
 * through the real message router: import and recoverFromMnemonic both returned
 * ok for 12, 15, 18, 21 and 24 words.
 *
 * The forgotten-password screen allowed only 12 or 24, so it refused phrases
 * this same wallet had accepted at set-up, and it is the ONLY route back in.
 * Here rather than in one screen because two doors read it, and a set the two
 * doors disagree about is how this happened.
 */
export const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

/** "12, 15, 18, 21 or 24", for a sentence about the above. */
export function phraseLengthList(): string {
  const all = PHRASE_LENGTHS;
  return `${all.slice(0, -1).join(", ")} or ${all[all.length - 1]}`;
}
