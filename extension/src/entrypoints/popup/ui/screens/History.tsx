// the activity screen: one pocket's movements, newest first.
//
// the data contract is fixed (core/messages.ts `HistoryEntry`/`HistoryPage`,
// fetched through `call({ type: "history" })`); this file only reads and draws
// it. it asks for the CURRENT pocket only, so public and private never mix, and
// so viewing the public pocket never pays for the private archive replay. pages
// come newest-first and each next page is strictly older, so appending preserves
// order and nothing is re-sorted here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import { message, useWallet, type BgOp } from "../WalletProvider";
import { call } from "../rpc";
import { capDecimals, displayAmount } from "../../../../core/chain/balances";
import { AssetMark } from "./Home";
import { Avatar } from "../Avatar";
import {
  Button,
  Header,
  ScrollArea,
  Skeleton,
  Sheet,
  Notice,
  Overline,
  Spinner,
  useRetained,
} from "../primitives";
import {
  Alert,
  ArrowDown,
  ArrowUp,
  Calendar,
  Check,
  ChevronRight,
  Clock,
  External,
  Filter,
  Search,
} from "../icons";
import { usd } from "../money";
import { periodLabel } from "../period";
import { explorerUrl } from "../explorer";
import { shortAddress } from "../Address";
import { opToEntry } from "../opEntry";
import { NAV_SPACE } from "../BottomNav";
import {
  DateRangeSheet,
  TypeFilterSheet,
  categoryOf,
  type DateRange,
  type FilterCategory,
} from "./HistoryFilters";
import { fonts, radius, ROW_STAGGER_MS, space, text, type Theme } from "../theme";
import type { HistoryEntry } from "../../../../core/messages";

const PAGE = 30;
/** How many pages a filter that matches nothing will pull before it stops. */
const MAX_AUTO_PAGES = 20;

/**
 * the canonical asset id the logo lookup wants.
 *
 * `tokenIcons` is keyed "native" | "CODE:ISSUER", and this used to hand it a
 * bare code, so every credit asset missed and fell back to the grey monogram:
 * the same token drew Circle's mark on the home screen and a letter in the
 * history beside it. The issuer now rides on the entry, so the key can be built.
 * An entry without one still misses, which is the right answer rather than a
 * guess at which issuer was meant.
 */
function assetId(e: Pick<HistoryEntry, "code" | "issuer">): string {
  if (e.code === "XLM") return "native";
  return e.issuer ? `${e.code}:${e.issuer}` : e.code;
}

/** the sentence under the code, in the wallet's own words. */
function entryLine(e: HistoryEntry): string {
  const who = e.counterparty ? short(e.counterparty) : "";
  // A movement with no counterparty and no direction out of this account is one
  // the user made to themselves, and the wallet neither blocks it nor refuses
  // it. Named here, because the sentences below all end in a party: without
  // this a self-transfer read "Sent privately to " with nothing after it, and
  // the detail sheet showed no counterparty row to explain the gap.
  if (e.direction === "self" && !e.counterparty) {
    switch (e.kind) {
      case "privateSend":
        return "Sent privately to yourself";
      case "send":
        return "Sent to yourself";
      case "receive":
        return "Received from yourself";
      default:
        break;
    }
  }
  switch (e.kind) {
    case "receive":
      return `Received from ${who}`;
    case "send":
      return `Sent to ${who}`;
    // Both legs of a swap say the same word, because they are one event. The
    // row already carries the asset, the amount and the direction badge, so
    // repeating "to" or "from" here would name a router contract the user did
    // not choose and does not think of as a counterparty.
    case "swap":
      return "Swapped";
    case "create":
      return "Account funded";
    case "shield":
      return "Shielded";
    case "unshield":
      return "Unshielded";
    case "privateReceive":
      return `Received privately from ${who}`;
    case "privateSend":
      return `Sent privately to ${who}`;
    case "makeSpendable":
      return "Made spendable";
    case "setup":
      return "Private pocket opened";
    default:
      return "";
  }
}

/**
 * The one shortening in the product, imported rather than written again.
 *
 * This file had its own at four characters each end while ui/Address.tsx does
 * six, and Send has a third at six-and-four, so one address printed three ways
 * depending on which screen showed it. Four-and-four is also the form the
 * project's own threat notes call about an hour of brute force to collide, and
 * it was the form beside a completed send's recipient.
 */
const short = shortAddress;

/**
 * Whether an address is one this wallet's explorer and shortener understand.
 *
 * Stellar keys are 56-character base32 beginning G (account), C (contract) or M
 * (muxed). A CCTP bridge records a 0x EVM address as its recipient, and every
 * Stellar-shaped assumption applied to it produces something wrong rather than
 * something missing.
 */
function isStellarAddress(a: string): boolean {
  return /^[GCM][A-Z2-7]{55}$/.test(a);
}



/** a full date and time, for the detail. */
function fullDate(at: number): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** a done watched op drawn as the settled row it is about to become, so a completed
 *  transaction looks completed at once instead of lingering as a processing card
 *  until the indexer catches up. reconciled away by hash the moment the real entry
 *  lands, so it is a stand-in, never a second copy. */
