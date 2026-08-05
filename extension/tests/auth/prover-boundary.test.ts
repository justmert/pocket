// The offscreen prover's own boundary.
//
// The most sensitive message in the system arrives here: a solved witness, which
// for withdraw and transfer contains the spending key, the amount and the
// blinding. The service worker checks its sender; so must this, rather than
// resting on the fact that nothing else currently listens.
//
// Two separate checks, and both have to hold on their own: the sender must be
// this extension, and the message must carry the prover's channel tag. The
// second is not security, it is routing, but a document that answered untagged
// traffic would be answering the wallet's own messages.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../src/lib/polyfill";
import { EXTENSION_ID, POPUP_SENDER } from "./_harness/chrome";
import { PROVER_CHANNEL } from "../../src/core/prover/protocol";

type Listener = (
  msg: unknown,
  sender: { id?: string },
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

const listeners: Listener[] = [];

vi.stubGlobal("chrome", {
  runtime: {
    id: EXTENSION_ID,
    // The document resolves the vendored bb.js bundle through the extension
    // rather than through whatever origin served the module, so this is on the
    // import path and a fake without it fails at load with "not a function".
    getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
  },
});
vi.stubGlobal("performance", { now: () => 0 });
// The document reads `self.crossOriginIsolated` when reporting status. In a
// browser `self` is the global; node has no such alias, so give it one rather
// than let a missing binding look like a boundary failure.
vi.stubGlobal("self", globalThis);

await import("../../src/entrypoints/offscreen/main");

/** Deliver a message the way the browser would, and report what came back. */
function deliver(
  msg: unknown,
  sender: { id?: string } = POPUP_SENDER,
): { answered: boolean; async: boolean; reply: unknown } {
  let reply: unknown;
  let answered = false;
  let async = false;
  for (const l of listeners) {
    const r = l(msg, sender, (x) => {
      answered = true;
      reply = x;
    });
    if (r === true) async = true;
  }
  return { answered, async, reply };
}

const proveRequest = () => ({
  channel: PROVER_CHANNEL,
  kind: "prove",
  id: "p1",
  circuit: "transfer",
  acir: "AAAA",
  // Stand-in for a solved witness. Never a real one, and never logged.
  witness: "AAAA",
});

beforeEach(() => {
  expect(listeners.length, "the prover registered no listener").toBeGreaterThan(0);
});

describe("the prover answers nobody but this extension", () => {
  it("ignores a prove request from another extension", () => {
    const got = deliver(proveRequest(), { id: "some-other-extension" });
    expect(got.answered).toBe(false);
    expect(got.async).toBe(false);
  });

  it("ignores a prove request with no sender id", () => {
    const got = deliver(proveRequest(), {});
    expect(got.answered).toBe(false);
    expect(got.async).toBe(false);
  });

  it("ignores a status request from another extension", () => {
    const got = deliver({ channel: PROVER_CHANNEL, kind: "status", id: "s1" }, { id: "evil" });
    expect(got.answered).toBe(false);
  });

  it("answers its own extension's status request", () => {
    const got = deliver({ channel: PROVER_CHANNEL, kind: "status", id: "s1" });
    expect(got.answered).toBe(true);
    expect(got.reply).toMatchObject({ id: "s1", ok: true, kind: "status" });
  });
});

describe("the prover answers nothing that is not addressed to it", () => {
  it("ignores a wallet request that happens to reach this document", () => {
    // The wallet and the prover share one runtime channel. A document that
    // answered `{type:"balances"}` would be replying on the worker's behalf.
    for (const msg of [
      { type: "status" },
      { type: "balances" },
      { type: "confirmPayment", handle: "h" },
    ]) {
      const got = deliver(msg);
      expect(got.answered, `answered ${JSON.stringify(msg)}`).toBe(false);
      expect(got.async).toBe(false);
    }
  });

  it("ignores a message with the wrong channel tag", () => {
    const got = deliver({ ...proveRequest(), channel: "not.the.prover" });
    expect(got.answered).toBe(false);
  });

  it("ignores a message with no channel at all", () => {
    expect(deliver({ kind: "prove", id: "p1" }).answered).toBe(false);
    expect(deliver({}).answered).toBe(false);
    expect(deliver(null).answered).toBe(false);
    expect(deliver("prove").answered).toBe(false);
  });
});

describe("a tagged request from us is still checked for shape", () => {
  // The channel tag says who it is for, not that it is well formed. A request
  // missing its bytecode would otherwise reach atob() as undefined and fail as
  // an opaque decode error from inside the serial queue.
  const malformed: [string, Record<string, unknown>][] = [
    [
      "no acir",
      { channel: PROVER_CHANNEL, kind: "prove", id: "p", circuit: "transfer", witness: "AA" },
    ],
    [
      "no witness",
      { channel: PROVER_CHANNEL, kind: "prove", id: "p", circuit: "transfer", acir: "AA" },
    ],
    [
      "acir that is not a string",
      {
        channel: PROVER_CHANNEL,
        kind: "prove",
        id: "p",
        circuit: "transfer",
        acir: 1,
        witness: "AA",
      },
    ],
    [
      "an unknown circuit",
      {
        channel: PROVER_CHANNEL,
        kind: "prove",
        id: "p",
        circuit: "drain",
        acir: "AA",
        witness: "AA",
      },
    ],
    [
      "no circuit at all",
      { channel: PROVER_CHANNEL, kind: "prove", id: "p", acir: "AA", witness: "AA" },
    ],
  ];

  for (const [name, msg] of malformed) {
    it(`refuses ${name}, synchronously and by name`, () => {
      const got = deliver(msg);
      expect(got.answered).toBe(true);
      expect(got.reply).toMatchObject({ ok: false, error: "malformed prover request" });
      // Refused before the queue, so a bad request cannot occupy the prover.
      expect(got.async).toBe(false);
    });
  }

  it("says nothing about the witness in its refusal", () => {
    // SDK.md 13 forbids witness values reaching a log or a UI string
    // absolutely. The refusal is a fixed sentence for exactly that reason.
    const got = deliver({
      channel: PROVER_CHANNEL,
      kind: "prove",
      id: "p",
      circuit: "drain",
      acir: "SECRET-ACIR",
      witness: "SECRET-WITNESS",
    });
    const text = JSON.stringify(got.reply);
    expect(text).not.toContain("SECRET-WITNESS");
    expect(text).not.toContain("SECRET-ACIR");
  });
});
