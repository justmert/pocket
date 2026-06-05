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
  type ProveRequest,
  type ProverResponse,
  type ProverStatus,
  type StatusRequest,
} from "./protocol";

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
      // A concurrent creation elsewhere is not an error.
      if (e instanceof Error && /already/i.test(e.message)) return;
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

async function ask<T extends ProverResponse>(
  msg: ProveRequest | StatusRequest,
): Promise<Extract<T, { ok: true }>> {
  await ensureProver();
  const res = (await chrome.runtime.sendMessage(msg)) as ProverResponse | undefined;
  if (!res) throw new Error("the prover did not respond");
  if (!res.ok) throw new Error(res.error);
  return res as Extract<T, { ok: true }>;
}

/** Generate a proof. Serial by construction: the document queues internally. */
export async function prove(
  acir: Uint8Array,
  witness: Uint8Array,
): Promise<{ proof: Uint8Array; ms: number }> {
  const b64 = (b: Uint8Array) => {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  };
  const res = await ask<Extract<ProverResponse, { kind: "prove"; ok: true }>>({
    channel: PROVER_CHANNEL,
    kind: "prove",
    id: newId(),
    acir: b64(acir),
    witness: b64(witness),
  });
  const raw = atob(res.proof);
  const proof = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) proof[i] = raw.charCodeAt(i);
  return { proof, ms: res.ms };
}

export async function proverStatus(): Promise<ProverStatus> {
  const res = await ask<Extract<ProverResponse, { kind: "status"; ok: true }>>({
    channel: PROVER_CHANNEL,
    kind: "status",
    id: newId(),
  });
  return res.status;
}
