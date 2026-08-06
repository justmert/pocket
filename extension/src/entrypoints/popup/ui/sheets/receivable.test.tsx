// What the Receive sheet shows.
//
// It used to draw the set of assets the address can accept as chips under the
// address, on the reasoning that a payment in an un-trustlined asset bounces
// with `op_no_trust` and nothing on the recipient's side warns them. That was
// removed deliberately: the wallet has ONE address, the sheet is the QR, the
// address and a copy button, and no per-asset word of any kind. So the sheet no
// longer makes an "accepts" claim at all, and these tests hold that line rather
// than the old chip contract, so a revert that re-adds the chips goes red here.
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

function render(balances: PublicBalance[] | null, address: string | null = ADDRESS) {
  const value = {
    t: theme("public"),
    pocket: "public",
    status: address ? { address, network: "testnet" } : null,
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

describe("the Receive sheet", () => {
  it("shows the address and no per-asset chips", () => {
    const html = render(held("XLM", "USDC"));
    expect(html).toContain(ADDRESS);
    // The sheet makes no "accepts" claim: the asset codes are not drawn.
    expect(html).not.toMatch(/>XLM</);
    expect(html).not.toMatch(/>USDC</);
  });

  it("shows the address whatever the account holds", () => {
    const html = render(held("XLM"));
    expect(html).toContain(ADDRESS);
    expect(html).not.toMatch(/>XLM</);
  });

  it("shows no address when the wallet has none", () => {
    // With no address at all the sheet cannot hand one out: it shows the danger
    // notice, and the address string appears nowhere.
    const html = render(null, null);
    expect(html).not.toContain(ADDRESS);
  });
});
