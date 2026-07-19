// cross-chain USDC, inbound: claim a transfer that was burned on another chain
// and is destined for this Stellar account.
//
// the burn happened elsewhere (not this wallet); this is the self-serviceable
// Stellar leg. paste the source chain and its burn tx hash, and the worker's
// buildCctpClaim fetches Circle's attestation and builds the mint. it refuses,
// with a clear message, if the attestation is not published yet, so the compose
// screen surfaces that rather than pretending the claim is ready.
import { useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Field, Frame, Header, Notice } from "../primitives";
import { InfoTip } from "../Tooltip";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark, privateMarkId } from "./Home";
import { ChevronRight, Globe } from "../icons";
import { ChainLogo } from "../ChainLogo";
import { CLAIM_DOMAINS, ChainPicker, isTxId, SOLANA_DOMAIN } from "./CctpSend";
import { cctpDomainName } from "../../../../core/integrations/cctp";
import { radius, space, text } from "../theme";
import type { CctpSummary } from "../../../../core/messages";

/** a source-chain burn tx hash is 32 bytes; mirror the shape for live feedback. */

export function CctpClaim({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;

  const balances = w.balances ?? [];
  // the CANONICAL USDC:ISSUER id, not the bare code, so the real USDC logo shows
  // even before any USDC is held (resolved from config, like the private marks).
  const markId =
    balances.find((b) => b.code === "USDC")?.id ?? privateMarkId("USDC", w.status?.network);

  const [domain, setDomain] = useState<number | null>(null);
  const [txHash, setTxHash] = useState("");
  const [picking, setPicking] = useState(false);

  const [error, setError] = useState<string | null>(null);
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<CctpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const once = useOnce();
  const opId = useRef<string | null>(null);
  const leaving = useRef(false);

  const chainName = domain !== null ? cctpDomainName(domain) : null;
  // The pattern follows the CHAIN. Solana signs in base58 and everything else
  // in hex, and one hex-only rule rejected every Solana signature typed here.
  const txValid = isTxId(txHash, domain);

  const review = async () => {
    if (domain === null) return;
    setError(null);
    setBuilding(true);
    try {
      const r = await call({
        type: "buildCctpClaim",
        sourceDomain: domain,
        txHash: txHash.trim(),
      });
      setHandle(r.handle);
      setSummary(r.summary);
      setConfirming(true);
    } catch (e) {
      // "not attested yet" lands here, verbatim from the worker: the honest
      // "try again shortly", not a claim built against a transfer that is not ready.
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
      verb: "Claim",
      pocket: "public",
      code: "USDC",
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = await call({ type: "confirmCctpClaim", handle });
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

  const ready = domain !== null && txValid;

  return (
    <>
      <Frame t={t} className="pocket-page">
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title="Claim from a chain"
                onBack={onClose}
                right={
                  <InfoTip t={t} label="About claiming cross-chain USDC">
                    Completes a CCTP transfer that was burned on another chain and addressed to this
                    account. Paste that chain and the burn transaction hash; the USDC arrives in
                    your public pocket. It can only be claimed once Circle has attested the burn.
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
              {/* the source chain */}
              <button
                type="button"
                onClick={() => setPicking(true)}
                aria-label="Choose the source chain"
                className="pk-tap"
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  width: "100%",
                  padding: `14px 16px`,
                  borderRadius: radius.md,
                  background: t.field,
                }}
              >
                {domain !== null ? (
                  <span aria-hidden style={{ flex: "0 0 auto", display: "flex" }}>
                    <ChainLogo domain={domain} size={34} />
                  </span>
                ) : (
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
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...text.label, color: t.sub, display: "block" }}>From chain</span>
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
                  label="Burn transaction hash"
                  value={txHash}
                  onChange={(v) => {
                    setTxHash(v);
                    // clear a prior build error so Continue re-enables on a new hash
                    // (without this, disabling Continue on error would deadlock here).
                    setError(null);
                  }}
                  // the SHAPE follows the chain, exactly as the validator beside it
                  // does. `isTxId` branches on the domain because Solana signs in
                  // base58 and everything else in hex, and both the placeholder and
                  // the invalid hint stated the EVM rule unconditionally: on Solana
                  // the field refused a correct signature and then explained the
                  // refusal with a rule that does not apply to it.
                  placeholder={domain === SOLANA_DOMAIN ? "base58 signature" : "0x…"}
                  mono
                  multiline
                  invalid={txHash !== "" && !txValid}
                  hint={
                    txHash !== "" && !txValid
                      ? domain === SOLANA_DOMAIN
                        ? "That is not a Solana transaction signature (base58, 64 to 90 characters)."
                        : "That is not a 32-byte transaction hash (0x followed by 64 hex characters)."
                      : "The hash of the burn transaction on the source chain."
                  }
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
              {/* `disabled` is NOT gated on `error`. this screen has no amount
               * field, and its most ordinary error is "not attested yet. Try again
               * shortly.", which is an instruction to press this button again:
               * latching it off left the wallet giving an instruction and removing
               * the means to follow it. `review` clears the error on entry, so a
               * retry that fails the same way simply says so again. */}
              <Button
                t={t}
                disabled={!ready}
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
        chains={CLAIM_DOMAINS}
        onPick={(d) => {
          setDomain(d);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />

      <ConfirmSheet
        t={t}
        open={confirming}
        heading="Confirm claim"
        mark={<AssetMark t={t} id={markId} code="USDC" />}
        code="USDC"
        fee={summary?.fee}
        // which chain this claim is FROM. the same fact the outbound sheet was
        // missing: it is signed, and an inbound sheet without it is identical for
        // every source chain.
        facts={summary?.chain ? [{ label: "From chain", value: summary.chain }] : []}
        effects={summary?.effects ?? []}
        error={error}
        unresolved={unresolved}
        busy={busy}
        result={result}
        network={w.status?.network}
        approveLabel="Confirm and claim"
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={w.goHome}
        onClosed={onConfirmClosed}
      />
    </>
  );
}
