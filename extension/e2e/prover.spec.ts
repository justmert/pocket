import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Exercises the REAL prover in a real Chrome offscreen document: vendored
// bb.js, bundled SRS, no network. This is the test that proves the phase 3
// architecture works rather than merely compiles.
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "../.output/chrome-mv3");

let ctx: BrowserContext;
let id: string;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-prover-"));
  ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  id = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the vendored bb.js and SRS ship inside the package", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);
  for (const [path, minBytes] of [
    ["/vendor/bb/index.js", 400_000],
    ["/vendor/bb/barretenberg.js", 3_000_000],
    ["/vendor/bb/main.worker.js", 40_000],
    ["/vendor/srs/g1.dat", 1_000_000],
    ["/vendor/srs/g2.dat", 128],
  ] as const) {
    const size = await page.evaluate(async (p) => {
      const r = await fetch(p);
      return r.ok ? (await r.arrayBuffer()).byteLength : -1;
    }, path);
    expect(size, `${path} must ship in the package`).toBeGreaterThanOrEqual(minBytes);
  }
  await page.close();
});

test("the bundled G2 point is the one the on-chain verifier uses", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);
  const limbs = await page.evaluate(async (url) => {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const hex = (a: Uint8Array) => [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
    return [0, 32, 64, 96].map((o) => hex(b.slice(o, o + 32)));
  }, "/vendor/srs/g2.dat");

  // Same four limbs the verifier compiles into LHS_G2_BYTES, in c0||c1 order
  // where the contract stores c1||c0. Proving against a different ceremony than
  // the chain verifies against would be undetectable downstream.
  expect(limbs.sort()).toEqual(
    [
      "0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0",
      "260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1",
      "22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e55",
      "04fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4",
    ].sort(),
  );
  await page.close();
});

test("the offscreen document loads bb.js as native ESM and reports status", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);

  // Loading the vendored bundle directly is the thing that breaks when it is
  // put through a bundler: the worker URL resolves to a chunk that does not
  // exist and createMainWorker hangs with no error and no timeout.
  const probe = await page.evaluate(async () => {
    const mod = await import("/vendor/bb/index.js");
    return {
      hasBarretenberg: typeof (mod as Record<string, unknown>).Barretenberg === "function",
      isolated: self.crossOriginIsolated === true,
      cores: navigator.hardwareConcurrency,
    };
  });

  expect(probe.hasBarretenberg).toBe(true);
  // Records what the manifest's COOP/COEP keys actually achieved. Not an
  // assertion of true: bb.js falls back to single-threaded wasm when this is
  // false, so it governs speed rather than function.
  console.log(`offscreen crossOriginIsolated=${probe.isolated} cores=${probe.cores}`);
  await page.close();
});

test("initialises the prover from the bundled SRS with no network", async () => {
  test.setTimeout(180_000);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);

  const result = await page.evaluate(async () => {
    const mod = (await import("/vendor/bb/index.js")) as {
      Barretenberg: {
        new: (o: { threads: number }) => Promise<{
          srsInitSrs(p: Uint8Array, n: number, g2: Uint8Array): Promise<void>;
          getNumThreads(): Promise<number>;
        }>;
      };
      RawBuffer: new (b: Uint8Array) => Uint8Array;
    };
    const bb = await mod.Barretenberg.new({ threads: 4 });
    const g1 = new Uint8Array(await (await fetch("/vendor/srs/g1.dat")).arrayBuffer());
    const g2 = new Uint8Array(await (await fetch("/vendor/srs/g2.dat")).arrayBuffer());
    // Bundled, so nothing is fetched from the network here. RawBuffer is
    // required: a plain Uint8Array gets a length prefix and traps the wasm.
    await bb.srsInitSrs(new mod.RawBuffer(g1), g1.length / 64, new mod.RawBuffer(g2));
    return { srsPoints: g1.length / 64, threads: await bb.getNumThreads(), ok: true };
  });

  expect(result.ok).toBe(true);
  // 2^16. Sized from the largest circuit's proving SUBGROUP (32768, measured
  // with acirGetCircuitSizes), not from what `bb gates` prints. Undersizing
  // traps inside the wasm with an opaque "unreachable".
  expect(result.srsPoints).toBe(65536);
  // Cross-origin isolation held, so bb.js took the multi-threaded path.
  expect(result.threads).toBeGreaterThan(1);
  console.log(`prover threads=${result.threads}`);
  await page.close();
});

test("generates and verifies a REAL proof of the transfer circuit", async () => {
  test.setTimeout(180_000);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);

  const result = await page.evaluate(async () => {
    const mod = (await import("/vendor/bb/index.js")) as {
      Barretenberg: {
        new: (o: { threads: number }) => Promise<{
          srsInitSrs(p: Uint8Array, n: number, g2: Uint8Array): Promise<void>;
          acirProveUltraKeccakHonk(acir: Uint8Array, witness: Uint8Array): Promise<Uint8Array>;
          acirVerifyUltraKeccakHonk(proof: Uint8Array, vk: Uint8Array): Promise<boolean>;
          acirWriteVkUltraKeccakHonk(acir: Uint8Array): Promise<Uint8Array>;
        }>;
      };
      RawBuffer: new (b: Uint8Array) => Uint8Array;
    };

    const gunzip = async (b: Uint8Array): Promise<Uint8Array> => {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([b as BlobPart]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };

    // The Noir artifact's `bytecode` is base64 gzipped ACIR. bb.js's own
    // acirToUint8Array does base64-decode then decompress, and the low-level
    // API expects the result, not the compressed form.
    const artifact = await (await fetch("/vendor/circuits/target/circuit_transfer.json")).json();
    const acir = await gunzip(
      Uint8Array.from(atob(artifact.bytecode as string), (c) => c.charCodeAt(0)),
    );
    // nargo writes the witness gzipped too.
    const witness = await gunzip(
      new Uint8Array(await (await fetch("/vendor/circuits/target/w_transfer.gz")).arrayBuffer()),
    );

    const bb = await mod.Barretenberg.new({ threads: 4 });
    const g1 = new Uint8Array(await (await fetch("/vendor/srs/g1.dat")).arrayBuffer());
    const g2 = new Uint8Array(await (await fetch("/vendor/srs/g2.dat")).arrayBuffer());
    await bb.srsInitSrs(new mod.RawBuffer(g1), g1.length / 64, new mod.RawBuffer(g2));

    const t0 = performance.now();
    const proof = await bb.acirProveUltraKeccakHonk(acir, witness);
    const proveMs = Math.round(performance.now() - t0);

    const vk = await bb.acirWriteVkUltraKeccakHonk(acir);
    const verified = await bb.acirVerifyUltraKeccakHonk(proof, new mod.RawBuffer(vk));

    return { proofBytes: proof.length, vkBytes: vk.length, verified, proveMs };
  });

  console.log(
    `transfer circuit: proof=${result.proofBytes}B vk=${result.vkBytes}B ` +
      `verified=${result.verified} in ${result.proveMs}ms`,
  );

  // bb.js returns publicInputs || proof. Transfer has 24 public inputs, so the
  // raw output is 24*32 + 456*32 = 15360 bytes, and the proof the contract
  // wants is the 456-field tail.
  expect(result.proofBytes).toBe(15360);
  expect(result.proofBytes - 24 * 32).toBe(14592);
  // 1760 bytes is the on-chain VK layout, matching the committed vks/*.vk.bin.
  expect(result.vkBytes).toBe(1760);
  expect(result.verified).toBe(true);
  await page.close();
});
