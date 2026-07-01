import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addressToField } from "./address";

const f = JSON.parse(
  readFileSync(join(import.meta.dirname, "testdata", "address_to_field.json"), "utf8"),
);

describe("address_to_field, against the committed fixture", () => {
  for (const v of f.vectors) {
    it(`compresses ${v.inputs.strkey.slice(0, 1)}... correctly`, () => {
      const out = addressToField(v.inputs.strkey);
      expect("0x" + out.toString(16).padStart(64, "0")).toBe(v.output);
    });
  }

  it("covers both version bytes the host accepts", () => {
    const prefixes = f.vectors.map((v: { inputs: { strkey: string } }) => v.inputs.strkey[0]);
    expect(prefixes.sort()).toEqual(["C", "G"]);
  });

  it("distinguishes an account from a contract id", () => {
    const [g, c] = f.vectors;
    expect(addressToField(g.inputs.strkey)).not.toBe(addressToField(c.inputs.strkey));
  });

  it("rejects a wrong-length strkey rather than hashing garbage", () => {
    expect(() => addressToField("GABC")).toThrow();
  });
});
