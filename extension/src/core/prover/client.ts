// Service-worker side of the prover.
//
// Exactly one offscreen document exists per extension, so this module owns its
// lifecycle and guards creation behind a module-level promise: two concurrent
// callers must not race to create it.
//
// A WORKERS-reason document has no lifetime limit, so it is created once and
// kept warm. Creating and destroying per proof would pay wasm instantiation
// every time.
import {
  PROVER_CHANNEL,
  ProverError,
  type CircuitName,
  type ProveRequest,
  type ProverResponse,
  type ProverStatus,
  type StatusRequest,
  PROVER_DEADLINE_MS,
} from "./protocol";

/** A status ping is answered synchronously, so it never waits on the queue. */
const STATUS_DEADLINE_MS = 10_000;

const OFFSCREEN_PATH = "offscreen.html";
let creating: Promise<void> | null = null;

async function hasDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

/** Create the prover document if it is not already up. Safe to call concurrently. */
export async function ensureProver(): Promise<void> {
  if (await hasDocument()) return;
  if (creating) return creating;

  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // WORKERS is the justification that exists precisely for spawning
      // workers, and unlike AUDIO_PLAYBACK it carries no 30s auto-close.
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Generates UltraHonk proofs for confidential transfers locally.",
    })
    .catch((e: unknown) => {
      // A concurrent creation elsewhere is not an error. Chrome's literal
      // message is "Only a single offscreen document may be created."
      // (extensions/browser/api/offscreen/offscreen_api.cc), which contains no
      // "already": the previous pattern rethrew on precisely the case it was
      // written to swallow.
      if (e instanceof Error && /single offscreen document|already/i.test(e.message)) return;
      throw e;
    })
    .finally(() => {
      creating = null;
    });

  return creating;
}

/** Tear the document down. Used when a proof wedges the worker. */
export async function closeProver(): Promise<void> {
  if (await hasDocument()) await chrome.offscreen.closeDocument();
}

let nextId = 0;
const newId = () => `p${++nextId}`;

/**
 * Ask the prover, with our own deadline and a way out.
 *
 * `chrome.runtime.sendMessage` never times out. The offscreen document bounds
 * each JOB, but a job that wedges the serial queue is never dequeued, so a NEXT
 * request queues behind it and its own bound never starts running. Without a
 * deadline here that request hangs forever, and the private pocket shows
 * "Proving. This takes a moment" with nothing scheduled to end it.
 *
 * Recovery is to destroy the document. Its state is entirely rebuildable: the
 * wasm re-instantiates and the SRS is bundled, so the cost of being wrong is a
 * few hundred milliseconds on the next proof, against a wallet that otherwise
 * cannot prove anything again until the browser restarts.
 */
async function ask<T extends ProverResponse>(
  msg: ProveRequest | StatusRequest,
  deadlineMs: number,
): Promise<Extract<T, { ok: true }>> {
  await ensureProver();

  let timer: ReturnType<typeof setTimeout>;
  const wedged = Symbol("wedged");
  const res = (await Promise.race([
    chrome.runtime.sendMessage(msg),
    new Promise<typeof wedged>((resolve) => {
      timer = setTimeout(() => resolve(wedged), deadlineMs);
    }),
  ]).finally(() => clearTimeout(timer))) as ProverResponse | typeof wedged | undefined;

  if (res === wedged) {
    await closeProver().catch(() => undefined);
    throw new ProverError(
      `The private operation took longer than ${Math.round(deadlineMs / 1000)}s and was stopped. Nothing was sent. Try it again.`,
    );
  }
  if (!res)
    throw new ProverError(
      "Pocket could not start the component that builds private proofs. Close and reopen the wallet, then try again.",
    );
  if (!res.ok) {
    // A job that blew its own timeout already dropped the bb instance inside
    // the document. Take the document with it: the instance is gone either way,
    // and a document whose queue may still be blocked by a teardown we could
    // not wait for is not worth keeping warm.
    if (/timed out/.test(res.error)) await closeProver().catch(() => undefined);
    // `res.error` is bb's own text and is NOT passed through: it is
    // library-authored and can carry a wasm trap string or a stack fragment.
    throw new ProverError("Pocket could not build the proof for this private operation.");
  }
  return res as Extract<T, { ok: true }>;
}

/** Generate a proof. Serial by construction: the document queues internally. */
export async function prove(
  circuit: CircuitName,
  acir: Uint8Array,
  witness: Uint8Array,
): Promise<{ proof: Uint8Array; publicInputs: Uint8Array; ms: number }> {
  const b64 = (b: Uint8Array) => {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  };
  const res = await ask<Extract<ProverResponse, { kind: "prove"; ok: true }>>(
    {
      channel: PROVER_CHANNEL,
      kind: "prove",
      id: newId(),
      circuit,
      acir: b64(acir),
      witness: b64(witness),
    },
    PROVER_DEADLINE_MS,
  );
  const bytes = (s: string) => {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };
  return { proof: bytes(res.proof), publicInputs: bytes(res.publicInputs), ms: res.ms };
}

export async function proverStatus(): Promise<ProverStatus> {
  // A status ping answers synchronously in the document, so it does not wait
  // behind the queue and needs nothing like the proving deadline.
  const res = await ask<Extract<ProverResponse, { kind: "status"; ok: true }>>(
    { channel: PROVER_CHANNEL, kind: "status", id: newId() },
    STATUS_DEADLINE_MS,
  );
  return res.status;
}
