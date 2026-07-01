// Deadlines for every outbound request.
//
// A dependency that is DOWN is easy: the socket refuses and the code sees an
// error. A dependency that is SLOW is the dangerous one. stellar-sdk's HTTP
// client defaults to `timeout = 0`, which its fetch adapter reads as "attach no
// abort signal", so a server that accepts the connection and then says nothing
// leaves the promise pending forever. Observed: an RPC that never answers left
// `readNative` unsettled past 8 seconds with nothing scheduled to end it.
//
// In the popup that is a spinner with no exit. In the service worker it is
// worse: MV3 eventually kills the worker, the popup's sendMessage resolves to
// nothing, and the user is told the wallet did not respond rather than that the
// network is slow. A bounded wait is the difference between an honest error and
// a wallet that looks broken.
import type { rpc } from "@stellar/stellar-sdk";

/**
 * Ceiling for one RPC request.
 *
 * Sized against the slowest call the wallet makes, which is simulating a
 * proof-verifying invocation, not against a plain read. Generous on purpose:
 * this exists to bound a hang, not to police latency, and a timeout that fires
 * on a merely slow testnet would break real operations.
 */
export const RPC_HTTP_TIMEOUT_MS = 30_000;

/** Ceiling for one archive or integration request. These are plain reads. */
export const SERVICE_HTTP_TIMEOUT_MS = 15_000;

/**
 * Give an RPC server a request deadline.
 *
 * Mutates the shared client's defaults rather than wrapping each call, so it
 * covers every method the server exposes, including the ones added by a future
 * SDK release. Wrapping call sites would leave whichever one was forgotten
 * hanging forever, and that is exactly the bug this prevents.
 */
export function withRequestDeadline<T extends rpc.Server>(
  server: T,
  ms: number = RPC_HTTP_TIMEOUT_MS,
): T {
  server.httpClient.defaults.timeout = ms;
  return server;
}

/**
 * An AbortSignal that fires after `ms`, for plain `fetch` callers.
 *
 * `AbortSignal.timeout` is available in every Chrome that supports MV3 and in
 * Node 18+, so there is no fallback path to keep correct.
 */
export function deadlineSignal(ms: number = SERVICE_HTTP_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}
