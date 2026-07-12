// which private asset a shield / unshield / private send runs against, when more
// than one is configured. the in-form mirror of Send's public asset picker: the
// FAB opens a form on the selected (or primary) asset, and this switches it, so
// every asset is reachable from the compose screen and not only from its row.
//
// selecting sets the provider's `privateAsset`, which is what the form reads back
// through `priv`, so the composer's mark, unit, spendable and price all follow.
import { useWallet } from "../WalletProvider";
import { Sheet } from "../primitives";
import { PrivateAssetRow } from "../screens/Home";

export function PrivateAssetPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const assets = w.privAssets ?? [];
  return (
    <Sheet t={t} open={open} onClose={onClose} title="Choose an asset">
      <div style={{ paddingBottom: 18 }}>
        {assets.map((p, i) => (
          <PrivateAssetRow
            key={p.token ?? p.symbol ?? i}
            t={t}
            p={p}
            index={i}
            // no price here: the picker is a chooser, not a balance screen, so it
            // stays a unit figure rather than firing a market read per asset.
            price={null}
            hidden={w.hidden}
            onClick={() => {
              if (p.token) w.setPrivateAsset(p.token);
              onClose();
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}
