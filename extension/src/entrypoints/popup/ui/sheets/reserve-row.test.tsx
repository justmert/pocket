// The reserve, on the sheet that exists to explain one asset.
//
// `PublicBalance.reserved` is computed by the worker, documented in the message
// contract as "Protocol-locked reserve. Present for native only", carried
// across the boundary on every native balance, and for a long time read by
// nothing at all. The consequence is arithmetic a user cannot close: "Your
// holdings" is the SPENDABLE figure, so an explorer shows 10 XLM where this
// sheet shows 8.5, and nothing on it says where 1.5 went.
//
// Home's asset row names it. This sheet, which is where someone goes when they
// want to understand one asset, did not.
import { describe, it, expect, vi } from "vitest";

// The sheet fetches a market read on mount, through `rpc.call`, which speaks to
// the worker over `chrome.runtime`. There is no browser here; the sheet renders
// its "price unavailable" state, which is not what this file is about.
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: async () => ({ ok: false, error: "no worker in this harness" }),
    getURL: (p: string) => p,
  },
});
import { renderToStaticMarkup } from "react-dom/server";
import { AssetDetailSheet } from "./AssetDetailSheet";
import { theme } from "../theme";
import { Ctx, type Wallet } from "../WalletProvider";
import type { PublicBalance } from "../../../../core/messages";

function render(asset: PublicBalance) {
  const value = {
    t: theme("public"),
    pocket: "public",
    status: { address: "G".padEnd(56, "A"), network: "testnet" },
    balances: [asset],
    hidden: false,
    copy: () => undefined,
    copied: false,
  } as unknown as Wallet;
  return renderToStaticMarkup(
    <Ctx.Provider value={value}>
      <AssetDetailSheet
        asset={asset}
        onClose={() => undefined}
        onSend={() => undefined}
        onSwap={() => undefined}
      />
    </Ctx.Provider>,
  );
}

const NATIVE = (reserved?: string): PublicBalance => ({
  id: "native",
  code: "XLM",
  amount: "8.5000000",
  total: "10.0000000",
  ...(reserved === undefined ? {} : { reserved }),
  authorized: true,
});

describe("the asset detail sheet for native XLM", () => {
  it("names the reserve, so the figures add up", () => {
    const html = render(NATIVE("1.5000000"));
    expect(html).toMatch(/network reserve/i);
    expect(html).toContain("1.5000000");
  });

  it("offers the explanation, not just the number", () => {
    // The prose lives in an InfoTip whose bubble mounts on open, so what static
    // markup can show is the control that opens it. That it exists at all is
    // the property: a locked figure with no way to find out why is the same
    // unexplained gap one layer down.
    const html = render(NATIVE("1.5000000"));
    expect(html).toMatch(/aria-label="Held as network reserve"/);
  });

  it("draws no row when there is nothing locked", () => {
    // A zero reserve row is noise, and a non-native asset has no reserve at all.
    expect(render(NATIVE("0.0000000"))).not.toMatch(/network reserve/i);
    expect(render(NATIVE())).not.toMatch(/network reserve/i);
  });
});
