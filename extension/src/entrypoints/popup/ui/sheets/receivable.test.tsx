// What the Receive sheet says can arrive.
//
// A Stellar account can only hold an asset it has a trustline for. A payment in
// anything else is rejected by the network with `op_no_trust`: the sender pays
// the fee and the money never moves, and the recipient hears nothing, because
// from their side no payment happened.
//
// The wallet had the fact and could not say it. `controller.balances` does
// `if (!tl) continue`, so an asset with no trustline is OMITTED rather than
// shown at zero, and nothing in the wallet opens a trustline on its own. A
// fresh Pocket account therefore has no USDC row anywhere, and the Receive
// sheet handed out an address with no per-asset word of any kind.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiveSheet } from "./ReceiveSheet";
import { theme } from "../theme";
import { Ctx, type Wallet } from "../WalletProvider";
import type { PublicBalance } from "../../../../core/messages";

const ADDRESS = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";

function held(...codes: string[]): PublicBalance[] {
  return codes.map((code) => ({
    id: code === "XLM" ? "native" : `${code}:GISSUER`,
    code,
    amount: "0.0000000",
    authorized: true,
  }));
}

function render(balances: PublicBalance[] | null) {
  const value = {
    t: theme("public"),
    pocket: "public",
    status: { address: ADDRESS, network: "testnet" },
    balances,
    copy: () => undefined,
    copied: false,
  } as unknown as Wallet;
  return renderToStaticMarkup(
    <Ctx.Provider value={value}>
      <ReceiveSheet open onClose={() => undefined} />
    </Ctx.Provider>,
  );
}

describe("the address the Receive sheet hands out", () => {
  it("names what it can actually accept", () => {
    const html = render(held("XLM", "USDC"));
    expect(html).toMatch(/can receive XLM and USDC/);
  });

  it("says XLM alone when that is all the account holds", () => {
    // The default state of a fresh wallet, and the one where a USDC payment
    // bounces with nothing on screen having warned anyone.
    const html = render(held("XLM"));
    expect(html).toMatch(/can receive XLM\b/);
    expect(html).not.toMatch(/USDC/);
  });

  it("says what to do about it, not only that it is so", () => {
    const html = render(held("XLM"));
    expect(html).toMatch(/added first/i);
    expect(html).toMatch(/Your assets/);
  });

  it("claims nothing while the balances are still being read", () => {
    // Null is "not loaded yet", which is a different fact from "only XLM", and
    // rendering the second for the first would be a claim the wallet cannot
    // support.
    const html = render(null);
    expect(html).not.toMatch(/can receive/);
  });
});
