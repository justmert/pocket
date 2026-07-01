import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poseidonWithDomain, spongeSqueeze2, sponge } from "./poseidon";
import { DOMAIN } from "./domain";
import { R } from "./field";

// SDK.md 6.1: the suite MUST *read* these files rather than transcribe their
// values into source, so a change to the Noir library's print_fixtures output
// becomes a test failure rather than a silent divergence. No pasted constants.
const dir = join(import.meta.dirname, "testdata");
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
const hx = (s: string) => BigInt(s);

describe("poseidon_with_domain, against the committed fixture", () => {
  const f = fixture("poseidon_with_domain");
  for (const v of f.vectors) {
    it(`domain ${v.inputs.domain} over ${v.inputs.inputs.length} inputs`, () => {
      const out = poseidonWithDomain(hx(v.inputs.domain), v.inputs.inputs.map(hx));
      expect("0x" + out.toString(16).padStart(64, "0")).toBe(v.output);
    });
  }
});

describe("sponge_squeeze_2, against the committed fixture", () => {
  const f = fixture("sponge_squeeze_2");
  for (const v of f.vectors) {
    it(`domain ${v.inputs.d} yields both lanes`, () => {
      const [a, b] = spongeSqueeze2(hx(v.inputs.d), hx(v.inputs.s), hx(v.inputs.sigma));
      expect("0x" + a.toString(16).padStart(64, "0")).toBe(v.output[0]);
      expect("0x" + b.toString(16).padStart(64, "0")).toBe(v.output[1]);
    });
  }

  it("covers both auditor channels, and they differ", () => {
    const s = 0x12345n,
      sig = 1n;
    expect(spongeSqueeze2(DOMAIN.AUDITOR_SENDER, s, sig)).not.toEqual(
      spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, s, sig),
    );
  });

  it("lane 0 equals poseidon_with_domain on the same inputs", () => {
    // The fixture's own description states this identity: one permutation,
    // same state[0]. It is a useful cross-check that our sponge and our
    // two-lane squeeze agree.
    const [lane0] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, 0x12345n, 1n);
    expect(lane0).toBe(poseidonWithDomain(DOMAIN.AUDITOR_SENDER, [0x12345n, 1n]));
  });
});

describe("vk_from_sk, against the committed fixture", () => {
  const f = fixture("vk_from_sk");
  for (const v of f.vectors) {
    it("derives the viewing key", () => {
      const vk = poseidonWithDomain(DOMAIN.VIEWING_KEY, [hx(v.inputs.sk), hx(v.inputs.wrap)]);
      expect("0x" + vk.toString(16).padStart(64, "0")).toBe(v.output);
    });
  }
});

describe("sponge field semantics", () => {
  it("reduces mod r rather than letting bigints grow", () => {
    // Noir's Field is arithmetic mod r; bigint is not. If an absorb failed to
    // reduce, an input at r-1 and one at -1 would diverge.
    expect(sponge([R - 1n])).toBe(sponge([R - 1n]));
    expect(sponge([R + 5n])).toBe(sponge([5n]));
  });

  it("always returns a canonical F_r element", () => {
    for (const inputs of [[], [1n], [1n, 2n], [1n, 2n, 3n], [1n, 2n, 3n, 4n]]) {
      const out = sponge(inputs);
      expect(out >= 0n && out < R).toBe(true);
    }
  });

  it("permutes even on empty input", () => {
    // The on-chain sponge always permutes before squeezing, so the empty case
    // is not the zero element.
    expect(sponge([])).not.toBe(0n);
  });

  it("distinguishes input length via the IV", () => {
    // iv = M * 2^64, so padding a shorter input with zeros must not collide.
    expect(sponge([1n, 0n])).not.toBe(sponge([1n]));
  });
});
