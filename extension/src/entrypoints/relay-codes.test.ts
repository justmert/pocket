// The relay answers a page in SEP-43's vocabulary, not JSON-RPC's.
//
// The content script sat between a page and the worker and invented its own
// error codes: -32601, -32005, -32603. SEP-43 defines exactly four (-1
// internal, -2 external, -3 invalid request, -4 user rejected), and a site
// written against the standard falls through every branch it has when handed
// one of the others.
//
// The worker's own answers already use the SEP-43 codes, so the same channel
// could return -4 for one refusal and -32603 for the next.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("./content.ts", import.meta.url)), "utf8");

describe("the error codes the content script emits", () => {
  it("uses none of JSON-RPC's", () => {
    // A source read, because a content script runs in a page's process and
    // nothing in this tier can stand one up. What regressed is a set of
    // literals, and this is the assertion that pins them.
    const jsonRpc = [...SRC.matchAll(/code:\s*(-32\d{3})/g)].map((m) => m[1]);
    expect(jsonRpc, `JSON-RPC codes a site cannot read: ${jsonRpc.join(", ")}`).toEqual([]);
  });

  it("names the two it can legitimately produce", () => {
    expect(SRC).toMatch(/const SEP43_INTERNAL = -1;/);
    expect(SRC).toMatch(/const SEP43_INVALID_REQUEST = -3;/);
  });

  it("emits nothing but those, or a code the worker already set", () => {
    // Every `code:` in the file has to be one of the two constants. A bare
    // number here is the defect returning.
    const codes = [...SRC.matchAll(/code:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    expect(codes.length, "no error codes at all: the file must have changed shape").toBeGreaterThan(
      0,
    );
    for (const c of codes) {
      expect(["SEP43_INTERNAL", "SEP43_INVALID_REQUEST"], `bare code ${c}`).toContain(c);
    }
  });

  it("agrees with the worker's own table", async () => {
    // The two sides must not drift: one channel, one vocabulary.
    const { ERROR } = await import("../core/provider/sep43");
    expect(ERROR.INTERNAL).toBe(-1);
    expect(ERROR.INVALID_REQUEST).toBe(-3);
  });
});
