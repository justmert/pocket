// What the popup says when the message never reaches the worker.
//
// `chrome.runtime.sendMessage` REJECTS on a transport failure and that path was
// unguarded, so Chrome's own string reached the screen verbatim through whichever
// of the 35 `e instanceof Error ? e.message : String(e)` sites caught it. The
// authored sentence in this module only covered `!res`, which is not the path
// Chrome takes. `describeError` cannot cover this: it runs in the worker, and the
// worker is not involved when the message never arrived.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { call } from "./rpc";

const send = vi.fn();

beforeEach(() => {
  send.mockReset();
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
});

describe("a transport failure is reported in the wallet's own words", () => {
  it("names the reload case, which is the one a user actually hits", async () => {
    // An extension reloaded from chrome://extensions with the popup still open
    // says this for every press afterwards.
    send.mockRejectedValue(new Error("Extension context invalidated."));
    await expect(call({ type: "status" })).rejects.toThrow(/updated or reloaded/i);
  });

  it("names a worker that is not listening", async () => {
    send.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    await expect(call({ type: "status" })).rejects.toThrow(/not answering/i);
  });

  it("falls back to a generic sentence rather than echoing an unknown string", async () => {
    send.mockRejectedValue(new Error("some internal chrome detail 0x8004005"));
    const err = await call({ type: "status" }).catch((e: Error) => e);
    expect(err.message).toMatch(/could not reach its background service/i);
    expect(err.message, "chrome's own text must not reach the screen").not.toContain("0x8004005");
  });

  it("still passes the WORKER's authored refusal through untouched", async () => {
    // The other half. `dispatch.ts` has already made this safe by an allowlist on
    // error name, and rewriting it here would throw away the one sentence that
    // was written for the user.
    send.mockResolvedValue({ ok: false, error: "You need a trustline for this vault's asset." });
    await expect(call({ type: "status" })).rejects.toThrow("You need a trustline for this vault's asset.");
  });

  it("still handles a silent no-answer", async () => {
    send.mockResolvedValue(undefined);
    await expect(call({ type: "status" })).rejects.toThrow(/did not respond/i);
  });
});
