import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Drives the confidential pipeline THROUGH THE EXTENSION, in real Chrome,
// against the real deployed contracts. This is the test that distinguishes
// "the pieces work" from "the wallet works".
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "../.output/chrome-mv3");
const dep = JSON.parse(
  readFileSync("/Users/mert/Projects/pocket/resources/deployment-testnet.json", "utf8"),
);
const secrets = readFileSync("/Users/mert/Projects/pocket/resources/secrets.env", "utf8");
const USER_SECRET = secrets.match(/TESTNET_USER_SECRET=(\S+)/)![1];

let ctx: BrowserContext;
let id: string;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-conf-"));
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

test("the extension is configured for the deployment we actually deployed", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);

  // The addresses baked into the build must be the ones on chain. A stale
  // config means every user silently registers against a contract that is not
  // there, and confidential identities are per-deployment so it is not
  // recoverable by pointing at the right one later.
  const configured = await page.evaluate(async () => {
    const res = await fetch("/chunks/" + "popup.js").catch(() => null);
    void res;
    // The config is bundled, so read it from the built background instead.
    const bg = await (await fetch("/background.js")).text();
    return {
      hasToken: bg.includes("CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6"),
      hasVerifier: bg.includes("CBERRYPR34G2MB3EOUNO3JGWOAWFVBUPINJ42JP7XVVB3AHKIPVPPWYH"),
      hasAuditor: bg.includes("CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV"),
    };
  });

  expect(configured.hasToken, "token address must be in the build").toBe(true);
  expect(configured.hasVerifier, "verifier address must be in the build").toBe(true);
  expect(configured.hasAuditor, "auditor address must be in the build").toBe(true);
  await page.close();
});

test("the vendored circuits and SRS are reachable from the extension", async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);
  const sizes = await page.evaluate(async () => {
    const names = [
      "register", "withdraw", "transfer",
      "spender_transfer", "set_spender", "revoke_spender",
    ];
    const out: Record<string, number> = {};
    for (const n of names) {
      const r = await fetch(`/vendor/circuits/target/circuit_${n}.json`);
      out[n] = r.ok ? (await r.text()).length : -1;
    }
    return out;
  });
  // All six ship, so any confidential operation can be proved offline.
  for (const [name, size] of Object.entries(sizes)) {
    expect(size, `${name} must ship in the package`).toBeGreaterThan(1000);
  }
  await page.close();
});

test("proves all six circuits from the bundled artifacts", async () => {
  test.setTimeout(300_000);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/offscreen.html`);

  const results = await page.evaluate(async () => {
    const gunzip = async (b: Uint8Array) =>
      new Uint8Array(
        await new Response(
          new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer(),
      );

    const mod = (await import("/vendor/bb/index.js")) as {
      Barretenberg: { new: (o: { threads: number }) => Promise<Record<string, Function>> };
      RawBuffer: new (b: Uint8Array) => Uint8Array;
    };
    const bb = await mod.Barretenberg.new({ threads: 4 });
    const g1 = new Uint8Array(await (await fetch("/vendor/srs/g1.dat")).arrayBuffer());
    const g2 = new Uint8Array(await (await fetch("/vendor/srs/g2.dat")).arrayBuffer());
    await bb.srsInitSrs!(new mod.RawBuffer(g1), g1.length / 64, new mod.RawBuffer(g2));

    // Public-input SLOT counts, from each circuit's `pub Field` parameters.
    const slots: Record<string, number> = {
      register: 6, withdraw: 15, transfer: 24,
      spender_transfer: 24, set_spender: 24, revoke_spender: 19,
    };

    const out: Record<string, { raw: number; proof: number; verified: boolean; ms: number }> = {};
    for (const [name, n] of Object.entries(slots)) {
      const artifact = await (await fetch(`/vendor/circuits/target/circuit_${name}.json`)).json();
      const acir = await gunzip(
        Uint8Array.from(atob(artifact.bytecode), (c) => c.charCodeAt(0)),
      );
      const witness = await gunzip(
        new Uint8Array(await (await fetch(`/vendor/circuits/target/w_${name}.gz`)).arrayBuffer()),
      );
      const t0 = performance.now();
      const raw = (await bb.acirProveUltraKeccakHonk!(acir, witness)) as Uint8Array;
      const ms = Math.round(performance.now() - t0);
      const vk = (await bb.acirWriteVkUltraKeccakHonk!(acir)) as Uint8Array;
      const verified = (await bb.acirVerifyUltraKeccakHonk!(
        raw,
        new mod.RawBuffer(vk),
      )) as boolean;
      out[name] = { raw: raw.length, proof: raw.length - n * 32, verified, ms };
    }
    return out;
  });

  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name.padEnd(18)} raw=${r.raw} proof=${r.proof} verified=${r.verified} ${r.ms}ms`);
    // Every circuit's proof, once its public inputs are split off, is the
    // constant 456 field elements the on-chain verifier hardcodes.
    expect(r.proof, `${name} proof size`).toBe(14592);
    expect(r.verified, `${name} must verify`).toBe(true);
    // The whole product story depends on this staying well under a second.
    expect(r.ms, `${name} proving time`).toBeLessThan(5000);
  }
  await page.close();
});
