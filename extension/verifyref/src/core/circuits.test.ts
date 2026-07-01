// The circuit loader, against the REAL vendored artifacts.
//
// fetch is stubbed to read the same files the extension ships, so this
// exercises the actual decode path rather than a fixture of it.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRegisterWitness } from "./witness/register";
import { circuitInputs } from "./witness/inputs";
import { deriveSk } from "./keys/sk";
import { addressToField } from "./crypto/address";
import type { Bytes } from "./vault/envelope";

const PUBLIC = resolve(import.meta.dirname, "../../public");

beforeAll(() => {
  // Serve extension-relative URLs from the package directory.
  vi.stubGlobal("fetch", async (url: string) => {
    const path = resolve(PUBLIC, url.replace(/^\//, ""));
    try {
      const body = readFileSync(path);
      return {
        ok: true,
        json: async () => JSON.parse(body.toString("utf8")),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      };
    } catch {
      return { ok: false, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
  });
});

const { BundledCircuits } = await import("./circuits");

async function registerInputs(): Promise<Record<string, bigint>> {
  const addrF = addressToField("CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6");
  const acctF = addressToField("GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7");
  const { sk } = await deriveSk(new Uint8Array(64).fill(3) as Bytes, addrF, acctF);
  return circuitInputs(buildRegisterWitness({ sk, addrF, acctF }));
}

describe("the ACIR handed to the prover", () => {
  it("is decompressed, not the base64-gzipped form the artifact stores", async () => {
    const acir = await new BundledCircuits().acir("register");
    expect(acir[0], "gzip magic must be gone").not.toBe(0x1f);
    expect(acir.length).toBeGreaterThan(1000);
  });

  it("says which circuit is missing rather than failing opaquely", async () => {
    await expect(new BundledCircuits().acir("no_such_circuit")).rejects.toThrow(/missing/);
  });
});

describe("the witness handed to the prover", () => {
  it("is decompressed, not the gzipped form noir_js returns", async () => {
    // The failure this pins is silent and expensive. bb's low-level API does
    // not reject a gzipped witness: it traps inside the wasm with
    // "RuntimeError: unreachable", naming neither the cause nor the caller.
    // It took a full live run through the popup to find, because every
    // component test passed a witness that had already been decompressed by
    // hand.
    const solved = await new BundledCircuits().solve("register", await registerInputs());
    expect(solved[0], "must not start with the gzip magic byte").not.toBe(0x1f);
    expect(solved[1]).not.toBe(0x8b);
    expect(solved.length).toBeGreaterThan(1000);
  });

  it("refuses an assignment the circuit's constraints reject", async () => {
    // Solving is also a free correctness check: a bad witness must fail here,
    // not produce a proof that fails on chain after the user has signed.
    const bad = { ...(await registerInputs()), y_x: 12345n };
    await expect(new BundledCircuits().solve("register", bad)).rejects.toThrow();
  });
});
