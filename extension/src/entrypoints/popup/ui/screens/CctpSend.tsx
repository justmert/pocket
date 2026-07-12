// cross-chain USDC, outbound: burn on Stellar, mint on another chain.
//
// a page like send: pick the destination chain, paste the recipient there, set
// the amount, review, confirm. the worker's buildCctpSend -> confirmCctpSend runs
// TWO Stellar signatures (approve, then burn); the mint on the far side is a
// separate transaction THERE, which this wallet cannot make, and the review says
// so plainly. after the burn lands, the receipt polls Circle's attestation so the
// user knows when it is ready to complete on the other chain.
import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Field, Frame, Header, Notice, Row, Sheet } from "../primitives";
import { InfoTip } from "../Tooltip";
import { AmountComposer, withinSpendable } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { ChevronRight, Globe } from "../icons";
import { fractionOf, composeAmount } from "../../../../core/chain/balances";
import {
  CCTP_DOMAIN_NAMES,
  STELLAR_DOMAIN,
  cctpDomainName,
} from "../../../../core/integrations/cctp";
import { radius, space, text, type Theme } from "../theme";
import type { CctpSummary } from "../../../../core/messages";

/** the EVM chains a CCTP transfer can involve with this wallet: every CCTP domain
 *  whose address is an EVM 0x address. Solana (domain 5) is excluded because its
 *  address is not 0x, and Stellar (27) is home. Sourced from the backend's own
 *  table, so the list can never name a chain the worker does not know. Shared with
 *  the inbound claim screen (same set of source chains). */
export const CROSS_CHAIN_DOMAINS = Object.entries(CCTP_DOMAIN_NAMES)
  .map(([d, name]) => ({ domain: Number(d), name }))
  .filter((c) => c.domain !== STELLAR_DOMAIN && c.domain !== 5)
  .sort((a, b) => a.domain - b.domain);

/** the backend validates a 20-byte EVM address; mirror the rule for live feedback. */
const EVM_RE = /^(0x)?[0-9a-fA-F]{40}$/;

