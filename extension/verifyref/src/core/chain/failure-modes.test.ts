// What a user sees when a dependency misbehaves.
//
// Every case here induces the failure against a real socket rather than
// asserting on a mock's call log: a local server on port 0 is hermetic, needs
// no network, and costs milliseconds, so this belongs in the default suite.
// Reasoning about the code cannot find these; running it can. The RPC returning
// HTML with a 200 and the RPC answering about a different account were both
// found this way and neither was visible from reading balances.ts.
//
// The property being defended, above all others: a balance is never rendered
// from a response we could not verify. An error on screen is recoverable, a
// confident wrong number is not.
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rpc } from "@stellar/stellar-sdk";
import "../../lib/polyfill";
import { readNative, AccountNotFoundError } from "./balances";
import { withRequestDeadline, RPC_HTTP_TIMEOUT_MS } from "./http";
import { describeError } from "../dispatch";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/** The generic string describeError falls back to. Nothing may be more specific. */
const GENERIC = "Something went wrong. Try again, and check your connection.";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server answering every request identically, so the real client parses it. */
async function rpcServing(
  body: string,
  status = 200,
  contentType = "application/json",
): Promise<rpc.Server> {
  const url = await listen((_q, r) => {
    r.writeHead(status, { "content-type": contentType });
    r.end(body);
  });
  return new rpc.Server(url, { allowHttp: true });
}

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });
}

const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

describe("a degraded RPC must never produce a balance", () => {
  // controller.balances() renders 0.0000000 for AccountNotFoundError and
  // rethrows everything else. So the whole guarantee reduces to: nothing but a
  // genuinely absent ledger entry may raise AccountNotFoundError.

  it("refuses a 429 rather than reporting the account absent", async () => {
    const server = await rpcServing("Too Many Requests", 429, "text/plain");
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses an HTML error page served with a 200", async () => {
    // A captive portal or a proxy. The status says fine, the body is not JSON,
    // and a client that shrugs at this shows a funded user a zero.
    const server = await rpcServing("<html><body>proxy error</body></html>", 200, "text/html");
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses a JSON-RPC error object", async () => {
    const server = await rpcServing(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }),
    );
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses result: null", async () => {
    const server = await rpcServing(ok(null));
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses a result with no entries field at all", async () => {
    const server = await rpcServing(ok({ latestLedger: 9 }));
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses a dead port", async () => {
    const server = new rpc.Server("http://127.0.0.1:1", { allowHttp: true });
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("treats an empty entries array as the ONE shape meaning absent", async () => {
    // This is the only path allowed to reach the zero rendering, and it is the
    // RPC's canonical "no such ledger entry". Every case above must not reach
    // it; this one must.
    const server = await rpcServing(ok({ entries: [], latestLedger: 9 }));
    await expect(readNative(server, ACCOUNT)).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe("a degraded RPC must not put its own words on screen", () => {
  // describeError uses a strict NAME allowlist with no shape heuristic, so an
  // RPC-authored string cannot reach a user. These pin that end to end rather
  // than by inspection.
  const cases: [string, () => Promise<rpc.Server>][] = [
    ["429", () => rpcServing("Too Many Requests", 429, "text/plain")],
    ["HTML on 200", () => rpcServing("<html>proxy error</html>", 200, "text/html")],
    [
      "JSON-RPC error",
      () =>
        rpcServing(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "SECRET-RPC-STRING" },
          }),
        ),
    ],
    ["result: null", () => rpcServing(ok(null))],
  ];

  for (const [name, make] of cases) {
    it(`reduces ${name} to the generic message`, async () => {
      const server = await make();
      const said = await readNative(server, ACCOUNT).then(
        () => "resolved, which is itself a failure",
        (e) => describeError(e),
      );
      // Either the generic Error string or the generic non-Error string. What
      // matters is that it is one of ours and carries nothing from the wire.
      expect([GENERIC, "Something went wrong."]).toContain(said);
      expect(said).not.toContain("SECRET-RPC-STRING");
      expect(said).not.toContain("127.0.0.1");
    });
  }

  it("does not leak the host or port of a refused connection", async () => {
    const server = new rpc.Server("http://127.0.0.1:1", { allowHttp: true });
    const said = await readNative(server, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toBe(GENERIC);
  });
});

describe("a slow dependency must end, not hang", () => {
  /** Accepts the connection, then says nothing. Neither up nor down. */
  const stalling = () => listen(() => {});

  it("has no request deadline of its own, which is why one is applied", () => {
    // Pins the upstream fact the fix rests on. stellar-sdk 16.2.0 builds its
    // client with headers only, and feaxios attaches an abort signal solely
    // when `timeout` is truthy. If a future SDK ships a default, this fails and
    // tells us to re-check the value rather than silently double up.
    const bare = new rpc.Server("https://example.invalid", { allowHttp: true });
    expect(bare.httpClient.defaults.timeout ?? 0).toBe(0);
  });

  it("settles within its deadline against a server that never responds", async () => {
    const server = withRequestDeadline(new rpc.Server(await stalling(), { allowHttp: true }), 300);
    const started = Date.now();

    // The assertion that matters, and it is unchanged: it THROWS a timeout
    // rather than hanging. Without a deadline this never settles at all.
    await expect(readNative(server, ACCOUNT)).rejects.toThrow(/timeout/i);

    // The wall-clock bound is deliberately loose. This originally asserted
    // under 5s with a 15s test budget and passed alone while failing in the
    // full parallel run: four workers each standing up local HTTP servers
    // starve the event loop, and a 300ms timer does not fire on time on a
    // saturated machine. Tightening it back would buy a flake, not a stronger
    // test, because "how promptly the timer fired" is a property of the host,
    // while "something ended it" is the property of the code.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("keeps the deadline generous enough for a real proof-verifying simulation", () => {
    // Measured against live testnet, five runs each: getHealth 140-249ms,
    // getAccount 143-157ms, getLatestLedger 377-398ms, simulate
    // confidential_balance 155-169ms. This bounds a hang; it does not police
    // latency, and a value that fires on a merely slow testnet would break real
    // operations.
    expect(RPC_HTTP_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});
