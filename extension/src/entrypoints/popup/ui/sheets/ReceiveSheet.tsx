import { useWallet } from "../WalletProvider";
import { Button, ButtonStack, Notice, Sheet, Skeleton } from "../primitives";
import { Qr } from "../Qr";
import { fontSizes, fonts, radius, space } from "../theme";

// the QR and the address share ONE width, so they line up edge to edge. at this
// width the 56-character address wraps to two full lines of 28 in DM Mono, so it
// fills its box exactly rather than leaving a ragged tail.
const W = 256;

// Qr draws its own light card with 12px of padding on every side (Qr.tsx), so a
// svg of W would overhang the W-wide address panel by 12px each side. sizing the
// svg to W - 24 makes the padded card total exactly W and the edges truly meet.
const QR_SVG = W - 24;

export function ReceiveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const address = w.status?.address;

  // The assets this account can actually hold, read off what the worker
  // reported. XLM is native and needs no trustline, so it is always there;
  // every other entry IS a trustline, because `balances()` omits an asset that
  // has none. Null while the read is still out: "we do not know yet" must not
  // render as "only XLM", which is a claim.
  const receivable = w.balances === null ? null : listOf(w.balances.map((b) => b.code));

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Receive">
      {/* the QR, the address and the copy button all live in ONE W-wide column,
          centred as a group, so they line up edge to edge by construction rather
          than each being centred on its own and drifting apart. no explanatory
          sentence: the wallet has one address. */}
      <div style={{ width: W, maxWidth: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: space.md }}>
          {address ? (
            <Qr value={address} size={QR_SVG} />
          ) : (
            // match the QR card's corner so the placeholder does not visibly change
            // shape when the code lands.
            <Skeleton width={W} height={W} radius={radius.lg} />
          )}
        </div>

        {address ? (
          <>
            <div
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: t.field,
                borderRadius: radius.md,
                padding: space.sm,
              }}
            >
              <span
                style={{
                  display: "block",
                  fontFamily: fonts.mono,
                  fontSize: fontSizes.small,
                  fontWeight: 500,
                  lineHeight: 1.7,
                  color: t.text,
                  wordBreak: "break-all",
                }}
              >
                {address}
              </span>
            </div>
            {/* opened from the private pocket, this sheet is teal on near-black,
                titled "Receive", and said nothing: scan the QR from an exchange
                and the money arrives in the PUBLIC pocket. every other private
                surface carries the statement (Send's tip, Move's tip, the private
                prompt's tip, the worker's own register text) and the one
                destination surface did not. the existing comment justifies having
                no prose because "the wallet has one address", which answers a
                different question than the one someone asks in the private
                pocket, which is whether money sent here arrives hidden. */}
            {w.pocket === "private" && (
              <div style={{ marginTop: space.sm }}>
                <Notice t={t} tone="exposed" bare>
                  This is your public address. Payments to it arrive in the public pocket, visible
                  on the ledger. Move them across afterwards to hide the amounts.
                </Notice>
              </div>
            )}

            {/* which ledger this address is on. a stellar address is valid on
                both networks and looks identical on each, so an address handed
                out with nothing naming the network is the one place this wallet
                could cause a real loss on a testnet-only build: funds sent from
                mainnet to it are simply gone. it disappears on mainnet. */}
            {w.status && w.status.network !== "mainnet" && (
              <div style={{ marginTop: space.sm }}>
                <Notice t={t} tone="exposed" bare>
                  This is a testnet address. Only send testnet assets to it.
                </Notice>
              </div>
            )}
            {/* WHAT can arrive here, which is not the same question as where.
                a Stellar account can only hold an asset it has a trustline for,
                and a payment in anything else is rejected by the network with
                `op_no_trust`: the sender loses the fee, the money never moves,
                and the recipient is told nothing at all because no payment
                happened. the wallet knew this and could not say it, because
                `balances()` OMITS an asset with no trustline rather than
                showing it at zero, so a fresh account has no USDC row anywhere
                and no cue that USDC cannot arrive.

                stated as what CAN arrive rather than as a list of what cannot,
                because the second list is every asset on Stellar. */}
            {receivable !== null && (
              <div style={{ marginTop: space.sm }}>
                <Notice t={t} bare>
                  {`This address can receive ${receivable}. Anything else has to be added first, ` +
                    `in Settings, Your assets, or the payment is rejected by the network and ` +
                    `nothing arrives.`}
                </Notice>
              </div>
            )}

            <ButtonStack>
              <Button t={t} onClick={() => w.copy(address)}>
                {w.copied ? "Copied" : "Copy address"}
              </Button>
            </ButtonStack>
          </>
        ) : (
          <Notice t={t} tone="danger">
            Pocket has no address for this wallet yet. Reopen it to try again.
          </Notice>
        )}
      </div>
    </Sheet>
  );
}

/** "XLM", "XLM and USDC", "XLM, USDC and EURC". Plain English, not a CSV. */
function listOf(codes: string[]): string {
  const seen = [...new Set(codes)];
  if (seen.length <= 1) return seen[0] ?? "nothing yet";
  return `${seen.slice(0, -1).join(", ")} and ${seen[seen.length - 1]}`;
}
