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
  PROVER_INIT_TIMEOUT_MS,
  PROVER_PROVE_TIMEOUT_MS,
  type CircuitName,
  type ProverRequest,
  type ProverResponse,
  type ProverStatus,
} from "../../core/prover/protocol";

// Resolved against the EXTENSION, not against whatever origin served this
// module. A root-relative specifier is resolved by the importing module's URL,
// and under `wxt dev` that module is served from http://localhost:3000, so the
// import went to the Vite dev server, which refuses to hand back a file it
// copies verbatim out of public/. The prover then failed to initialise and the
// private pocket could not be set up at all in a development build. An absolute
// chrome-extension:// URL is the same file in both builds and cannot be
// retargeted by where the code was served from.
const BB_PATH = chrome.runtime.getURL("vendor/bb/index.js");
/** Shared with the service-worker client so the two bounds cannot drift apart. */
const INIT_TIMEOUT_MS = PROVER_INIT_TIMEOUT_MS;
const PROVE_TIMEOUT_MS = PROVER_PROVE_TIMEOUT_MS;
/** Tearing down a wedged instance can itself wedge, so even that is bounded. */
const DESTROY_TIMEOUT_MS = 5_000;

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
  // The timer is cleared on both paths. This document is created once and kept
  // warm for the life of the extension, so a two-minute timer left armed per
  // proof accumulates for as long as the user keeps the wallet open.
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
  (msg: ProverRequest, sender, sendResponse: (r: ProverResponse) => void) => {
    // The most sensitive message in the system arrives here: a solved witness,
    // which for withdraw and transfer contains sk, the amount and the blinding.
    // The service worker checks its sender; so must this, rather than resting
    // on the fact that nothing else currently listens.
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.channel !== PROVER_CHANNEL) return false;

    if (msg.kind === "status") {
      sendResponse({ id: msg.id, ok: true, kind: "status", status: status() });
      return false;
    }

    // The channel tag says who it is for, not that it is well formed. A request
    // missing its bytecode would otherwise reach atob() as undefined and fail
    // as an opaque decode error from inside the queue.
    if (
      msg.kind !== "prove" ||
      typeof msg.acir !== "string" ||
      typeof msg.witness !== "string" ||
      !(msg.circuit in PUBLIC_INPUT_COUNT)
    ) {
      sendResponse({ id: msg?.id ?? "?", ok: false, error: "malformed prover request" });
      return false;
    }

    // The service worker that asked for this may be gone by the time the proof
    // is ready: MV3 evicts it after 30 seconds of inactivity and proving can
    // outlive that. Replying into a closed channel throws, and unhandled inside
    // the queue it would surface as a bare rejection with no owner.
    const reply = (r: ProverResponse) => {
      try {
        sendResponse(r);
      } catch {
        /* the asker is gone; the next request rebuilds the channel */
      }
    };

    queued++;
    // Serial queue. Each job waits for the previous one regardless of outcome.
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        try {
          const { proof, publicInputs, ms } = await prove(msg.acir, msg.witness, msg.circuit);
          reply({ id: msg.id, ok: true, kind: "prove", proof, publicInputs, ms });
        } catch (e) {
          // A wedged prover is indistinguishable from a slow one, so tear the
          // instance down and let the next job rebuild it.
          //
          // The teardown is itself bounded, and that is the whole point: a
          // wasm worker wedged badly enough to blow the prove timeout is
          // exactly the one whose `destroy()` never resolves. Awaited
          // unbounded, that hangs INSIDE the serial queue, so the chain never
          // settles and every later proof queues behind it forever. The
          // instance is dropped either way; a destroy still running is garbage
          // we cannot collect, which is better than a prover that is
          // permanently unusable.
          if (e instanceof Error && e.message.includes("timed out")) {
            const dying = api;
            api = null;
            try {
              await withTimeout(
                Promise.resolve(dying?.destroy?.()),
                DESTROY_TIMEOUT_MS,
                "prover teardown",
              );
            } catch {
              /* already gone, or too wedged to say so */
            }
          }
          reply({
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
