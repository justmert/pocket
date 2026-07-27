// A shield signs TWO transactions. The receipt showed one.
//
// `confirmPrivateOp` returns `{hash, ledger, followed}`: the deposit and the
// merge that makes the deposit spendable. Both are signed by the user, both
// cost a fee, and both sit on the ledger under their own address. The shield
// route is `screens/Move.tsx`, which read `hash` and `ledger` and dropped
// `followed` on the floor, so the field was dead in every installable build:
// the one component that rendered anything about it, `sheets/MoveSheet.tsx`,
// is not on the shield route at all.
//
// The consequence is not cosmetic. A user reconciling their account finds a
// transaction the wallet never mentioned, and a fee twice what the receipt
// accounts for, with nothing on the receipt to explain either.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEPOSIT = "a".repeat(64);
const MERGE = "b".repeat(64);

async function receipt(also?: { label: string; hash: string }) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Receipt } = await import("./flow");
  const { theme } = await import("./theme");
  return renderToStaticMarkup(
    <Receipt
      t={theme("private")}
      hash={DEPOSIT}
      also={also}
      network="testnet"
      onDone={() => undefined}
    />,
  );
}

describe("the receipt for an operation that signed two transactions", () => {
  it("carries both hashes, not just the first", async () => {
    const html = await receipt({ label: "Made spendable", hash: MERGE });
    expect(html).toContain(DEPOSIT);
    expect(html, "the second transaction the user signed is not on the receipt").toContain(MERGE);
  });

  it("gives the second one its own explorer link", async () => {
    // Copying a hash is not the same as being able to look at it. The primary
    // hash has had a link since the receipt existed.
    const html = await receipt({ label: "Made spendable", hash: MERGE });
    expect(html).toMatch(new RegExp(`href="[^"]*${MERGE}[^"]*"`));
  });

  it("names it, rather than printing a second unlabelled hash", async () => {
    const html = await receipt({ label: "Made spendable", hash: MERGE });
    expect(html).toContain("Made spendable");
  });

  it("is unchanged for an operation that signed one", async () => {
    // A send must not grow an empty row. The single-transaction receipt is
    // pinned by screenshot comparison at maxDiffPixels 0.
    const one = await receipt();
    expect(one).not.toContain(MERGE);
    expect(one).not.toContain("Made spendable");
  });
});

describe("the confirm sheet that hosts the receipt", () => {
  // The receipt can render both hashes and still show one, if the sheet that
  // owns the `result` object never passes the second along. That is exactly how
  // `followed` came to be dead: the type carried it the whole way and the last
  // hop dropped it.
  async function sheet(followed?: string) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ConfirmSheet } = await import("./flow");
    const { theme } = await import("./theme");
    return renderToStaticMarkup(
      <ConfirmSheet
        t={theme("private")}
        open
        effects={["Shield 1 XLM"]}
        busy={false}
        result={{ hash: DEPOSIT, ledger: 42, followed }}
        network="testnet"
        onApprove={() => undefined}
        onCancel={() => undefined}
        onDone={() => undefined}
        onGoHome={() => undefined}
      />,
    );
  }

  it("passes the second hash down to the receipt", async () => {
    const html = await sheet(MERGE);
    expect(html, "the sheet swallowed the second transaction").toContain(MERGE);
  });

  it("shows nothing extra when there was only one", async () => {
    expect(await sheet()).not.toContain("Made spendable");
  });
});

describe("the shield route", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");

  it("keeps the second hash the worker returned", () => {
    // `screens/Move.tsx` is what `App.tsx` mounts for `moveIn`. Rendering it
    // here would mean standing up the whole provider and the rpc channel; what
    // regressed is one destructure, and this is the assertion that pins it.
    const src = read("src/entrypoints/popup/ui/screens/Move.tsx");
    expect(src, "Move.tsx drops confirmPrivateOp's `followed` again").toMatch(
      /setResult\(\{[^}]*followed:\s*r\.followed/s,
    );
  });

  it("hands it to the sheet that draws the receipt", () => {
    const src = read("src/entrypoints/popup/ui/screens/Move.tsx");
    expect(src).toMatch(/result\?\.followed/);
  });
});
