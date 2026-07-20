// manage assets: the trustlines this account holds.
//
// a full-frame page like send. it lists every classic asset the account trusts
// (read from Horizon, not just the configured ones), lets the user open a new
// trustline via the directory search, and close one it no longer wants. XLM is
// not shown: it is always held and has no trustline to manage.
import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Skeleton } from "../primitives";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { Amount } from "../Amount";
import { shortAddress } from "../Address";
import { Trash } from "../icons";
import { ROW_STAGGER_MS, space, text, type Theme } from "../theme";
import type { Trustline, TrustlineSummary } from "../../../../core/messages";

export function ManageAssets({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;

  const [lines, setLines] = useState<Trustline[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);

  // the asset being removed, and the confirm flow for it.
  const [removing, setRemoving] = useState<Trustline | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<TrustlineSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const once = useOnce();
  const opId = useRef<string | null>(null);

  const load = () => {
    setError(null);
    call({ type: "trustlines" })
      .then((r) => setLines(r))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  // reload on mount: this screen remounts whenever the add/search route above it
  // pops, so a freshly added asset shows without any extra wiring.
  useEffect(load, []);

  const startRemove = async (tl: Trustline) => {
    setRemoving(tl);
    setError(null);
    try {
      const r = await call({ type: "buildRemoveTrustline", assetCode: tl.code, issuer: tl.issuer });
      setHandle(r.handle);
      setSummary(r.summary);
      setConfirming(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(null);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    const id = w.beginOp({
      verb: "Remove trustline",
      pocket: "public",
      code: removing?.code ?? "",
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      // a remove is a staged "trustline" tx, so it confirms through the same path.
      const r = await call({ type: "confirmAddTrustline", handle });
      w.completeOp(id, { hash: r.hash, ledger: r.ledger });
      setResult({ hash: r.hash, ledger: r.ledger });
      setBusy(false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setError(reason);
      setBusy(false);
      // ask the worker what this actually was BEFORE re-arming Approve. an
      // `unresolved` submission is one the worker still holds a durable in-flight
      // record for, so it may yet land, and the reason being shown is the wallet's
      // own "do not resend": releasing the one-shot guard under it is what turns a
      // stuck payment into a double spend. the guard stays claimed until then, so
      // a press in the gap does nothing.
      if ((await w.failOp(id, reason)) === "unresolved") setUnresolved(true);
      else once.release();
    }
  };

  const closeConfirm = () => {
    if (busy) return;
    once.release();
    if (result && opId.current) {
      w.dropOp(opId.current);
      opId.current = null;
    }
    const done = Boolean(result);
    setConfirming(false);
    setResult(null);
    setHandle(null);
    setSummary(null);
    setRemoving(null);
    if (done) load(); // the trustline is gone; refresh the list
  };

  return (
    <>
      <Frame t={t} className="pocket-page">
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
            <Header t={t} title="Your assets" onBack={onClose} />
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowX: "hidden",
              overflowY: "auto",
              padding: `0 ${space.gutter}px`,
            }}
          >
            {/* the error told the user to try again and gave them nothing to
                press: this screen loads once on mount, so "try again" meant
                leaving and coming back. */}
            {error && (
              <>
                <Notice t={t} tone="danger">
                  {error}
                </Notice>
                <div style={{ marginTop: space.sm }}>
                  <Button t={t} variant="quiet" size="pill" onClick={load}>
                    Try again
                  </Button>
                </div>
              </>
            )}

            {lines === null && !error && (
              <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <Skeleton width="100%" height={52} radius={14} />
                <Skeleton width="100%" height={52} radius={14} />
              </div>
            )}

            {lines !== null && lines.length === 0 && !error && (
              <div
                style={{
                  ...text.body,
                  color: t.sub,
                  textAlign: "center",
                  lineHeight: 1.5,
                  padding: `${space.xl}px ${space.md}px`,
                }}
              >
                You have no assets added. Get started by adding an asset.
              </div>
            )}

            {lines?.map((tl, i) => (
              <AssetLine
                key={`${tl.code}:${tl.issuer}`}
                t={t}
                index={i}
                tl={tl}
                onRemove={() => void startRemove(tl)}
              />
            ))}
          </div>

          <div
            style={{ padding: `${space.md}px ${space.gutter}px ${space.lg}px`, background: t.bg }}
          >
            <Button t={t} onClick={() => w.openSheet("chooseAsset")}>
              Add an asset
            </Button>
          </div>
        </div>
      </Frame>

      <ConfirmSheet
        t={t}
        open={confirming}
        heading={`Remove ${removing?.code ?? ""}`}
        code={removing?.code ?? "XLM"}
        fee={summary?.fee}
        // the reserve is the largest number in this transaction by five orders of
        // magnitude (0.5 XLM against a fee around 0.00001) and it was stated only
        // inside the effects list, behind a tap. it is locked, not spent, and the
        // row says which.
        facts={[{ label: "Reserve locked", value: "0.5 XLM, released if removed" }]}
        effects={summary?.effects ?? []}
        error={error}
        unresolved={unresolved}
        busy={busy}
        result={result}
        network={w.status?.network}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={w.goHome}
      />
    </>
  );
}

/** one trusted asset: its mark, code, issuer, balance, and a remove control. */
function AssetLine({
  t,
  index,
  tl,
  onRemove,
}: {
  t: Theme;
  index: number;
  tl: Trustline;
  onRemove: () => void;
}) {
  return (
    <div
      className="pocket-row-in"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.sm}px 0`,
        minWidth: 0,
        animationDelay: `${index * ROW_STAGGER_MS}ms`,
      }}
    >
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 14,
          border: `1px solid ${t.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          overflow: "hidden",
        }}
      >
        <AssetMark t={t} id={`${tl.code}:${tl.issuer}`} code={tl.code} />
      </span>
      <span style={{ flex: "1 1 60px", minWidth: 0 }}>
        <span style={{ ...text.rowTitle, color: t.text, display: "block" }}>{tl.code}</span>
        <span style={{ ...text.rowSub, color: t.sub, display: "block" }}>
          {shortAddress(tl.issuer)}
        </span>
      </span>
      <span style={{ textAlign: "right", minWidth: 0 }}>
        <span style={{ display: "block" }}>
          <Amount t={t} value={tl.balance} />
        </span>
        {!tl.authorized && (
          <span style={{ ...text.rowSub, color: t.sub, display: "block" }}>Not authorised</span>
        )}
      </span>
      <RemoveButton t={t} code={tl.code} onClick={onRemove} />
    </div>
  );
}

/** the per-row close-trustline control, a quiet destructive icon button. */
function RemoveButton({ t, code, onClick }: { t: Theme; code: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${code}`}
      onClick={onClick}
      className="pk-tap"
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: 34,
        height: 34,
        borderRadius: "50%",
        background: t.dangerSoft,
        color: t.danger,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
      }}
    >
      <Trash size={16} />
    </button>
  );
}
