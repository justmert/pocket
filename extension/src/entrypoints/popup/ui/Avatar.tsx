// a deterministic mark for an account.
//
// seeded on the stellar address, so the same account always draws the same mark
// and two accounts never collide. that makes it a second signal that the wallet
// is on the account you think it is, next to the address itself.
//
// drawn as inline svg on the device. nothing is fetched, so the mark cannot tell
// anyone which accounts exist, which is the same stance the wallet takes on
// token logos and on img-src in the manifest.
import BoringAvatar from "boring-avatars";
import type { CSSProperties } from "react";

/**
 * the mark's palette, sampled from the theme rather than invented.
 *
 * every value below is already declared in theme.ts, so the mark cannot drift
 * away from the product's colour:
 *
 *   #FED924  accent.public
 *   #F5C400  the low stop of PUBLIC.accentFill
 *   #F0B45C  PRIVATE.exposed
 *   #B8ADE8  accent.private
 *   #A493DD  the low stop of PRIVATE.accentFill
 *   #5FD39A  PRIVATE.positive, a cool counterpoint so two marks stay
 *            distinguishable at 44px rather than reading as one warm smudge
 *
 * it does NOT change with the pocket, deliberately. colour already has a job in
 * this product: the surface flips light and dark to say which pocket you are in.
 * an identity that changed colour when you switched pocket would not be an
 * identity, it would be one more thing saying what the whole screen already
 * says.
 */
const PALETTE = ["#FED924", "#F5C400", "#F0B45C", "#B8ADE8", "#A493DD", "#5FD39A"] as const;

/**
 * `aria-hidden` because it is decorative. the address next to it is the real
 * identity and is already announced; a screen reader describing a generated
 * marble would add noise, not information.
 */
export function Avatar({
  address,
  size = 44,
  /** rounded square instead of a circle, for a card that wants matching corners. */
  square = false,
  style,
}: {
  address: string;
  size?: number;
  square?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 0, ...style }}
    >
      <BoringAvatar
        name={address}
        variant="beam"
        colors={[...PALETTE]}
        size={size}
        square={square}
      />
    </span>
  );
}