export function History() {
  const w = useWallet();
  const t = w.t;
  const pocket = w.pocket;
  const privateAvailable = w.status?.privateAvailable === true;

  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange>({ start: null, end: null });
  const [types, setTypes] = useState<Set<FilterCategory>>(new Set());
  const [showDate, setShowDate] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  // a processing op whose detail sheet is open.
  const [openOp, setOpenOp] = useState<BgOp | null>(null);
  const loadingRef = useRef(false);
  // bumped whenever the pocket changes; a response from the pocket we just left
  // is dropped rather than shown under the new one.
  const gen = useRef(0);

  // one loader for two callers: the pocket switch clears to skeletons, the
  // reconcile poll keeps the list on screen and only refreshes it underneath. the
  // private archive replay only runs for the private pocket, so Public is cheap.
  const reload = useCallback(
    (clear: boolean) => {
      const myGen = ++gen.current;
      if (clear) {
        setEntries(null);
        setCursor(undefined);
      }
      setError(null);
      loadingRef.current = true;
      call({ type: "history", limit: PAGE, pocket })
        .then((p) => {
          if (myGen !== gen.current) return;
          if (clear) {
            setEntries(p.entries);
            setCursor(p.cursor);
            return;
          }
          // A REFRESH, not a reload. This path is the reconcile poll, which runs
          // every 2.5s for up to 50s after any transaction, and it used to do
          // exactly what the clearing path does: replace the list with the
          // newest 30 rows and reset the cursor with them. Every page the user
          // had scrolled in was discarded underneath them, repeatedly, and the
          // cursor reset meant scrolling back down re-fetched the same pages.
          //
          // So the newest page is MERGED into what is already loaded, keyed by
          // id, and the cursor is left alone because it still describes the
          // oldest row on screen. Ordering is restored by the sort the render
          // already applies.
          setEntries((prev) => {
            if (!prev) return p.entries;
            const known = new Set(prev.map((e) => e.id));
            const fresh = p.entries.filter((e) => !known.has(e.id));
            return fresh.length === 0 ? prev : [...fresh, ...prev];
          });
        })
        .catch((e) => {
          if (myGen !== gen.current) return;
          // a poll failing keeps what is on screen; only a fresh load surfaces it.
          if (clear) setError(message(e));
        })
        .finally(() => {
          if (myGen === gen.current) loadingRef.current = false;
        });
    },
    [pocket],
  );

  // (re)load from the top whenever the pocket changes.
  useEffect(() => {
    setSelected(null);
    reload(true);
  }, [reload]);

  const loadMore = () => {
    if (loadingRef.current || cursor == null) return;
    const myGen = gen.current;
    loadingRef.current = true;
    setLoadingMore(true);
    call({ type: "history", cursor, limit: PAGE, pocket })
      .then((p) => {
        if (myGen !== gen.current) return;
        setEntries((prev) => [...(prev ?? []), ...p.entries]);
        setCursor(p.cursor);
      })
      .catch(() => {
        // keep what is on screen; a later scroll retries.
      })
      .finally(() => {
        if (myGen === gen.current) {
          loadingRef.current = false;
          setLoadingMore(false);
        }
      });
  };

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // within one screen of the bottom, pull the next (older) page in.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) loadMore();
  };

  const q = query.trim().toLowerCase();

  // the transactions this popup is still watching, for the pocket in view. a DONE
  // op is not one of them: it is drawn as a settled row (below), the same shape a
  // completed transaction always has, so it does not linger as a processing card.
  // only the still-running and the failed sit under "In progress".
  const inProgress = w.backgroundOps.filter((o) => o.pocket === pocket && o.status !== "done");
  const doneOps = w.backgroundOps.filter((o) => o.pocket === pocket && o.status === "done");

  // a done op the fetched history has not caught up to yet is drawn as a settled
  // row from the record we already hold, so a completed transaction looks completed
  // AT ONCE rather than sitting as a "Completed" card until the indexer shows it.
  // when the real entry lands, the reconcile below drops the op, and the two never
  // both show because the synthetic row is filtered out once its hash is present.
  const landedHashes = new Set((entries ?? []).map((e) => e.hash));
  const syntheticDone = doneOps
    .filter((o) => o.hash && !landedHashes.has(o.hash))
    .map(opToEntry)
    .filter((e): e is HistoryEntry => e !== null);

  // search, date and type are all filters over what is LOADED: the contract has no
  // server-side filter, so these narrow the stream in hand (infinite scroll keeps
  // pulling older pages under them). the synthetic settled rows go through the same
  // predicate, so a filter hides them exactly as it hides a real settled row.
  const match = (e: HistoryEntry): boolean => {
    // the pocket guard, enforced HERE as well as in the worker: each entry carries
    // its pocket, and Activity shows only the one you are viewing.
    if (e.pocket !== pocket) return false;
    if (
      q &&
      !e.code.toLowerCase().includes(q) &&
      !(e.counterparty ?? "").toLowerCase().includes(q) &&
      !(e.amount ?? "").includes(q)
    )
      return false;
    if (range.start !== null && e.at < range.start) return false;
    if (range.end !== null && e.at > range.end) return false;
    if (types.size > 0) {
      const c = categoryOf(e);
      if (!c || !types.has(c)) return false;
    }
    return true;
  };
  // newest first: the just-completed synthetic rows sort in among the fetched
  // history by time, so they land at the top under "Today" like any settled row.
  const shown = [...syntheticDone, ...(entries ?? [])].filter(match).sort((a, b) => b.at - a.at);

  const filtersActive = range.start !== null || types.size > 0;
  // captured per render so day-relative headings ("Today", "Yesterday") stay
  // correct even if the popup is left open across a midnight boundary.
  const now = Date.now();

  // the chain is the record; this watch list is not. the moment a completed op's
  // hash shows up in the fetched history, retire the op: the real settled row now
  // stands in for the synthetic one, and keeping both would show it twice.
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    const landed = new Set(entries.map((e) => e.hash));
    for (const op of w.backgroundOps) {
      if (op.hash && landed.has(op.hash)) w.dropOp(op.id);
    }
  }, [entries, w.backgroundOps, w.dropOp]);

  // A filter hides everything loaded, and older pages remain.
  //
  // The list below says "Nothing matches those filters", which is a claim about
  // the account's whole history, and the filters only narrow what has been
  // fetched. Normally the scroll handler pulls the rest, but an EMPTY list has
  // nothing to scroll, so the one thing that could have disproved the sentence
  // could never run: the wallet asserted a user had never shielded anything
  // while the shield sat one unfetched page away.
  //
  // Bounded like the reconcile poll beside it, so a filter that genuinely
  // matches nothing walks the stream once and stops rather than paging forever.
  const autoPages = useRef(0);
  useEffect(() => {
    if (!filtersActive && !q) {
      autoPages.current = 0;
      return;
    }
    if (shown.length > 0 || cursor == null || loadingRef.current) return;
    if (autoPages.current >= MAX_AUTO_PAGES) return;
    autoPages.current += 1;
    loadMore();
  });

  // a done op not yet in history means the ledger has it but our last fetch
  // predated it. poll the top page until it lands (then the reconcile above drops
  // it and this stops), bounded so an indexer that never shows it does not spin.
  const awaitingReconcile = doneOps.length > 0;
  useEffect(() => {
    if (!awaitingReconcile) return;
    let tries = 0;
    const id = setInterval(() => {
      if (++tries > 20) {
        clearInterval(id);
        return;
      }
      reload(false);
    }, 2500);
    return () => clearInterval(id);
  }, [awaitingReconcile, reload]);

  // keep the open detail sheet in step with its op as it flips processing -> done
  // (or -> failed): the sheet holds a snapshot, so re-point it at the live record.
  const liveOpenOp = openOp ? (w.backgroundOps.find((o) => o.id === openOp.id) ?? null) : null;

  return (
    <>
      <ScrollArea className="pocket-page" background={t.canvas} onScroll={onScroll}>
        {/* the top section is PINNED, the way Home pins its header: the hue, the
            title, the pocket toggle and the search/filter row never leave, and only
            the list scrolls beneath them. an earlier build painted the hue as a fixed
            plate behind a body that scrolled in full, but "the top hue" the user
            means is the whole band, controls and all, so the band itself is what has
            to stay. the block wears the canvas (its hue gradient) as an OPAQUE fill,
            anchored at the frame's top, so rows passing under it are hidden rather
            than bleeding through. */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 5,
            background: t.canvas,
            padding: `${space.gutter}px ${space.gutter}px ${space.md}px`,
          }}
        >
          <Header t={t} title="Activity" />

          {/* the two pockets keep separate histories; the toggle is how you cross
            between them, and it flips the whole surface with the pocket. */}
          {privateAvailable && (
            <div
              role="group"
              aria-label="Pocket"
              style={{
                display: "flex",
                gap: 4,
                background: t.field,
                borderRadius: radius.pill,
                padding: 4,
                marginBottom: space.md,
              }}
            >
              {(["public", "private"] as const).map((p) => {
                const on = pocket === p;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on}
                    onClick={() => w.setPocket(p)}
                    className="pk-tap"
                    style={{
                      all: "unset",
                      boxSizing: "border-box",
                      flex: 1,
                      textAlign: "center",
                      cursor: "pointer",
                      padding: "8px 0",
                      borderRadius: radius.pill,
                      background: on ? t.accent : "transparent",
                      color: on ? t.onAccent : t.sub,
                      ...text.pocketTab,
                    }}
                  >
                    {p === "public" ? "Public" : "Private"}
                  </button>
                );
              })}
            </div>
          )}

          {/* search + the two filter openers narrow the loaded stream. no bottom
              margin: this is the last row of the pinned block, and the block's own
              padding sets the gap to the list below. */}
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <div
              className="pk-field"
              style={{
                flex: 1,
                minWidth: 0,
                // matches the 42px filter buttons beside it so the row reads level.
                boxSizing: "border-box",
                minHeight: 42,
                display: "flex",
                alignItems: "center",
                background: t.field,
                borderRadius: radius.pill,
                padding: `10px ${space.md}px`,
                gap: space.sm,
              }}
            >
              {/* a leading magnifier, so the search field carries an icon like the
                  two filter buttons beside it rather than reading as a bare pill. */}
              <span aria-hidden style={{ color: t.sub, display: "flex", flex: "0 0 auto" }}>
                <Search size={18} />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search activity by address, token, or amount"
                spellCheck={false}
                autoComplete="off"
                style={{ all: "unset", flex: 1, minWidth: 0, ...text.body, color: t.text }}
              />
            </div>
            <FilterButton
              t={t}
              label="Date range"
              active={range.start !== null}
              onClick={() => setShowDate(true)}
            >
              <Calendar size={20} />
            </FilterButton>
            <FilterButton
              t={t}
              label="Filters"
              active={types.size > 0}
              onClick={() => setShowFilter(true)}
            >
              <Filter size={20} />
            </FilterButton>
          </div>
        </div>

        {/* the scrolling body: the list slides up under the pinned block above. the
            transactions this popup is still watching sit at the very top, under an
            "In progress" heading, in the same one list as the settled history; a
            watched row keeps its live shape until its hash lands in history, when it
            reconciles into a normal settled row below. no tabs: one list, newest
            first, the in-progress ones being the newest of all. */}
        <div style={{ padding: `0 ${space.gutter}px ${NAV_SPACE}px` }}>
          {error ? (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          ) : entries === null ? (
            <div style={{ display: "grid", gap: space.md }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} width="100%" height={52} />
              ))}
            </div>
          ) : (
            <>
              {inProgress.length > 0 && (
                <div style={{ marginBottom: shown.length > 0 ? space.lg : 0 }}>
                  <Overline t={t}>In progress</Overline>
                  <div style={{ display: "grid", gap: space.sm }}>
                    {inProgress.map((op, i) => (
                      <ProcessingRow
                        key={op.id}
                        t={t}
                        op={op}
                        index={i}
                        onClick={() => setOpenOp(op)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {shown.length > 0 && <List t={t} entries={shown} now={now} onOpen={setSelected} />}

              {shown.length === 0 && (q || filtersActive) && (
                // filters hid the settled history: a filter glyph says why, and one
                // tap clears them. the in-progress list above is not filtered.
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: space.md,
                    paddingTop: space.xl,
                    textAlign: "center",
                  }}
                >
                  <span aria-hidden style={{ color: t.faint, display: "flex" }}>
                    <Filter size={28} />
                  </span>
                  <span style={{ ...text.body, color: t.faint }}>
                    {cursor == null
                      ? "Nothing matches those filters."
                      : "Nothing matches those filters yet. Still reading older history."}
                  </span>
                  <Button
                    t={t}
                    variant="quiet"
                    size="pill"
                    onClick={() => {
                      setQuery("");
                      setRange({ start: null, end: null });
                      setTypes(new Set());
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}

              {shown.length === 0 && !q && !filtersActive && inProgress.length === 0 && (
                // a warm anchor rather than a bare line, since this is often the
                // first-run screen of a brand-new wallet.
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: space.md,
                    paddingTop: space.xl,
                    textAlign: "center",
                  }}
                >
                  <Avatar t={t} size={64} />
                  <span style={{ ...text.body, color: t.faint }}>
                    No activity yet. Your transactions will appear here.
                  </span>
                </div>
              )}
            </>
          )}

          {loadingMore && (
            <div style={{ paddingTop: space.md }}>
              <Skeleton width="100%" height={52} />
            </div>
          )}
        </div>
      </ScrollArea>

      <DetailSheet
        t={t}
        entry={selected}
        ownAddress={w.status?.address ?? ""}
        onClose={() => setSelected(null)}
        onCopy={w.copy}
      />

      <ProcessingDetailSheet
        t={t}
        op={liveOpenOp}
        ownAddress={w.status?.address ?? ""}
        onClose={() => setOpenOp(null)}
        onDismiss={(id) => {
          w.dropOp(id);
          setOpenOp(null);
        }}
        onCopy={w.copy}
      />

      <DateRangeSheet
        t={t}
        open={showDate}
        value={range}
        onClose={() => setShowDate(false)}
        onApply={setRange}
      />
      <TypeFilterSheet
        t={t}
        open={showFilter}
        value={types}
        onClose={() => setShowFilter(false)}
        onApply={setTypes}
      />
    </>
  );
}

/** a square opener for a filter sheet, lit when that filter is on. */
function FilterButton({
  t,
  label,
  active,
  onClick,
  children,
}: {
  t: Theme;
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="pk-tap"
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: 42,
        height: 42,
        flex: "0 0 auto",
        borderRadius: radius.pill,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? t.accent : t.field,
        color: active ? t.onAccent : t.dark ? t.accent : t.sub,
      }}
    >
      {children}
    </button>
  );
}

