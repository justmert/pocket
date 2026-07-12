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
import { findHeld, holdingAmount } from "../holdings";
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

/** Every CCTP domain the worker knows, minus Stellar, which is home. */
const OTHER_CHAINS = Object.entries(CCTP_DOMAIN_NAMES)
  .map(([d, name]) => ({ domain: Number(d), name }))
  .filter((c) => c.domain !== STELLAR_DOMAIN)
  .sort((a, b) => a.domain - b.domain);

/** Solana. Its addresses are base58, not 0x, and its tx ids are base58 too. */
const SOLANA_DOMAIN = 5;

/**
 * Chains this wallet can SEND to: the EVM ones.
 *
 * Solana is excluded for a reason specific to sending: the recipient field
 * composes a 32-byte `mintRecipient` from an EVM 0x address, and there is no
 * screen that can take a base58 one.
 */
export const SEND_DOMAINS = OTHER_CHAINS.filter((c) => c.domain !== SOLANA_DOMAIN);

/**
 * Chains a claim can come FROM: all of them.
 *
 * The claim screen used to share the send list, so a Solana-originated transfer
 * could not be claimed for a reason that only applies in the other direction.
 * Nothing about claiming touches the source chain's address format: the wallet
 * hands Circle's attestation service a domain and a transaction id and receives
 * a message to submit on Stellar, and every leg after that is Stellar's.
 */
export const CLAIM_DOMAINS = OTHER_CHAINS;

/**
 * Is this a plausible transaction id on that chain?
 *
 * Live feedback only; Circle's attestation service is the real judge. EVM ids
 * are 32 bytes of hex, and Solana's are base58 signatures of 64 bytes, so one
 * pattern cannot cover both and the hex one silently rejected every Solana
 * signature that reached the field.
 */
export function isTxId(value: string, domain: number | null): boolean {
  const v = value.trim();
  if (domain === SOLANA_DOMAIN) return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v);
  return /^(0x)?[0-9a-fA-F]{64}$/.test(v);
}

/** the backend validates a 20-byte EVM address; mirror the rule for live feedback. */
const EVM_RE = /^(0x)?[0-9a-fA-F]{40}$/;

export function CctpSend({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;

  // FOUR answers, not two. `(w.balances ?? []).find(...)` reads an unloaded or
  // failed balance list as "you hold no USDC", which this screen then states as
  // a fact and acts on by disabling Continue permanently.
  const usdcHeld = findHeld(w.balances, w.balanceError, (b) => b.code === "USDC");
  const usdc = usdcHeld.kind === "held" ? usdcHeld.balance : null;
  const markId = usdc?.id ?? "USDC";
  const spendable = holdingAmount(usdcHeld);

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
  // chain, a valid EVM recipient, a positive amount, AND enough USDC to cover
  // it. `spendable` is null whenever there is no figure to be sure of, which
  // covers "holds none", "not loaded" and "could not read" alike: all three are
  // reasons not to offer a bridge, and only the first is a reason to say so.
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
              {usdcHeld.kind === "absent" && (
                // it reads as an error because it BLOCKS the bridge (Continue is
                // disabled until it is resolved), and the way to resolve it is a link
                // inside the sentence rather than a separate control, the same shape
                // the swap page uses for a missing asset.
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="danger" bare>
                    You do not hold any public USDC to bridge.{" "}
                    <button
                      type="button"
                      onClick={() => w.openSheet("swap")}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        color: "inherit",
                        textDecoration: "underline",
                        fontWeight: 700,
                      }}
                    >
                      Swap into USDC
                    </button>{" "}
                    first.
                  </Notice>
                </div>
              )}
              {usdcHeld.kind === "unreadable" && (
                <div style={{ marginBottom: space.md }}>
                  {/* the worker's own sentence. telling someone to go and get
                      USDC they may already have is worse than saying nothing,
                      because it is a specific instruction to do wasted work. */}
                  <Notice t={t} tone="danger">
                    {usdcHeld.message}
                  </Notice>
                </div>
              )}

              <AmountComposer
                t={t}
                code="USDC"
                amount={amount}
                onAmount={(v) => {
                  setAmount(v);
                  setError(null);
                }}
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
              <Button
                t={t}
                disabled={!ready || Boolean(error)}
                busy={building}
                onClick={() => void review()}
              >
                {building ? "Checking" : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </Frame>

      <ChainPicker
        t={t}
        open={picking}
        chains={SEND_DOMAINS}
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
