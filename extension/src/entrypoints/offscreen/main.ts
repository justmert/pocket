// The prover. Runs in an offscreen document, which is the only extension
// context that can both spawn a Worker and reach cross-origin isolation.
//
// bb.js is loaded as NATIVE ESM from a vendored path, never through the
// bundler: its 0.87.0 browser build declares a top-level `__webpack_exports__`
// and spawns its worker from a `webpackIgnore`-marked import.meta.url, so a
// bundled copy resolves the worker to a chunk that does not exist and hangs
// forever with no error.
import {
  PROVER_CHANNEL,
  EXPECTED_PROOF_BYTES,
  FIELD_BYTES,
  PUBLIC_INPUT_COUNT,
  type CircuitName,
  type ProverRequest,
  type ProverResponse,
  type ProverStatus,
} from "../../core/prover/protocol";

const BB_PATH = "/vendor/bb/index.js";
/** createMainWorker awaits readiness with no timeout and no reject path. */
const INIT_TIMEOUT_MS = 30_000;
const PROVE_TIMEOUT_MS = 120_000;

type RawBufferCtor = new (b: Uint8Array) => Uint8Array;

interface Barretenberg {
  srsInitSrs(points: Uint8Array, numPoints: number, g2: Uint8Array): Promise<void>;
  acirProveUltraKeccakHonk(acir: Uint8Array, witness: Uint8Array): Promise<Uint8Array>;
  destroy?(): Promise<void>;
}

let api: Barretenberg | null = null;
let threads = 1;
/** Serial: bb.js worker memory is the binding constraint, so never two at once. */
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const b64ToBytes = (s: string): Uint8Array => {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

async function init(): Promise<Barretenberg> {
  if (api) return api;

  const mod = (await import(/* @vite-ignore */ BB_PATH)) as {
    Barretenberg: { new: (o: { threads: number }) => Promise<Barretenberg> };
    RawBuffer: RawBufferCtor;
  };

  // Without cross-origin isolation bb.js loads the single-threaded wasm and
  // collapses to one thread. That costs speed, not function.
  threads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;

  // No wasmPath: the 0.87.0 browser build ships no standalone .wasm file. Both
  // variants live as base64 data: URIs inside barretenberg.js and
  // barretenberg-threads.js, and bb.js's default path imports whichever it
  // needs relative to index.js. Passing a wasmPath makes it fetch a file that
  // does not exist.
  api = await withTimeout(mod.Barretenberg.new({ threads }), INIT_TIMEOUT_MS, "prover init");

  // The SRS is bundled, so nothing is fetched at proving time. That keeps us
  // clear of MV3's remote-code rules and works offline. Our circuits are
  // 2^12-2^13 gates, so this is well under a megabyte rather than the ~67 MB a
  // 2^20 circuit would need.
  const { g1, g2, numPoints } = await loadBundledSrs();
  // RawBuffer, not a plain Uint8Array. bb.js's serializeBufferable prefixes a
  // plain typed array with its length; RawBuffer passes the bytes through
  // untouched. Getting this wrong corrupts the SRS and traps inside the wasm
  // with an opaque "unreachable".
  await api.srsInitSrs(new mod.RawBuffer(g1), numPoints, new mod.RawBuffer(g2));

  return api;
}

async function loadBundledSrs(): Promise<{ g1: Uint8Array; g2: Uint8Array; numPoints: number }> {
  const [g1res, g2res] = await Promise.all([
    fetch("/vendor/srs/g1.dat"),
    fetch("/vendor/srs/g2.dat"),
  ]);
  if (!g1res.ok || !g2res.ok) {
    throw new Error("bundled SRS is missing; run `npm run vendor` before building");
  }
  const g1 = new Uint8Array(await g1res.arrayBuffer());
  const g2 = new Uint8Array(await g2res.arrayBuffer());
  return { g1, g2, numPoints: g1.length / 64 };
}

async function prove(
  acirB64: string,
  witnessB64: string,
  circuit: CircuitName,
): Promise<{ proof: string; publicInputs: string; ms: number }> {
  const bb = await init();
  const started = performance.now();
  const raw = await withTimeout(
    bb.acirProveUltraKeccakHonk(b64ToBytes(acirB64), b64ToBytes(witnessB64)),
    PROVE_TIMEOUT_MS,
    "proof generation",
  );

  // bb.js returns publicInputs || proof concatenated. The contract takes the
  // two separately, so split here rather than shipping a proof with its public
  // inputs glued to the front.
  const nPublic = PUBLIC_INPUT_COUNT[circuit];
  const split = nPublic * FIELD_BYTES;
  const publicInputs = raw.slice(0, split);
  const proof = raw.slice(split);

  // A poseidon2-transcript proof is the SAME SIZE as a keccak one at 0.87.0, so
  // this does not prove the transcript is right. It does catch an accidental ZK
  // proof (which is longer) and a public-input count that disagrees with the
  // contract. The VK hash is what pins the transcript, at the release gate.
  if (proof.length !== EXPECTED_PROOF_BYTES) {
    throw new Error(
      `proof is ${proof.length} bytes after splitting ${nPublic} public inputs, ` +
        `expected ${EXPECTED_PROOF_BYTES}. Raw output was ${raw.length} bytes. ` +
        `The prover produced something the on-chain verifier cannot read.`,
    );
  }

  return {
    proof: bytesToB64(proof),
    publicInputs: bytesToB64(publicInputs),
    ms: Math.round(performance.now() - started),
  };
}

function status(): ProverStatus {
  return {
    ready: api !== null,
    crossOriginIsolated: self.crossOriginIsolated === true,
    threads,
    queued,
  };
}

chrome.runtime.onMessage.addListener(
  (msg: ProverRequest, _sender, sendResponse: (r: ProverResponse) => void) => {
    if (msg?.channel !== PROVER_CHANNEL) return false;

    if (msg.kind === "status") {
      sendResponse({ id: msg.id, ok: true, kind: "status", status: status() });
      return false;
    }

    queued++;
    // Serial queue. Each job waits for the previous one regardless of outcome.
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          const { proof, publicInputs, ms } = await prove(msg.acir, msg.witness, msg.circuit);
          sendResponse({ id: msg.id, ok: true, kind: "prove", proof, publicInputs, ms });
        } catch (e) {
          // A wedged prover is indistinguishable from a slow one, so tear the
          // instance down and let the next job rebuild it.
          if (e instanceof Error && e.message.includes("timed out")) {
            try {
              await api?.destroy?.();
            } catch {
              /* already gone */
            }
            api = null;
          }
          sendResponse({
            id: msg.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          queued--;
        }
      });

    return true; // async response
  },
);
