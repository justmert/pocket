// Decisions about transactions the popup is still watching.
//
// Pure, and in its own module rather than inline in the provider, because the
// popup has no React test environment (vitest runs `environment: "node"` and the
// only other popup test is a lookup table). A rule that decides whether a user
// is told their payment failed should not be reachable only through a browser
// tier, so it is a function with a name and a test.
import type { InFlightRecord } from "./WalletProvider";

/**
 * Whether a transaction the popup recorded as failed is in fact still open.
 *
 * `submitAndConfirm` polls a submission to a terminal outcome. When it never
 * reaches one it reports `pending`, whose authored sentence is "It has not
 * confirmed yet. It may still land, so do not resend." That arrives at the popup
 * as a thrown error exactly like a real failure, and the popup cannot tell them
 * apart from the message alone.
 *
 * The worker can. It clears the durable in-flight record for every terminal
 * outcome and KEEPS it for a pending one (core/chain/submit.ts), so the record
 * still being present is the answer, and it is authoritative in a way that
 * matching on the error's wording would never be.
 *
 * Three conditions, each closing a different way this would be wrong:
 *
 *   the op must still be `failed`, so a result that arrived in the meantime is
 *   not overwritten by a slower answer to this question;
 *
 *   the record must not be `expired`, because past its time bounds the envelope
 *   can never be applied and "it may still land" stops being true;
 *
 *   the hashes must not disagree. Two operations can be in flight at once and
 *   the worker holds ONE record, so without this a failed swap would be
 *   relabelled by an unrelated payment that happens to still be settling. An op
 *   with no hash of its own has nothing to contradict the record with, and a
 *   submission that failed before it was sent has no hash either, which is why
 *   the absence is permitted rather than treated as a mismatch.
 */
export function stillUnresolved(
  op: { status: string; hash?: string },
  held: InFlightRecord | null,
): boolean {
  if (op.status !== "failed") return false;
  if (!held || held.expired) return false;
  return !op.hash || op.hash === held.hash;
}
