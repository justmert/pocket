// The offscreen prover, wedged.
//
// Not a network dependency, but it fails like one and it is the only dependency
// whose failure can strand the wallet permanently. `chrome.runtime.sendMessage`
// has no timeout of its own. The offscreen document bounds each JOB, but a job
// that wedges the serial queue is never dequeued, so the NEXT request queues
// behind it and its own bound never starts running. Without a deadline on the
// service-worker side that request hangs forever and the private pocket shows
// "Proving. This takes a moment" with nothing scheduled to end it.
//
// The recovery is destroying the document. Its state is entirely rebuildable, so
// the cost of being wrong is a few hundred milliseconds against a wallet that
// otherwise cannot prove anything again until the browser restarts.
//
// Time is faked here, deliberately: the shipped deadline is 165 seconds and a
// test that actually waited it out would be a test nobody runs. The constants
// themselves are asserted at their real values below.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PROVER_CHANNEL,
  PROVER_DEADLINE_MS,
  PROVER_INIT_TIMEOUT_MS,
  PROVER_PROVE_TIMEOUT_MS,
} from "../../src/core/prover/protocol";

/** How the fake offscreen document behaves for the next request. */
type Behaviour =
  | { kind: "answers"; proof: string }
  | { kind: "wedged" }
  | { kind: "silent" }
  | { kind: "jobTimedOut" }
  | { kind: "errors"; message: string };

interface Doc {
  open: boolean;
  behaviour: Behaviour;
  created: number;
  closed: number;
  sent: unknown[];
}

let doc: Doc;

const b64 = (n: number) => btoa("x".repeat(n));

function installChrome(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      id: "pocket-test",
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getContexts: async () => (doc.open ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      sendMessage: (msg: unknown) => {
        doc.sent.push(msg);
        switch (doc.behaviour.kind) {
          case "wedged":
            // The queue is blocked. The message is accepted and never answered,
            // which is exactly what a wedged bb.js worker looks like from here.
            return new Promise(() => {});
          case "silent":
            return Promise.resolve(undefined);
          case "jobTimedOut":
            return Promise.resolve({
              id: "p1",
              ok: false,
              error: "proof generation timed out after 120000ms",
            });
          case "errors":
            return Promise.resolve({ id: "p1", ok: false, error: doc.behaviour.message });
          case "answers":
            return Promise.resolve(
              (msg as { kind: string }).kind === "status"
                ? {
                    id: "p1",
                    ok: true,
                    kind: "status",
                    status: { ready: true, crossOriginIsolated: true, threads: 4, queued: 0 },
                  }
                : {
                    id: "p1",
                    ok: true,
                    kind: "prove",
                    proof: doc.behaviour.proof,
                    publicInputs: b64(32),
                    ms: 900,
                  },
            );
        }
      },
    },
    offscreen: {
      Reason: { WORKERS: "WORKERS" },
      createDocument: async () => {
        doc.open = true;
        doc.created++;
        // A fresh document has a fresh queue. Whatever wedged the old one is
        // gone with it, which is the entire reason the reset is worth doing.
        doc.behaviour = { kind: "answers", proof: b64(14_592) };
      },
      closeDocument: async () => {
        doc.open = false;
        doc.closed++;
      },
    },
  });
}

const client = await import("../../src/core/prover/client");

