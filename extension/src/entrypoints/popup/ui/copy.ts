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
    ? "Your private balances are opened by keys held only here. They can be rebuilt afterwards by replaying your history from the archive."
    : "Your private balances are opened by keys held only here. Rebuilding them needs a durable archive, and this build has none configured, so they cannot be rebuilt yet.";
}