export function CctpSend({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;

  const balances = w.balances ?? [];
  const usdc = balances.find((b) => b.code === "USDC") ?? null;
  const markId = usdc?.id ?? "USDC";
  const spendable = usdc?.amount ?? null;

  const [domain, setDomain] = useState<number | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<CctpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [attNote, setAttNote] = useState<string | undefined>(undefined);
  const once = useOnce();
  const opId = useRef<string | null>(null);
  const leaving = useRef(false);

  const chainName = domain !== null ? cctpDomainName(domain) : null;
  const recipientValid = EVM_RE.test(recipient.trim());

  const setMax = () => {
    if (!spendable) return;
    setAmount(composeAmount(fractionOf(spendable, 1n, 1n), 4));
  };

  const review = async () => {
    if (domain === null) return;
    setError(null);
    setBuilding(true);
    try {
      const r = await call({
        type: "buildCctpSend",
        destinationDomain: domain,
        recipient: recipient.trim(),
        amount,
      });
      setHandle(r.handle);
      setSummary(r.summary);
      setConfirming(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    const id = w.beginOp({
      verb: "Bridge",
      pocket: "public",
      code: "USDC",
      amount: summary?.amount ?? amount,
      to: recipient.trim(),
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      // confirmCctpSend returns the BURN hash (what the attestation tracks) plus
      // the approve hash; the receipt and the poll use the burn hash.
      const r = await call({ type: "confirmCctpSend", handle });
      w.completeOp(id, { hash: r.hash, ledger: r.ledger });
      setResult({ hash: r.hash, ledger: r.ledger });
      setBusy(false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      w.failOp(id, reason);
      setError(reason);
      setBusy(false);
      once.release();
    }
  };

  // once the burn has landed, poll Circle's attestation so the receipt can say when
  // the transfer is ready to complete on the other chain. the burn is on Stellar,
  // so the source domain of the attestation is Stellar's own.
  useEffect(() => {
    if (!result) {
      setAttNote(undefined);
      return;
    }
    let live = true;
    let tries = 0;
    setAttNote("Waiting for Circle to attest the burn. This can take a few minutes.");
    const poll = async () => {
      if (!live) return;
      tries += 1;
      try {
        const a = await call({
          type: "cctpAttestation",
          sourceDomain: STELLAR_DOMAIN,
          txHash: result.hash,
        });
        if (!live) return;
        if (a.ready) {
          setAttNote(
            `Attested. Complete the mint on ${chainName ?? "the other chain"} from your wallet or a relayer there.`,
          );
          return;
        }
      } catch {
        // an attestation read that fails changes nothing about the burn; keep
        // polling and leave the last note in place.
      }
      if (live && tries < 40) setTimeout(() => void poll(), 6000);
    };
    const id = setTimeout(() => void poll(), 3000);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [result, chainName]);

  const closeConfirm = () => {
    if (busy) return;
    once.release();
    if (result) {
      leaving.current = true;
      if (opId.current) w.dropOp(opId.current);
      opId.current = null;
    }
    setConfirming(false);
  };
  const onConfirmClosed = () => {
    if (leaving.current) {
      leaving.current = false;
      onClose();
    }
  };

  // Continue is offered only when the bridge can actually be funded: a chosen
  // chain, a valid EVM recipient, a positive amount, AND enough USDC to cover it
  // (spendable is null when no USDC is held, so this also disables the "you hold
  // no USDC" dead end the notice above describes).
  const ready =
    domain !== null &&
    recipientValid &&
    amount !== "" &&
    Number(amount) > 0 &&
    withinSpendable(amount, spendable);

  return (
    <>
      <Frame t={t} className="pocket-page">
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title="Send to a chain"
                onBack={onClose}
                right={
                  <InfoTip t={t} label="About cross-chain USDC">
                    This burns USDC on Stellar and mints it on the chosen chain via Circle's CCTP.
                    Pocket signs the Stellar side; the mint on the other chain is a separate
                    transaction there, which needs gas on that chain or a relayer.
                  </InfoTip>
                }
              />
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
              {!usdc && (
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="exposed" bare>
                    You do not hold any public USDC to bridge. Receive or swap into USDC first.
                  </Notice>
                </div>
              )}

              <AmountComposer
                t={t}
                code="USDC"
                amount={amount}
                onAmount={setAmount}
                spendable={spendable}
                onMax={setMax}
                mark={<AssetMark t={t} id={markId} code="USDC" />}
                onSubmit={() => ready && void review()}
              />

              {/* the destination chain */}
              <button
                type="button"
                onClick={() => setPicking(true)}
                aria-label="Choose the destination chain"
                className="pk-tap"
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  width: "100%",
                  marginTop: space.md,
                  padding: `14px 16px`,
                  borderRadius: radius.md,
                  background: t.field,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: radius.md,
                    background: t.accentSoft,
                    color: t.accentOnSoft,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "0 0 auto",
                  }}
                >
                  <Globe size={20} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...text.label, color: t.sub, display: "block" }}>To chain</span>
                  <span
                    style={{
                      ...text.rowTitle,
                      color: chainName ? t.text : t.faint,
                      display: "block",
                    }}
                  >
                    {chainName ?? "Choose a chain"}
                  </span>
                </span>
                <span aria-hidden style={{ color: t.faint, display: "flex" }}>
                  <ChevronRight size={18} />
                </span>
              </button>

              <div style={{ marginTop: space.md }}>
                <Field
                  t={t}
                  label="Recipient address on that chain"
                  value={recipient}
                  onChange={setRecipient}
                  placeholder="0x…"
                  mono
                  invalid={recipient !== "" && !recipientValid}
                  hint={
                    recipient !== "" && !recipientValid
                      ? "That is not a 20-byte EVM address (0x followed by 40 hex characters)."
                      : "The EVM address that receives the USDC on the other chain."
                  }
                  onSubmit={() => ready && void review()}
                />
              </div>

              {error && !confirming && (
                <div style={{ marginTop: space.md }}>
                  <Notice t={t} tone="danger" bare>
                    {error}
                  </Notice>
                </div>
              )}
            </div>

            <div
              style={{ padding: `${space.md}px ${space.gutter}px ${space.lg}px`, background: t.bg }}
            >
              <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
                {building ? "Checking" : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </Frame>

      <ChainPicker
        t={t}
        open={picking}
        chains={CROSS_CHAIN_DOMAINS}
        onPick={(d) => {
          setDomain(d);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />

      <ConfirmSheet
        t={t}
        open={confirming}
        heading="Confirm bridge"
        verb="Bridge"
        mark={<AssetMark t={t} id={markId} code="USDC" />}
        amount={summary?.amount}
        code="USDC"
        // the worker's reading of the 32 bytes it recorded, not this screen's
        // form state. the two agree in every ordinary case, and the whole point
        // of a confirm step is the case where they do not. the typed value is
        // only a fallback for the frame before the summary lands.
        to={summary?.recipient ?? recipient.trim()}
        fee={summary?.fee}
        effects={summary?.effects ?? []}
        error={error}
        busy={busy}
        result={result}
        note={attNote}
        network={w.status?.network}
        approveLabel="Confirm and bridge"
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={onClose}
        onClosed={onConfirmClosed}
      />
    </>
  );
}

/** choose a cross-chain source or destination. a sheet, like send's asset picker. */
export function ChainPicker({
  t,
  open,
  chains,
  onPick,
  onClose,
}: {
  t: Theme;
  open: boolean;
  chains: { domain: number; name: string }[];
  onPick: (domain: number) => void;
  onClose: () => void;
}) {
  return (
    <Sheet t={t} open={open} onClose={onClose} title="Choose a chain">
      <div style={{ paddingBottom: space.gutter }}>
        {chains.map((c, i) => (
          <Row
            key={c.domain}
            t={t}
            index={i}
            icon={<Globe size={20} />}
            title={c.name}
            onClick={() => onPick(c.domain)}
          />
        ))}
      </div>
    </Sheet>
  );
}
