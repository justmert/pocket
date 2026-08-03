// When the private account goes dormant, on a screen.
//
// A confidential account archives after 30 idle days and the wallet bumps it on
// an alarm while unlocked. Both facts matter to someone about to leave money
// there and close the browser for a month, and neither was anywhere in the
// product: `expiresAt` and `daysRemaining` were computed by the worker,
// converted per network, carried across the message contract, and read by
// nothing at all. `KeepAlivePlan.notice` was documented as "what to tell the
// user" and shown to nobody either.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateAssetSheet } from "./PrivateAssetSheet";
import { theme } from "../theme";
import { Ctx, type Wallet } from "../WalletProvider";
import { KEEPALIVE_THRESHOLD_DAYS } from "../../../../core/chain/ttl";
import type { PrivatePocket } from "../../../../core/messages";

vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: async () => ({ ok: false, error: "no worker in this harness" }),
    getURL: (p: string) => p,
  },
});

const DAY = 86_400_000;

function render(pocket: PrivatePocket) {
  const value = {
    t: theme("private"),
    pocket: "private",
    status: { address: "G".padEnd(56, "A"), network: "testnet" },
    privateDetail: pocket,
    hidden: false,
    closeSheet: () => undefined,
    openSheet: () => undefined,
  } as unknown as Wallet;
  return renderToStaticMarkup(
    <Ctx.Provider value={value}>
      <PrivateAssetSheet open onClose={() => undefined} />
    </Ctx.Provider>,
  );
}

const ready = (daysRemaining: number): PrivatePocket => ({
  state: "ready",
  symbol: "XLM",
  token: "CXLM",
  spendable: "5.0000000",
  expiresAt: new Date(Date.now() + daysRemaining * DAY).toISOString(),
  daysRemaining,
});

describe("the private asset sheet", () => {
  it("says when the account goes dormant", () => {
    const html = render(ready(20));
    expect(html, "the archive date was computed and shown to nobody").toMatch(/Active until/i);
  });

  it("says the wallet keeps it awake, so the date is not a worry with no answer", () => {
    expect(render(ready(20))).toMatch(/keeps it awake/i);
  });

  it("changes its wording once a bump is due, and not before", () => {
    // The threshold is the planner's own, imported rather than repeated: a
    // warning that appears before the wallet considers a bump due tells the
    // user to worry about something it has not yet decided to act on.
    expect(render(ready(KEEPALIVE_THRESHOLD_DAYS - 1))).toMatch(/goes dormant on/i);
    expect(render(ready(KEEPALIVE_THRESHOLD_DAYS + 1))).toMatch(/Active until/i);
  });

  it("says nothing when the ledger did not report a TTL", () => {
    // Absent is "not known", and inventing a date for it would be worse than
    // the silence this replaces.
    const html = render({ state: "ready", symbol: "XLM", token: "CXLM", spendable: "5.0000000" });
    expect(html).not.toMatch(/Active until|goes dormant on/i);
  });
});
