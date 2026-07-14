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
