import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_ICONS, tokenIconFile } from "./tokenIcons";

const tokensDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../public/tokens");

// Circle's mainnet USDC issuer, and a same-code impostor. The whole point of the
// feature is that the first wears Circle's logo and the second cannot.
const USDC_REAL = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_SPOOF = "USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("tokenIconFile", () => {
  it("gives native XLM a logo", () => {
    expect(tokenIconFile("native")).toBeTruthy();
  });

  it("gives the verified USDC issuer a logo", () => {
    expect(tokenIconFile(USDC_REAL)).toBeTruthy();
  });

  it("gives a USDC from any other issuer no logo, so it cannot wear Circle's mark", () => {
    // this is the anti-spoof property: same code, wrong issuer, nothing shipped.
    expect(tokenIconFile(USDC_SPOOF)).toBeNull();
  });

  it("gives an unknown asset no logo", () => {
    expect(tokenIconFile("WAT:GABC")).toBeNull();
    expect(tokenIconFile("")).toBeNull();
  });

  it("is keyed on the full id, never the bare code", () => {
    // "USDC" alone must never resolve; only "CODE:ISSUER" (or "native") can.
    expect(tokenIconFile("USDC")).toBeNull();
  });
});

describe("the vendored map and files agree", () => {
  it("every mapped file exists in public/tokens", () => {
    for (const [id, file] of Object.entries(TOKEN_ICONS)) {
      expect(existsSync(join(tokensDir, file)), `${id} -> ${file} missing`).toBe(true);
    }
  });

  it("leaves no orphan files behind (removed assets do not linger)", () => {
    const referenced = new Set(Object.values(TOKEN_ICONS));
    for (const f of readdirSync(tokensDir)) {
      expect(referenced.has(f), `${f} is on disk but unreferenced`).toBe(true);
    }
  });
});
