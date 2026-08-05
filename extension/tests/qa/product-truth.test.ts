// The document that governs every public claim has to be true of the tree.
//
// `resources/product-truth.md` §13 is "What is NOT in the product", and it
// exists so nobody writes a claim the code cannot support. A denial that has
// gone stale is worse than no list: it makes the document unusable as a check,
// and it understates the product to whoever reads it. Nine of its denials were
// contradicted by shipped screens.
//
// This is a source read in both directions: the claim is checked against the
// thing it is about.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const TRUTH = readFileSync(repo("resources/product-truth.md"), "utf8");
const DISPATCH = readFileSync(at("src/core/dispatch.ts"), "utf8");

/**
 * Each denial that has to STAY out of the document, with the evidence that it
 * is wrong. Keyed by the sentence, so a straight revert of the fix fails here.
 */
const RETIRED = [
  {
    denial: "No transaction history",
    now: () => existsSync(at("src/entrypoints/popup/ui/screens/History.tsx")),
  },
  {
    denial: "No assets other than XLM",
    now: () => existsSync(at("src/entrypoints/popup/ui/screens/ManageAssets.tsx")),
  },
  {
    denial: "No fiat values, prices, or charts",
    now: () => existsSync(at("src/entrypoints/popup/ui/Chart.tsx")),
  },
  {
    denial: "No hide-balances control",
    now: () =>
      readFileSync(at("src/entrypoints/popup/ui/WalletProvider.tsx"), "utf8").includes(
        "hideBalance",
      ),
  },
  {
    denial: "No token artwork",
    now: () => existsSync(at("src/entrypoints/popup/ui/AssetIcon.tsx")),
  },
  {
    denial: "No transaction, token, or pending detail views",
    now: () => existsSync(at("src/entrypoints/popup/ui/sheets/AssetDetailSheet.tsx")),
  },
  {
    denial: "No way to view your recovery phrase after setup",
    now: () => DISPATCH.includes('case "revealPhrase"'),
  },
  {
    denial: "No yield deposit or withdrawal screen",
    now: () => existsSync(at("src/entrypoints/popup/ui/screens/Yield.tsx")),
  },
  {
    denial: "CCTP is dormant",
    now: () => existsSync(at("src/entrypoints/popup/ui/screens/CctpSend.tsx")),
  },
];

describe("what product-truth.md says is NOT in the product", () => {
  for (const { denial, now } of RETIRED) {
    it(`does not still deny "${denial}"`, () => {
      // The premise first: if the feature really were gone the denial would be
      // correct and this test would be the wrong one to fail.
      expect(now(), `the feature behind "${denial}" is not in the tree after all`).toBe(true);
      expect(TRUTH, `product-truth.md still denies a shipped feature`).not.toMatch(
        new RegExp(`^- \\*\\*${denial.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`, "m"),
      );
    });
  }

  it("still denies the things that really are absent", () => {
    // The other direction. A document that denies nothing is as useless as one
    // that denies everything, and these are true today.
    expect(DISPATCH).not.toMatch(/case "changePassword"/);
    expect(TRUTH).toMatch(/No password change/);
    expect(TRUTH).toMatch(/No mainnet/);
    expect(TRUTH).toMatch(/signAuthEntry` and `signMessage` are refused/);
  });

  it("names the swap, which the section never mentioned in either direction", () => {
    expect(existsSync(at("src/entrypoints/popup/ui/screens/Swap.tsx"))).toBe(true);
    expect(TRUTH).toMatch(/in-app swap/i);
  });
});

/**
 * `product-information.md` is the other public-claims document, and it went
 * stale the same way.
 *
 * Its own changelog line at the top already said "yield is no longer read-only
 * (deposit and withdraw are wired)", while the body two hundred lines down
 * still said "Yield is read-only ... you cannot deposit or withdraw through the
 * interface" and a table row still answered "earn yield, deposit" with
 * "read-only; there is no deposit action". A document that contradicts itself
 * cannot be used to check a claim, which is the only thing it is for.
 */
describe("what product-information.md says is missing", () => {
  const INFO = readFileSync(repo("product-information.md"), "utf8");

  const RETIRED_INFO = [
    {
      denial: "Yield is read-only",
      now: () => existsSync(at("src/entrypoints/popup/ui/screens/Yield.tsx")),
    },
    {
      denial: "there is no history screen",
      now: () => existsSync(at("src/entrypoints/popup/ui/screens/History.tsx")),
    },
    {
      denial: "No cross-chain anything",
      now: () => existsSync(at("src/entrypoints/popup/ui/screens/CctpSend.tsx")),
    },
    {
      denial: "No way to see your recovery phrase again",
      now: () => DISPATCH.includes('case "revealPhrase"'),
    },
  ];

  for (const { denial, now } of RETIRED_INFO) {
    it(`does not still say "${denial}"`, () => {
      expect(now(), `the feature behind "${denial}" is not in the tree after all`).toBe(true);
      // The changelog at the top RECORDS that these changed, so it is allowed
      // to mention them; the body must not still assert them.
      const body = INFO.slice(INFO.indexOf("\n## "));
      expect(body, "a public-claims document denies a shipped feature").not.toContain(denial);
    });
  }

  it("still says what really is absent", () => {
    expect(INFO).toMatch(/No hardware wallet/);
    expect(INFO).toMatch(/No external security audit/);
  });
});