/** the grouped list: a period heading over each run of entries under it. */
function List({
  t,
  entries,
  now,
  onOpen,
}: {
  t: Theme;
  entries: HistoryEntry[];
  now: number;
  onOpen: (e: HistoryEntry) => void;
}) {
  const rows: ReactNode[] = [];
  let lastLabel = "";
  entries.forEach((e, i) => {
    // the cascade is capped: staggering all of a long, paginated history would push
    // the last row a second and a half out, so only the first rows arrive one by one
    // and the rest ride in together just behind them.
    const delay = `${Math.min(i, 8) * ROW_STAGGER_MS}ms`;
    const label = periodLabel(e.at, now);
    if (label !== lastLabel) {
      lastLabel = label;
      rows.push(
        <div
          key={`h-${label}-${i}`}
          className="pocket-row-in"
          style={{ marginTop: i === 0 ? 0 : space.lg, animationDelay: delay }}
        >
          <Overline t={t}>{label}</Overline>
        </div>,
      );
    }
    rows.push(<Entry key={e.id} t={t} e={e} onClick={() => onOpen(e)} delay={delay} />);
  });
  return <div style={{ display: "grid", gap: 2 }}>{rows}</div>;
}

/** the leading logo with a small direction badge in its corner. */
function Mark({ t, e, size = 40 }: { t: Theme; e: HistoryEntry; size?: number }) {
  const badge = size >= 40 ? 18 : 15;
  const inbound = e.direction === "in";
  const outbound = e.direction === "out";
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "0 0 auto" }}>
      <span
        style={{
          boxSizing: "border-box",
          width: size,
          height: size,
          borderRadius: radius.md,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // the token's own artwork in a neutral bordered frame, not an accent
          // tint that would compete with the logo's colour.
          background: "transparent",
          border: `1px solid ${t.line}`,
        }}
      >
        <AssetMark t={t} id={assetId(e)} code={e.code} />
      </span>
      {e.direction !== "self" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            bottom: -3,
            left: -3,
            width: badge,
            height: badge,
            borderRadius: "50%",
            background: inbound ? t.positive : t.accent,
            color: inbound ? t.onDanger : t.onAccent,
            border: `2px solid ${t.bg}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {inbound ? (
            <ArrowDown size={badge - 6} sw={2.6} />
          ) : outbound ? (
            <ArrowUp size={badge - 6} sw={2.6} />
          ) : null}
        </span>
      )}
    </span>
  );
}

/** one activity row: mark, code over its sentence, amount on the right. staggers in
 *  like every other list row, and carries the hover veil so it reads as pressable. */
function Entry({
  t,
  e,
  onClick,
  delay,
}: {
  t: Theme;
  e: HistoryEntry;
  onClick: () => void;
  delay?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pk-tap pocket-row-in"
      style={{
        all: "unset",
        cursor: "pointer",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: space.md,
        width: "100%",
        padding: `${space.sm}px 0`,
        borderRadius: radius.md,
        minWidth: 0,
        animationDelay: delay,
      }}
    >
      <Mark t={t} e={e} />
      <span style={{ minWidth: 0, textAlign: "left", flex: "1 1 90px" }}>
        <span style={{ ...text.rowTitle, color: t.text, display: "block" }}>{e.code}</span>
        <span style={{ ...text.rowSub, color: t.sub, display: "block", marginTop: 1 }}>
          {entryLine(e)}
        </span>
      </span>
      <span style={{ ...text.value, color: t.sub, textAlign: "right", flex: "0 0 auto" }}>
        {e.amount === null ? "—" : `${displayAmount(e.amount)} ${e.code}`}
      </span>
    </button>
  );
}

/** a labelled row inside the detail; copyable when a value is worth copying. */

function DetailRow({
  t,
  label,
  value,
  onCopy,
  href,
}: {
  t: Theme;
  label: string;
  value: string;
  onCopy?: () => void;
  /** when set, a trailing link opens this row's address or tx on stellar.expert. */
  href?: string;
}) {
  // a copy that changes nothing on screen reads as a dead tap; echo it briefly
  // the way every other copy affordance in the wallet does.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(id);
  }, [copied]);
  const fire = onCopy
    ? () => {
        onCopy();
        setCopied(true);
      }
    : undefined;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.md,
        minHeight: 40,
      }}
    >
      <span style={{ ...text.rowSub, color: t.sub, flex: "0 0 auto" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <button
          type="button"
          onClick={fire}
          disabled={!onCopy}
          style={{
            all: "unset",
            cursor: onCopy ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            color: onCopy ? t.accent : t.text,
          }}
        >
          {copied && <Check size={14} sw={2.4} />}
          <span
            style={{
              ...text.value,
              fontFamily: fonts.mono,
              color: onCopy ? t.accent : t.text,
              overflowWrap: "anywhere",
              textAlign: "right",
            }}
          >
            {copied ? "Copied" : value}
          </span>
        </button>
        {href && (
          // opens the address or tx on stellar.expert so the on-chain fact can be
          // verified independently. a new tab, which closes the popup, is the only
          // way out of a toolbar popup to a page.
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${label} on stellar.expert`}
            style={{ color: t.accent, display: "flex", flex: "0 0 auto" }}
          >
            <External size={15} />
          </a>
        )}
      </div>
    </div>
  );
}

