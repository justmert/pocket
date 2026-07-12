// Circle's attestation service ("Iris") for CCTP.
//
// After a burn on the source chain, Circle observes it and, once the source
// chain has reached the requested finality, publishes a signed attestation. The
// destination mint needs BOTH the raw `message` and that `attestation`. This
// client polls for them. It is keyless and read-only.
//
// A burn that Iris has not indexed yet answers 404; that is "not ready", not an
// error, so it is reported as a pending status rather than thrown.
import { deadlineSignal, SERVICE_HTTP_TIMEOUT_MS } from "../chain/http";

export interface IrisConfig {
  /** e.g. https://iris-api-sandbox.circle.com (testnet) */
  baseUrl: string;
  timeoutMs?: number;
}

export interface Attestation {
  /** Circle's status string, e.g. "complete" or "pending_confirmations". */
  status: string;
  /** True only when a complete message AND attestation are both present. */
  ready: boolean;
  /** Hex message bytes, when present. */
  message?: string;
  /** Hex attestation signature, when present and not the "PENDING" sentinel. */
  attestation?: string;
}

export class IrisError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "IrisError";
  }
}

interface IrisMessage {
  status?: unknown;
  message?: unknown;
  attestation?: unknown;
}

export class IrisClient {
  constructor(private readonly cfg: IrisConfig) {}

  /**
   * Fetch the attestation for a burn, by its source domain and source-chain tx
   * hash. Poll this until `ready` is true, then hand `message` + `attestation`
   * to the destination mint.
   */
  async attestation(sourceDomain: number, txHash: string): Promise<Attestation> {
    const path = `/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(txHash)}`;
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "GET",
        signal: deadlineSignal(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
    } catch (e) {
      const why =
        e instanceof Error
          ? e.name === "TimeoutError" || e.name === "AbortError"
            ? `no answer within ${(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS) / 1000}s`
            : e.message
          : "network error";
      throw new IrisError(`Could not reach the attestation service (${why}).`);
    }
    // Not indexed yet is a normal early state, not a failure.
    if (res.status === 404) return { status: "pending", ready: false };
    if (!res.ok) {
      throw new IrisError(`The attestation service returned ${res.status}.`, res.status);
    }
    let body: { messages?: unknown };
    try {
      body = (await res.json()) as { messages?: unknown };
    } catch {
      throw new IrisError("The attestation service sent a response Pocket could not read.");
    }
    const messages = Array.isArray(body.messages) ? (body.messages as IrisMessage[]) : [];
    const m = messages[0];
    if (!m) return { status: "pending", ready: false };
    const status = typeof m.status === "string" ? m.status : "pending";
    const message = typeof m.message === "string" ? m.message : undefined;
    // Until it is signed, `attestation` is the literal "PENDING" or absent.
    const attestation =
      typeof m.attestation === "string" && m.attestation !== "PENDING" ? m.attestation : undefined;
    return {
      status,
      ready: status === "complete" && !!message && !!attestation,
      message,
      attestation,
    };
  }
}
