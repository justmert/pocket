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
import type { PrivatePocketState } from "../../../core/messages";

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
      // current, or that it holds this account's history. `archiveReadiness`
      // below answers that from a live read, and it is drawn beside this line.
      "Private balances come back only from the archive."
    : "Private balances cannot be recovered.";
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
      sentence: "Archive unreachable: private balances could not be rebuilt.",
    };
  }
  const through = health.ingestedThrough;
  if (through === null) {
    return {
      ok: false,
      sentence: "Nothing recorded yet: private balances could not be rebuilt.",
    };
  }
  // A lag in LEDGERS, not seconds: seconds is what the archive believes about
  // the clock, and ledgers is what the replay actually needs.
  const behind = chainLedger === null ? null : chainLedger - through;
  if (behind === null) {
    return {
      ok: false,
      sentence: "Cannot confirm your private balances could be rebuilt.",
    };
  }
  if (behind > 0) {
    return {
      ok: false,
      sentence: "Archive is behind: recent private activity could not be rebuilt.",
    };
  }
  return { ok: true, sentence: "Archive up to date" };
}

/**
 * what an absent memo means.
 *
 * one string, because both confirm surfaces carry it: the wallet's own review
 * and the screen that authorises a site's transaction, which is where the wallet
 * knows least about what it is signing. the absence itself is the row's value
 * ("None"), so this is only the consequence.
 */
export const NO_MEMO = "Exchanges usually need one; a deposit without it can be lost.";

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

/**
 * why the private pocket cannot move value yet, one state to one sentence.
 *
 * one table, next to the actions it pairs with. Send and Move carried the same
 * six sentences with one verb changed, twelve paragraphs for six facts, and
 * they drifted.
 */
export const PRIVATE_NOT_READY: Record<PrivatePocketState, string> = {
  unavailable: "This network has no private pocket.",
  unfunded: "Receive some XLM first.",
  unregistered: "Not set up yet.",
  archived: "Dormant from disuse.",
  needsRecovery: "Needs rebuilding on this device.",
  diverged: "Balances do not match the network.",
  ready: "",
};

/**
 * What a non-ready private pocket can do about itself, or null when it can do
 * nothing.
 *
 * One table, because two screens offer this and they disagreed: the private
 * asset sheet mapped each state to its own action and to NO button for
 * `unavailable` and `unfunded`, while the Shield/Unshield screen showed one
 * unbranched "Open the private pocket" for all six. Two of those six have no
 * action, so the button was a door back to the same wall.
 *
 * A rebuild is only a real offer where there is an archive to replay from, so
 * the two states whose only route out is a rebuild answer null without one.
 * That is the same read `canRebuild` makes, and it is why the network is a
 * parameter rather than something the caller decides.
 */
export function privateStateAction(
  state: PrivatePocketState,
  network: NetworkId | undefined,
): string | null {
  switch (state) {
    case "unregistered":
      return "Set up";
    case "archived":
      return "Reactivate";
    case "needsRecovery":
    case "diverged":
      return canRebuild(network ?? "testnet") ? "Rebuild" : null;
    default:
      // `unavailable`, `unfunded` and `ready`: nothing this screen can start.
      return null;
  }
}