/** the transaction, expanded: what it was, when, its value, and the on-chain
 *  facts that let someone verify it for themselves. */
function DetailSheet({
  t,
  entry,
  ownAddress,
  onClose,
  onCopy,
}: {
  t: Theme;
  entry: HistoryEntry | null;
  ownAddress: string;
  onClose: () => void;
  onCopy: (v: string) => void;
}) {
  // hold the last entry through the close so the card slides DOWN still showing it
  // rather than emptying to a blank panel the instant it is deselected.
  const e = useRetained(entry, 300);
  const network = useWallet().status?.network;

  return (
    <Sheet t={t} open={entry !== null} onClose={onClose} title=" " focusKey={e?.id}>
      {e && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <Mark t={t} e={e} size={44} />
            <div style={{ minWidth: 0 }}>
              <div style={{ ...text.heading, color: t.text }}>{entryLine(e) || e.code}</div>
              <div style={{ ...text.rowSub, color: t.sub, marginTop: 1 }}>{fullDate(e.at)}</div>
            </div>
          </div>

          {/* the exact token amount, and only that. no dollar figure: this wallet
              keeps no per-transaction historical price, and a serious wallet does not
              show a PAST transfer's value at TODAY's rate as if it were what the
              transfer was worth. the amount on the ledger is the fact. */}
          <div style={{ textAlign: "center", margin: `${space.xl}px 0 ${space.lg}px` }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                color: t.text,
              }}
            >
              <span style={{ width: 26, height: 26, flex: "0 0 auto" }}>
                <AssetMark t={t} id={assetId(e)} code={e.code} />
              </span>
              <span
                style={{
                  ...text.hero,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums lining-nums",
                }}
              >
                {e.amount === null ? "—" : capDecimals(e.amount, 7)}
              </span>
              {e.amount !== null && <span style={{ ...text.heading, color: t.sub }}>{e.code}</span>}
            </div>
          </div>

          {/* a torn-receipt rule between the value and the on-chain facts. */}
          <div
            aria-hidden
            style={{
              borderTop: `1.5px dashed ${t.line}`,
              margin: `0 0 ${space.md}px`,
            }}
          />

          <div style={{ display: "grid", gap: space.xs }}>
            <DetailRow
              t={t}
              label="Wallet"
              value={short(ownAddress)}
              onCopy={ownAddress ? () => onCopy(ownAddress) : undefined}
              href={ownAddress ? explorerUrl(network, "account", ownAddress) : undefined}
            />
            {e.counterparty && (
              <DetailRow
                t={t}
                label={e.direction === "in" ? "Received from" : "Sent to"}
                value={short(e.counterparty)}
                onCopy={() => onCopy(e.counterparty!)}
                href={explorerUrl(network, "account", e.counterparty)}
              />
            )}
            <DetailRow
              t={t}
              label="Onchain transaction"
              value={short(e.hash)}
              onCopy={() => onCopy(e.hash)}
              href={explorerUrl(network, "tx", e.hash)}
            />
            {e.fee && <DetailRow t={t} label="Onchain fee" value={`${e.fee} XLM`} />}
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** one honest line for a whole confirm. the popup gets no phase updates from the
 *  worker's single blocking call, so it does not invent one; a private op is
 *  proven then submitted, a public one is only submitted. */
function statusText(op: BgOp): string {
  if (op.status === "done") return "Completed";
  // Not a failure, and worded so nobody reads it as one. The worker still holds
  // an in-flight record for this hash, which means the transaction may yet be
  // included, and the only wrong thing a user can do here is send it again.
  if (op.status === "unresolved") return "Not confirmed yet. Do not send it again.";
  if (op.status === "failed") return op.error ?? "Could not complete";
  return op.verb === "Send" ? "Confirming on the ledger…" : "Proving and submitting…";
}

/** the coloured status token for the detail header. */
function StatusPill({ t, status }: { t: Theme; status: BgOp["status"] }) {
  const map = {
    processing: { label: "In progress", fg: t.accentOnSoft, bg: t.accentSoft },
    done: { label: "Completed", fg: t.positive, bg: t.positiveSoft },
    // `exposed` is the pocket's own "this needs your attention" tone, not the
    // red of a failure. An unresolved submission may still land, so the red
    // would be a claim the wallet cannot support and the one that provokes a
    // resend.
    unresolved: { label: "Not confirmed", fg: t.exposed, bg: t.exposedSoft },
    failed: { label: "Failed", fg: t.danger, bg: t.dangerSoft },
  } as const;
  const s = map[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px 5px 9px",
        borderRadius: radius.pill,
        background: s.bg,
        color: s.fg,
        ...text.chip,
      }}
    >
      {status === "processing" && <Spinner size={12} color={s.fg} />}
      {status === "done" && <Check size={13} sw={2.6} />}
      {(status === "failed" || status === "unresolved") && <Alert size={13} />}
      {s.label}
    </span>
  );
}

