import { useWallet } from "../WalletProvider";
import { AddressBlock } from "../Address";
import { Button, ButtonStack, Notice, Sheet, Skeleton } from "../primitives";
import { Qr } from "../Qr";
import { space, text } from "../theme";

export function ReceiveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const address = w.status?.address;

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Receive">
      {/* the QR is the point of this sheet, so it gets the room; the address is
          a smaller line beneath it. no explanatory sentence: the wallet has one
          address and the QR is it. */}
      <div style={{ textAlign: "center", marginBottom: space.lg }}>
        {address ? <Qr t={t} value={address} size={288} /> : <Skeleton width={288} height={288} />}
      </div>

      {address ? (
        <>
          <div style={{ ...text.caption, color: t.faint, textAlign: "center", marginBottom: space.xs }}>
            Your address
          </div>
          <AddressBlock t={t} address={address} onCopy={w.copy} copied={w.copied} />
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
    </Sheet>
  );
}
