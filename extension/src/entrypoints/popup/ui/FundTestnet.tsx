// testnet-only account funding, from friendbot.
//
// a freshly onboarded wallet exists only on this device until an account is
// created on the ledger with a starting XLM balance. on testnet that balance
// comes from friendbot, a free faucet; on mainnet there is no faucet, so the
// worker refuses and every caller here gates on `network === "testnet"`. the
// worker does the funding AND waits for the created account to read back, so a
// successful return means the next balance read finds the funds rather than the
// account still looking empty for a beat.
import { useCallback, useState } from "react";
import { call } from "./rpc";
import { message, useWallet } from "./WalletProvider";
import { Button, Card, IconDisc, Notice } from "./primitives";
import { Coins } from "./icons";
import { space, text, type Theme } from "./theme";

/**
 * fund the account from friendbot, once. resolves to null on success or the
 * safe error sentence on failure, so a caller can toast it; the same sentence is
 * also held in `error` for a caller that shows it inline. `funding` gates the
 * button and blocks a second press mid-flight.
 */
export function useFundTestnet() {
  const w = useWallet();
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fund = useCallback(async (): Promise<string | null> => {
    setFunding(true);
    setError(null);
    try {
      await call({ type: "fundTestnet" });
      // the worker has already waited for the account to exist; this read finds it.
      await w.refresh();
      return null;
    } catch (e) {
      const m = message(e);
      setError(m);
      return m;
    } finally {
      setFunding(false);
    }
  }, [w]);
  return { fund, funding, error };
}

/**
 * the home prompt a freshly onboarded, unfunded account shows: the account holds
 * no XLM yet, and on testnet one press gets some. it disappears on its own once
 * the funds land, because the caller only renders it while the account reads as
 * unfunded.
 */
export function FundTestnetCard({ t }: { t: Theme }) {
  const { fund, funding, error } = useFundTestnet();
  return (
    <Card t={t} tone="accent">
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <IconDisc t={t} size={32}>
          <Coins size={18} />
        </IconDisc>
        <span style={{ flex: "1 1 auto", minWidth: 0 }}>
          <span style={{ ...text.rowTitle, color: t.text, display: "block" }}>
            Fund this account
          </span>
          <span style={{ ...text.caption, color: t.sub, display: "block" }}>
            It holds no XLM yet. Get free testnet XLM to start.
          </span>
        </span>
        <Button
          t={t}
          variant="quiet"
          size="pill"
          onClick={() => void fund()}
          busy={funding}
          disabled={funding}
        >
          {funding ? "Funding" : "Get XLM"}
        </Button>
      </div>
      {error && (
        <div style={{ marginTop: space.sm }}>
          <Notice t={t} tone="danger" bare>
            {error}
          </Notice>
        </div>
      )}
    </Card>
  );
}