/** the asset logo with a corner badge that carries the op's state: a turning
 *  spinner while it works, a tick when it lands, an alert if it fails. */
function ProcessingMark({ t, op, size = 40 }: { t: Theme; op: BgOp; size?: number }) {
  const badge = 18;
  const done = op.status === "done";
  const failed = op.status === "failed";
  const unresolved = op.status === "unresolved";
  const bg = done ? t.positive : failed ? t.danger : unresolved ? t.exposed : t.accentSoft;
  const fg = done || failed || unresolved ? t.onDanger : t.accentOnSoft;
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "0 0 auto" }}>
      <span
        style={{
          boxSizing: "border-box",
          width: size,
          height: size,
          borderRadius: radius.md,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: `1px solid ${t.line}`,
        }}
      >
        <AssetMark t={t} id={assetId({ code: op.code })} code={op.code} />
      </span>
      <span
        aria-hidden
        style={{
          position: "absolute",
          bottom: -3,
          left: -3,
          width: badge,
          height: badge,
          borderRadius: "50%",
          background: bg,
          color: fg,
          border: `2px solid ${t.bg}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done ? (
          <Check size={badge - 8} sw={2.8} />
        ) : failed ? (
          <Alert size={badge - 8} />
        ) : (
          <Spinner size={badge - 6} color={fg} />
        )}
      </span>
    </span>
  );
}

/**
 * the header's quick view of what is still in flight, opened from the count badge
 * next to the refresh button. the same watched transactions the Activity list
 * shows inline, gathered into a sheet so they are reachable from any screen without
 * leaving for Activity. one row opens the same detail the inline rows do.
 */
export function TransactionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  // done ops have moved to the settled history, so this quick view is the still-
  // running and failed ones, the same as Activity's "In progress" section.
  const pending = w.backgroundOps.filter((o) => o.pocket === w.pocket && o.status !== "done");
  const inProgress = pending.filter((o) => o.status === "processing").length;
  const [openOp, setOpenOp] = useState<BgOp | null>(null);
  const liveOpenOp = openOp ? (w.backgroundOps.find((o) => o.id === openOp.id) ?? null) : null;

  return (
    <>
      <Sheet t={t} open={open} onClose={onClose} title=" ">
        <div style={{ textAlign: "center", marginBottom: space.lg }}>
          <div style={{ ...text.screenTitle, color: t.text }}>Transactions</div>
          <div style={{ ...text.body, fontWeight: 600, color: t.sub, marginTop: 4 }}>
            {inProgress > 0 ? `${inProgress} in progress` : "None in progress"}
          </div>
        </div>
        {pending.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: space.md,
              padding: `${space.md}px 0 ${space.lg}px`,
              textAlign: "center",
            }}
          >
            <span aria-hidden style={{ color: t.faint, display: "flex" }}>
              <Clock size={28} />
            </span>
            <span style={{ ...text.body, color: t.faint }}>
              Nothing in progress. A transaction stays here while it settles, even if you close the
              wallet.
            </span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: space.sm, paddingBottom: space.gutter }}>
            {pending.map((op, i) => (
              <ProcessingRow key={op.id} t={t} op={op} index={i} onClick={() => setOpenOp(op)} />
            ))}
          </div>
        )}
      </Sheet>

      <ProcessingDetailSheet
        t={t}
        op={liveOpenOp}
        ownAddress={w.status?.address ?? ""}
        onClose={() => setOpenOp(null)}
        onDismiss={(id) => {
          w.dropOp(id);
          setOpenOp(null);
        }}
        onCopy={w.copy}
      />
    </>
  );
}

/** one watched transaction: what it is and where to over its live status, with the
 *  whole card opening its detail. */
function ProcessingRow({
  t,
  op,
  onClick,
  index = 0,
}: {
  t: Theme;
  op: BgOp;
  onClick: () => void;
  index?: number;
}) {
  const done = op.status === "done";
  const failed = op.status === "failed";
  const statusColor = done
    ? t.positive
    : failed
      ? t.danger
      : op.status === "unresolved"
        ? t.exposed
        : t.sub;
  return (
    <button
      type="button"
      onClick={onClick}
      className="pk-tap pocket-row-in"
      style={{
        all: "unset",
        cursor: "pointer",
        boxSizing: "border-box",
        display: "block",
        width: "100%",
        border: `1px solid ${t.line}`,
        borderRadius: radius.md,
        background: t.surface,
        padding: space.md,
        animationDelay: `${Math.min(index, 8) * ROW_STAGGER_MS}ms`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <ProcessingMark t={t} op={op} />
        <span style={{ minWidth: 0, flex: "1 1 auto", textAlign: "left" }}>
          <span style={{ ...text.rowTitle, color: t.text, display: "block" }}>{op.verb}</span>
          {op.to && (
            <span style={{ ...text.rowSub, color: t.sub, display: "block", marginTop: 1 }}>
              To {short(op.to)}
            </span>
          )}
        </span>
        {op.amount && (
          <span style={{ textAlign: "right", flex: "0 0 auto", minWidth: 0 }}>
            <span style={{ ...text.value, color: t.text, display: "block" }}>
              {displayAmount(op.amount)} {op.code}
            </span>
            {op.fiat != null && (
              <span style={{ ...text.rowSub, color: t.sub, display: "block", marginTop: 1 }}>
                {usd(op.fiat)}
              </span>
            )}
          </span>
        )}
      </div>

      <div aria-hidden style={{ borderTop: `1px solid ${t.line}`, margin: `${space.sm}px 0 0` }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.sm,
          marginTop: space.sm,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            minWidth: 0,
            ...text.rowSub,
            color: statusColor,
          }}
        >
          {op.status === "processing" && <Spinner size={13} color={t.sub} />}
          {done && <Check size={13} sw={2.6} />}
          {failed && <Alert size={13} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {statusText(op)}
          </span>
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            flex: "0 0 auto",
            ...text.chip,
            color: t.accent,
          }}
        >
          More details
          <ChevronRight size={15} />
        </span>
      </div>
    </button>
  );
}

/** a watched transaction, expanded: what it is, its live status, and the on-chain
 *  facts once it has them. mirrors the completed DetailSheet, but for something
 *  still in flight, so it leads with status and offers to dismiss a settled one. */
function ProcessingDetailSheet({
  t,
  op: liveOp,
  ownAddress,
  onClose,
  onDismiss,
  onCopy,
}: {
  t: Theme;
  op: BgOp | null;
  ownAddress: string;
  onClose: () => void;
  onDismiss: (id: string) => void;
  onCopy: (v: string) => void;
}) {
  // hold the last op through the close so the sheet slides DOWN still showing it,
  // not an empty card; `liveOp` drives open/close, `op` the body.
  const op = useRetained(liveOp, 300);
  return (
    <Sheet t={t} open={liveOp !== null} onClose={onClose} title=" " focusKey={op?.id}>
      {op && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.md,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: space.md, minWidth: 0 }}>
              <ProcessingMark t={t} op={op} size={44} />
              <div style={{ minWidth: 0 }}>
                <div style={{ ...text.heading, color: t.text }}>{op.verb}</div>
                <div style={{ ...text.rowSub, color: t.sub, marginTop: 1 }}>{fullDate(op.at)}</div>
              </div>
            </div>
            <StatusPill t={t} status={op.status} />
          </div>

          {op.amount && (
            <div style={{ textAlign: "center", margin: `${space.xl}px 0 ${space.lg}px` }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  color: t.text,
                }}
              >
                <span style={{ width: 26, height: 26, flex: "0 0 auto" }}>
                  <AssetMark t={t} id={assetId({ code: op.code })} code={op.code} />
                </span>
                <span
                  style={{
                    ...text.hero,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums lining-nums",
                  }}
                >
                  {capDecimals(op.amount, 7)}
                </span>
                <span style={{ ...text.heading, color: t.sub }}>{op.code}</span>
              </div>
              {op.fiat != null && (
                <div style={{ ...text.body, color: t.sub, marginTop: 4 }}>{usd(op.fiat)}</div>
              )}
            </div>
          )}

          {op.status === "failed" && op.error && (
            <div style={{ margin: `${space.md}px 0` }}>
              <Notice t={t} tone="danger">
                {op.error}
              </Notice>
            </div>
          )}

          <div
            aria-hidden
            style={{ borderTop: `1.5px dashed ${t.line}`, margin: `0 0 ${space.md}px` }}
          />

          <div style={{ display: "grid", gap: space.xs }}>
            <DetailRow
              t={t}
              label="Wallet"
              value={short(ownAddress)}
              onCopy={ownAddress ? () => onCopy(ownAddress) : undefined}
              href={ownAddress ? explorerUrl(op.network, "account", ownAddress) : undefined}
            />
            {op.to && (
              <DetailRow
                t={t}
                label="Sent to"
                // A bridge is the one operation whose recipient is not a Stellar
                // account: `to` is a 0x EVM address on the destination chain. It
                // was shortened by the Stellar shortener and linked to
                // stellar.expert's ACCOUNT page, which cannot know it, so the
                // one link a user would follow to check where their USDC went
                // led to "address does not exist". Shown in full and left
                // unlinked instead: this wallet has no explorer for that chain,
                // and no link is better than one that denies the address.
                value={isStellarAddress(op.to) ? short(op.to) : op.to}
                onCopy={() => onCopy(op.to!)}
                href={isStellarAddress(op.to) ? explorerUrl(op.network, "account", op.to) : undefined}
              />
            )}
            {op.fee && <DetailRow t={t} label="Onchain fee" value={`${op.fee} XLM`} />}
            {op.hash && (
              <DetailRow
                t={t}
                label="Onchain transaction"
                value={short(op.hash)}
                onCopy={() => onCopy(op.hash!)}
                href={explorerUrl(op.network, "tx", op.hash)}
              />
            )}
          </div>

          {op.status === "processing" ? (
            <div style={{ ...text.body, color: t.faint, textAlign: "center", marginTop: space.lg }}>
              Safe to close. This keeps going in the background.
            </div>
          ) : (
            <div style={{ marginTop: space.lg }}>
              <Button t={t} variant="quiet" onClick={() => onDismiss(op.id)}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
