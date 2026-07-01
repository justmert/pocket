// A dependency that can be told to misbehave, on a real socket.
//
// Nothing here stands in for wallet code. The client under test opens a real TCP
// connection to this server and parses whatever comes back, so every failure has
// the shape a real dependency produces: a refused connection, a 429, a proxy's
// HTML on a 200, a body that stops halfway, a socket that accepts and then says
// nothing. Reasoning about the client cannot find those; running it against them
// can.
//
// TLS rather than plain http because `rpc.Server` refuses an http:// URL unless
// the caller passes allowHttp, and the wallet's own construction does not. The
// point is to exercise the client the wallet actually builds, so the harness
// carries a certificate rather than the client carrying a test-only flag.
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";

/** One way a dependency can answer, or fail to. */
export type Fault =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "text"; status?: number; contentType?: string; body: string }
  /** 429 with a retry-after, the shape a rate limiter actually sends. */
  | { kind: "rateLimited"; retryAfter?: string }
  /** Accepts the connection and never answers. Neither up nor down. */
  | { kind: "stall" }
  /** Promises more bytes than it sends, then hangs up. A truncated body. */
  | { kind: "truncated"; body: string }
  /** Sends a prefix, then destroys the socket mid-body. */
  | { kind: "closeMidBody"; body: string }
  /** Destroys the connection before a single byte of response. */
  | { kind: "reset" };

/** A JSON-RPC success envelope carrying `result`. */
export const rpcOk = (result: unknown): Fault => ({
  kind: "json",
  body: { jsonrpc: "2.0", id: 1, result },
});

/** A JSON-RPC error envelope. Its `message` is the dependency's own words. */
export const rpcError = (message: string, code = -32000): Fault => ({
  kind: "json",
  body: { jsonrpc: "2.0", id: 1, error: { code, message } },
});

export interface RecordedRequest {
  path: string;
  /** The JSON-RPC method, when the body was a JSON-RPC call. */
  method?: string;
  body: string;
}

type Answer = Fault | ((req: RecordedRequest) => Fault);

export interface FaultServerOptions {
  /** Answers consumed in order, ahead of everything else. Drives recovery tests. */
  script?: Fault[];
  /** Per JSON-RPC method, so one call can fail while its neighbours succeed. */
  byMethod?: Record<string, Answer>;
  /** Everything else. */
  fallback?: Answer;
  /** Plain http instead of TLS. Only for clients that accept an http:// URL. */
  insecure?: boolean;
}

const NOT_CONFIGURED: Fault = {
  kind: "text",
  status: 500,
  body: "the fault harness was asked something the test did not configure",
};

/**
 * A self-signed certificate for 127.0.0.1, generated once per machine per day.
 *
 * Not checked in: a private key in a repository is a private key in a
 * repository, whatever the comment beside it says. Fails loudly when openssl is
 * absent rather than quietly skipping the tests that need it.
 */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = join(tmpdir(), "pocket-failure-tls");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const fresh =
    existsSync(keyPath) &&
    existsSync(certPath) &&
    Date.now() - statSync(certPath).mtimeMs < 24 * 3600_000;

  if (!fresh) {
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "2",
          "-nodes",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      );
    } catch (e) {
      throw new Error(
        `the failure harness needs openssl to generate a throwaway certificate for 127.0.0.1, ` +
          `and it could not run one: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/** A dependency under test control. Close it in an afterEach. */
export class FaultServer {
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly seen: RecordedRequest[] = [];
  private script: Fault[];
  private byMethod: Record<string, Answer>;
  private fallback: Answer;
  private origin = "";

  private constructor(opts: FaultServerOptions) {
    this.script = [...(opts.script ?? [])];
    this.byMethod = { ...(opts.byMethod ?? {}) };
    this.fallback = opts.fallback ?? NOT_CONFIGURED;

    const handler: http.RequestListener = (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let method: string | undefined;
        try {
          method = (JSON.parse(body) as { method?: string }).method;
        } catch {
          // Not every caller speaks JSON-RPC. The archive uses plain GETs.
        }
        const record: RecordedRequest = { path: req.url ?? "/", method, body };
        this.seen.push(record);
        this.answer(res, this.choose(record));
      });
    };

    this.server = opts.insecure
      ? http.createServer(handler)
      : https.createServer(certificate(), handler);
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    this.server.on("secureConnection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  static async start(opts: FaultServerOptions = {}): Promise<FaultServer> {
    const s = new FaultServer(opts);
    await new Promise<void>((ok) => s.server.listen(0, "127.0.0.1", ok));
    const { port } = s.server.address() as AddressInfo;
    s.origin = `${opts.insecure ? "http" : "https"}://127.0.0.1:${port}`;
    return s;
  }

  get url(): string {
    return this.origin;
  }

  /** Every request this server received, in order. */
  get requests(): readonly RecordedRequest[] {
    return this.seen;
  }

  /** How many times a JSON-RPC method was called. The never-resend assertion. */
  countOf(method: string): number {
    return this.seen.filter((r) => r.method === method).length;
  }

  /** Change what the dependency does, mid-test. This is how recovery is driven. */
  heal(opts: { script?: Fault[]; byMethod?: Record<string, Answer>; fallback?: Answer }): void {
    if (opts.script) this.script = [...opts.script];
    if (opts.byMethod) this.byMethod = { ...this.byMethod, ...opts.byMethod };
    if (opts.fallback) this.fallback = opts.fallback;
  }

  async close(): Promise<void> {
    // A stalled request holds its socket open, so the listener would never
    // close on its own and the test file would hang at teardown.
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }

  private choose(req: RecordedRequest): Fault {
    const next = this.script.shift();
    if (next) return next;
    const perMethod = req.method ? this.byMethod[req.method] : undefined;
    const answer = perMethod ?? this.fallback;
    return typeof answer === "function" ? answer(req) : answer;
  }

  private answer(res: http.ServerResponse, fault: Fault): void {
    const socket = res.socket;
    switch (fault.kind) {
      case "json": {
        const body = JSON.stringify(fault.body);
        res.writeHead(fault.status ?? 200, { "content-type": "application/json" });
        res.end(body);
        return;
      }
      case "text": {
        res.writeHead(fault.status ?? 200, {
          "content-type": fault.contentType ?? "text/plain",
        });
        res.end(fault.body);
        return;
      }
      case "rateLimited": {
        res.writeHead(429, {
          "content-type": "text/plain",
          "retry-after": fault.retryAfter ?? "30",
        });
        res.end("Too Many Requests");
        return;
      }
      case "stall":
        // Deliberately no write and no end. The socket stays open and the
        // client is left waiting on a dependency that is neither up nor down.
        return;
      case "truncated": {
        // A content-length longer than what is sent. The client is still
        // reading when the connection goes away.
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(fault.body) + 64),
        });
        res.write(fault.body);
        socket?.destroy();
        return;
      }
      case "closeMidBody": {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(fault.body);
        socket?.destroy();
        return;
      }
      case "reset":
        socket?.destroy();
        return;
    }
  }
}

/**
 * A port nothing listens on.
 *
 * Port 1 is privileged and unbound on every platform this runs on, so a connect
 * to it is refused immediately rather than timing out.
 */
export const DEAD_ORIGIN = "https://127.0.0.1:1";
export const DEAD_ORIGIN_HTTP = "http://127.0.0.1:1";