beforeEach(() => {
  doc = {
    open: false,
    behaviour: { kind: "answers", proof: b64(14_592) },
    created: 0,
    closed: 0,
    sent: [],
  };
  installChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run `fn`, pushing fake time forward so its deadline can fire. */
async function withDeadlineElapsed<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  vi.useFakeTimers();
  const running = fn();
  // Settle the awaits before the timer that ends it, so the race is armed.
  await vi.advanceTimersByTimeAsync(ms + 1_000);
  return running;
}

describe("a wedged prover ends the wait rather than spinning forever", () => {
  it("fires its own deadline and says the prover was reset", async () => {
    doc.behaviour = { kind: "wedged" };
    // Create the document first, so the wedge is what is under test rather than
    // the creation path.
    await client.ensureProver();
    doc.behaviour = { kind: "wedged" };

    const failure = await withDeadlineElapsed(
      () =>
        client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])).catch((e: Error) => e),
      PROVER_DEADLINE_MS,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/did not answer within \d+s and has been reset/);
  });

  it("destroys the document, so the next proof is not queued behind the wedge", async () => {
    await client.ensureProver();
    doc.behaviour = { kind: "wedged" };

    await withDeadlineElapsed(
      () => client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])).catch(() => null),
      PROVER_DEADLINE_MS,
    );
    expect(doc.closed).toBe(1);
    expect(doc.open).toBe(false);
  });

  it("proves again once the document has been rebuilt", async () => {
    // The recovery half. A wallet that fails honestly but never works again is
    // still a wallet that cannot send.
    await client.ensureProver();
    doc.behaviour = { kind: "wedged" };
    await withDeadlineElapsed(
      () => client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])).catch(() => null),
      PROVER_DEADLINE_MS,
    );
    vi.useRealTimers();

    const created = doc.created;
    const result = await client.prove("transfer", new Uint8Array([1]), new Uint8Array([2]));
    expect(doc.created).toBe(created + 1);
    expect(result.proof.length).toBe(14_592);
  });

  it("resets the document when a job reports its own timeout", async () => {
    // A job that blew its own bound already dropped the bb instance inside the
    // document. The document goes with it: the instance is gone either way, and
    // a queue that may still be blocked by a teardown nobody waited for is not
    // worth keeping warm.
    await client.ensureProver();
    doc.behaviour = { kind: "jobTimedOut" };
    await expect(
      client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])),
    ).rejects.toThrow(/timed out/);
    expect(doc.closed).toBe(1);
  });

  it("does NOT reset the document for an ordinary proving error", async () => {
    // A malformed request is not a wedge. Tearing the document down for one
    // would pay wasm instantiation again for a mistake the caller made.
    await client.ensureProver();
    doc.behaviour = { kind: "errors", message: "malformed prover request" };
    await expect(
      client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])),
    ).rejects.toThrow(/malformed prover request/);
    expect(doc.closed).toBe(0);
  });

  it("says the prover did not respond when the channel answers with nothing", async () => {
    await client.ensureProver();
    doc.behaviour = { kind: "silent" };
    await expect(
      client.prove("transfer", new Uint8Array([1]), new Uint8Array([2])),
    ).rejects.toThrow(/did not respond/);
  });

  it("bounds a status ping too, so a wedge cannot hide behind it", async () => {
    await client.ensureProver();
    doc.behaviour = { kind: "wedged" };
    const failure = await withDeadlineElapsed(
      () => client.proverStatus().catch((e: Error) => e),
      15_000,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/did not answer within/);
  });
});

describe("the deadlines are ordered so a slow proof is not killed as a wedged one", () => {
  it("gives the service worker more room than init plus prove", () => {
    // A bound that fired on a merely slow proof would be worse than none: it
    // would destroy a working prover mid-job on every large circuit.
    expect(PROVER_DEADLINE_MS).toBeGreaterThan(PROVER_INIT_TIMEOUT_MS + PROVER_PROVE_TIMEOUT_MS);
  });

  it("stays under the platform's five-minute cap on a single request", () => {
    // Past that, Chrome kills the request silently and the user is told the
    // wallet did not respond rather than that proving timed out.
    expect(PROVER_DEADLINE_MS).toBeLessThan(300_000);
  });

  it("keeps every request on the prover channel, so nothing else answers it", async () => {
    await client.ensureProver();
    await client.prove("transfer", new Uint8Array([1]), new Uint8Array([2]));
    await client.proverStatus();
    expect(doc.sent.length).toBeGreaterThan(0);
    for (const m of doc.sent) {
      expect((m as { channel: string }).channel).toBe(PROVER_CHANNEL);
    }
  });
});
