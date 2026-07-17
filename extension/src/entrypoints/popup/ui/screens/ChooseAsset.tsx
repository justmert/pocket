// choose asset: search the directory for a classic asset to trust.
//
// a full-frame page. it searches StellarExpert as the user types, shows the
// matches with their domain (so a spoofed code is distinguishable), and opens a
// trustline through the shared approval sheet. it warns when several assets share
// a code, because the code alone is not identity: the issuer is.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Spinner } from "../primitives";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { shortAddress } from "../Address";
import { Search } from "../icons";
import { NETWORKS } from "../../../../core/config";
import { fonts, radius, space, text, type Theme } from "../theme";
import type { AssetSearchResult, TrustlineSummary } from "../../../../core/messages";

export function ChooseAsset({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // the asset being added, and its confirm flow.
  const [adding, setAdding] = useState<AssetSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<TrustlineSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);
  const once = useOnce();
  const opId = useRef<string | null>(null);

  // search as the user types, debounced so a keystroke does not hit the directory.
  useEffect(() => {
    const q = query.trim();
    setSearchError(null);
    if (q === "") {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const id = setTimeout(() => {
      call({ type: "assetSearch", query: q })
        .then((r) => {
          if (live) {
            setResults(r);
            setSearching(false);
          }
        })
        .catch((e) => {
          if (live) {
            setResults([]);
            setSearchError(e instanceof Error ? e.message : String(e));
            setSearching(false);
          }
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [query]);

  const startAdd = async (a: AssetSearchResult) => {
    setAdding(a);
    setError(null);
    try {
      const r = await call({ type: "buildAddTrustline", assetCode: a.code, issuer: a.issuer });
      setHandle(r.handle);
      setSummary(r.summary);
      setConfirming(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAdding(null);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    const id = w.beginOp({
      verb: "Add trustline",
      pocket: "public",
      code: adding?.code ?? "",
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
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
    const done = Boolean(result);
    if (done && opId.current) {
      w.dropOp(opId.current);
      opId.current = null;
    }
    setConfirming(false);
    setResult(null);
    setHandle(null);
    setSummary(null);
    setAdding(null);
    // the sheet's error goes with the sheet. it used to be able to stay set here
    // harmlessly, because the only reader was the sheet that was closing; now the
    // page body draws it too, and a dismissed approve failure would reappear over
    // the results list as though the search had failed.
    setError(null);
    // added: go back to Your assets, which reloads and shows the new asset.
    if (done) onClose();
  };

  // several results sharing a code is the case the domain check exists for.
  const codes = new Set<string>();
  let ambiguous = false;
  for (const r of results ?? []) {
    if (codes.has(r.code)) ambiguous = true;
    codes.add(r.code);
  }

  // which result is trustworthy, and how the user tells them apart. "verified" is
  // either an asset Pocket itself configures (its knownAssets, currently USDC) or
  // one whose issuer published a home domain in the directory. There is no fixed
  // list: on mainnet most legitimate tokens publish a domain; on testnet few do,
  // so there the config-known set carries it. verified assets sort to the top so
  // that among several same-code results the trusted Add is the first one.
  const known = w.status ? (NETWORKS[w.status.network].knownAssets ?? []) : [];
  // TWO different claims, and they were one word.
  //
  // `known` is an asset THIS BUILD configures by code AND issuer, which is the
  // only thing here the wallet can vouch for. `a.domain` is StellarExpert echoing
  // the issuer's own `home_domain`, which is one `set_options` operation away for
  // anybody, including the counterfeit sitting directly above or below in the same
  // list. both wore one solid accent pill at weight 700, so on the exact screen
  // whose job is "the code is not identity: check the domain", both candidates of
  // that judgement carried the loudest mark in the product.
  const isKnown = (a: AssetSearchResult) =>
    known.some((k) => k.code === a.code && k.issuer === a.issuer);
  const isVerified = (a: AssetSearchResult) => Boolean(a.domain) || isKnown(a);
  const shown = results
    ? [...results].sort((a, b) => (isVerified(b) ? 1 : 0) - (isVerified(a) ? 1 : 0))
    : null;

  return (
    <>
      <Frame t={t} className="pocket-page">
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
            <Header t={t} title="Choose asset" onBack={onClose} />
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                background: t.field,
                borderRadius: radius.lg,
                padding: `2px ${space.md}px`,
                marginBottom: space.md,
              }}
            >
              <span aria-hidden style={{ color: t.faint, display: "flex" }}>
                <Search size={18} />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by code or domain"
                aria-label="Search assets"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  flex: 1,
                  minWidth: 0,
                  padding: `${space.md}px 0`,
                  ...text.rowSub,
                  color: t.text,
                }}
              />
              {searching && <Spinner size={16} color={t.accent} />}
            </div>

            {ambiguous && (
              <Notice t={t} tone="exposed">
                Several assets share this code. The code is not identity: check the domain, and add
                the issuer you trust.
              </Notice>
            )}

            {/* what adding actually gets you, said BEFORE the 0.5 XLM reserve is
                spent. `balances()` probes only the assets this build configures
                (`knownAssets`), and `controller.ts` says so in its own words at
                `trustlines()`: "it cannot show an asset the user added by hand".
                so a user could pay a reserve for an asset and then find it absent
                from Home, from its detail sheet and from Send, while the Settings
                row that brought them here promises "Add or remove the assets this
                wallet holds". stated rather than fixed by feeding `trustlines()`
                into the Home list, because `assetMarket` is keyed on the CODE, so
                doing that without changing the price key first would price an
                impostor "USDC" at exactly $1. */}
            <Notice t={t} tone="exposed" bare>
              Adding an asset lets this account receive and hold it. Home and Send currently list
              only the assets Pocket ships for this network; anything else appears here under Your
              assets.
            </Notice>

            {searchError && (
              <Notice t={t} tone="danger">
                {searchError}
              </Notice>
            )}

            {/* a build that fails never opens the sheet, so the sheet cannot carry the
             * message. `error` was passed ONLY to ConfirmSheet, and on this path
             * `setConfirming(true)` is never reached: the throw happens on the awaited
             * `buildAddTrustline`, so the sheet has never mounted and the node that would
             * draw the reason does not exist. pressing Add on an unfunded account was
             * silent, twice, forever. the sibling screen has always drawn the same state
             * as a page-body notice (ManageAssets), which is why this reads as an
             * oversight rather than a decision.
             *
             * gated on `!confirming` so the approve path, which DOES have the sheet open
             * and shows the reason there, does not print it in two places at once. */}
            {!confirming && error && (
              <Notice t={t} tone="danger">
                {error}
              </Notice>
            )}

            {results !== null && results.length === 0 && !searching && !searchError && (
              <div style={{ ...text.body, color: t.sub, textAlign: "center", padding: space.xl }}>
                No assets found for “{query.trim()}”.
              </div>
            )}

            {shown?.map((a) => (
              <ResultRow
                key={`${a.code}:${a.issuer}`}
                t={t}
                asset={a}
                verified={isKnown(a) ? "known" : isVerified(a) ? "domain" : null}
                onAdd={() => void startAdd(a)}
              />
            ))}
          </div>
        </div>
      </Frame>

      <ConfirmSheet
        t={t}
        open={confirming}
        heading={`Add ${adding?.code ?? ""}`}
        code={adding?.code ?? "XLM"}
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

/** one search result: mark, code (+ a verified mark), domain/issuer, and an Add pill. */
function ResultRow({
  t,
  asset,
  verified,
  onAdd,
}: {
  t: Theme;
  asset: AssetSearchResult;
  /** `known` is configured by this build, code AND issuer. `domain` is only that
   *  the issuer published a home domain, which anyone can do. */
  verified: "known" | "domain" | null;
  onAdd: () => void;
}) {
  // anchored to the END of the domain, the same layout-effect the approval
  // screen's `OriginBlock` uses and for the same reason: a name cut at the right
  // hides the part that identifies it, and the paint that follows must already be
  // anchored or the misleading prefix is on screen for a frame.
  const domainBox = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = domainBox.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [asset.domain]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.sm}px 0`,
        minWidth: 0,
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
        <AssetMark t={t} id={`${asset.code}:${asset.issuer}`} code={asset.code} />
      </span>
      <span style={{ flex: "1 1 60px", minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ ...text.rowTitle, color: t.text }}>{asset.code}</span>
          {/* the solid accent pill is kept for the ONE claim the wallet can make
              on its own: an asset this build configures by code and issuer. the
              weaker fact, that the issuer published a home domain, gets a quiet
              neutral chip that says what it actually means, because setting a
              home domain is one operation and a counterfeit in the same list can
              do it too. one word covering both was the defect: the loudest mark
              in the product sat on both candidates of the identity judgement this
              screen exists to help the user make. */}
          {verified === "known" && (
            <span
              style={{
                ...text.caption,
                fontWeight: 700,
                padding: "3px 8px",
                borderRadius: radius.pill,
                background: t.accentFill,
                color: t.onAccent,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
              title="Pocket ships this asset's issuer address"
            >
              Known to Pocket
            </span>
          )}
          {verified === "domain" && (
            <span
              style={{
                ...text.caption,
                fontWeight: 600,
                padding: "3px 8px",
                borderRadius: radius.pill,
                background: t.field,
                color: t.sub,
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
            >
              Domain listed
            </span>
          )}
        </span>
        {/* the domain is the one identity string on this row, and it was being
            cut at the RIGHT, which is the end that identifies the site: with an
            ellipsis, `circle.com.attacker.example` and `circle.com...` read the
            same. it scrolls instead, anchored to its end, the treatment
            `OriginBlock` already uses on the approval screen. deliberately NOT
            allowed to wrap: a wrap point chosen by whoever picked the domain is
            what D16 forbids. */}
        <span
          ref={domainBox}
          style={{
            ...text.rowSub,
            color: t.sub,
            display: "block",
            fontFamily: asset.domain ? undefined : fonts.mono,
            overflowX: "auto",
            whiteSpace: "nowrap",
          }}
        >
          {asset.domain || shortAddress(asset.issuer)}
        </span>
      </span>
      <Button t={t} size="pill" variant="soft" onClick={onAdd}>
        Add
      </Button>
    </div>
  );
}
