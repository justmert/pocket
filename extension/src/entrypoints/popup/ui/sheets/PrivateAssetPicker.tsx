// which private asset a shield / unshield / private send runs against, when more
// than one is configured. the in-form mirror of Send's public asset picker: the
// FAB opens a form on the selected (or primary) asset, and this switches it, so
// every asset is reachable from the compose screen and not only from its row.
//
// selecting calls `onPick`, which the FORM keeps in its own local state: there is
// no global selection, so switching the asset here never changes the home or the
// next form, only this one.
import { useWallet } from "../WalletProvider";
import { Sheet } from "../primitives";
import { PrivateAssetRow } from "../screens/Home";

export function PrivateAssetPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** the tapped asset's wrapper token; the caller holds its own selection. */
  onPick: (token: string) => void;
}) {
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
              if (p.token) onPick(p.token);
              onClose();
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}
