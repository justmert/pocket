// Messages between the service worker and the offscreen prover.
//
// Two contexts, because the platform leaves no choice: bb.js's browser path
// always spawns a Worker, and an MV3 service worker cannot nest workers. So
// proving cannot live in the worker regardless of cross-origin isolation.
export const PROVER_CHANNEL = "pocket.prover";

/**
 * The three deadlines, shared so the two sides cannot disagree.
 *
 * `createMainWorker` awaits readiness with no timeout and no reject path, and
 * a wedged wasm worker is indistinguishable from a slow one, so every step
 * needs a bound.
 *
 * DEADLINE is the SERVICE WORKER's own bound on a whole request, and it must
 * exceed init plus prove or it would fire on a proof that was merely slow.
 * It exists because `chrome.runtime.sendMessage` has no timeout of its own: if
 * the offscreen document's serial queue is wedged, a new request queues behind
 * the wedge and the caller waits forever with a spinner and nothing scheduled
 * to end it. It also stays under the platform's 5-minute cap on a single
 * request, so our error arrives before Chrome's silent kill.
 */
export const PROVER_INIT_TIMEOUT_MS = 30_000;
export const PROVER_PROVE_TIMEOUT_MS = 120_000;
export const PROVER_DEADLINE_MS = 165_000;

export interface ProveRequest {
  channel: typeof PROVER_CHANNEL;
  kind: "prove";
  id: string;
  /** Compiled ACIR bytecode, base64. */
  acir: string;
  /** Solved witness, base64 (gzipped, as nargo emits). */
  witness: string;
  /** Which circuit, so the public inputs can be split off correctly. */
  circuit: CircuitName;
}

export interface StatusRequest {
  channel: typeof PROVER_CHANNEL;
  kind: "status";
  id: string;
}

export type ProverRequest = ProveRequest | StatusRequest;

export interface ProverStatus {
  ready: boolean;
  /** True when the document reached bb.js's multi-threaded path. */
  crossOriginIsolated: boolean;
  threads: number;
  /** Queue depth, so the UI can show backpressure rather than dropping work. */
  queued: number;
}

export type ProverResponse =
  | {
      id: string;
      ok: true;
      kind: "prove";
      /** The 456-field proof alone, base64. */
      proof: string;
      /** The circuit's public inputs, base64, split off from the raw output. */
      publicInputs: string;
      ms: number;
    }
  | { id: string; ok: true; kind: "status"; status: ProverStatus }
  | { id: string; ok: false; error: string };

/**
 * Non-ZK keccak UltraHonk at bb 0.87.0 is a constant 456 field elements, which
 * is what the on-chain verifier hardcodes as PROOF_FIELDS.
 *
 * Note bb.js's acirProveUltraKeccakHonk returns publicInputs || proof, so its
 * raw output is (numPublicInputs + 456) * 32 bytes. The two must be split
 * before submission: the contract takes the public inputs separately and would
 * reject a proof carrying them inline.
 */
export const PROOF_FIELDS = 456;
export const FIELD_BYTES = 32;
export const EXPECTED_PROOF_BYTES = PROOF_FIELDS * FIELD_BYTES; // 14592

/**
 * Public-input counts per circuit, in FIELD SLOTS, counted from the `pub Field`
 * parameters of each circuit's `main`.
 *
 * Slots, not logical values: a Grumpkin point occupies two slots. Register
 * carries four logical inputs (Y, PVK, addr_f, acct_f) but SIX slots, because
 * Y and PVK are points. Getting this wrong splits the prover's output in the
 * wrong place and produces a proof the verifier cannot read.
 */
export const PUBLIC_INPUT_COUNT = {
  register: 6,
  withdraw: 15,
  transfer: 24,
  spender_transfer: 24,
  set_spender: 24,
  revoke_spender: 19,
} as const;

export type CircuitName = keyof typeof PUBLIC_INPUT_COUNT;
