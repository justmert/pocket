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
      <div style={{ textAlign: "center", marginBottom: space.gutter }}>
        {address ? <Qr t={t} value={address} /> : <Skeleton width={238} height={238} />}
      </div>

      <div style={{ ...text.body, color: t.sub, textAlign: "center", marginBottom: space.md }}>
        One address for both pockets.
      </div>

      {address ? (
        <>
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
