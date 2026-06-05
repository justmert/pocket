// Messages between the service worker and the offscreen prover.
//
// Two contexts, because the platform leaves no choice: bb.js's browser path
// always spawns a Worker, and an MV3 service worker cannot nest workers. So
// proving cannot live in the worker regardless of cross-origin isolation.
export const PROVER_CHANNEL = "pocket.prover";

export interface ProveRequest {
  channel: typeof PROVER_CHANNEL;
  kind: "prove";
  id: string;
  /** Compiled ACIR bytecode, base64. */
  acir: string;
  /** Solved witness, base64 (gzipped, as nargo emits). */
  witness: string;
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
  | { id: string; ok: true; kind: "prove"; proof: string; ms: number }
  | { id: string; ok: true; kind: "status"; status: ProverStatus }
  | { id: string; ok: false; error: string };

/** Non-ZK keccak UltraHonk at bb 0.87.0 is a constant 456 field elements. */
export const EXPECTED_PROOF_BYTES = 14592;
