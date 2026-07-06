// What a real web page can reach, asked in a real browser.
//
// Every other file in this slice drives the worker directly. That is the right
// way to test the rules, and it is the wrong way to test the BOUNDARY, because
// the boundary is enforced by Chrome and Chrome is the one thing a node process
// cannot stand in for. A manifest assertion says what we asked for; only a page
// says what we got.
//
// This spec was originally going to prove "a web page cannot reach the worker
// at all". That stopped being true mid-pass, when a SEP-43 provider landed with
// a content script matching every http and https URL. So the question changed
// from "can a page reach the worker" to "what exactly can it reach, and what
// does the worker do about it", which is a better question and a worse
// starting position: the sender check in `background.ts` used to be defence in
// depth behind an empty manifest, and is now load-bearing.
//
// The page is served by a real HTTP server on a real port, because the content
// script's `matches` are http and https and a `data:` or `file:` URL would
// silently not inject, which would make every assertion below pass for the
// wrong reason. `serves the provider at all` exists to catch exactly that.
import { test, expect } from "@playwright/test";
import { launchWallet, askWorker, type Harness } from "../support/extension";
import { Wallet } from "../support/wallet";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";

const PASSWORD = "correct horse battery staple";

/** A real origin, so the content script's http match actually fires. */
async function serveBlankPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // `/frame` is a second real page on the same origin, used as an iframe so
    // the subframe questions are asked about a frame content scripts could
    // actually be injected into.
    res.end(
      req.url === "/frame"
        ? "<!doctype html><title>a frame</title><body><p>a frame</p></body>"
        : "<!doctype html><title>a website</title><body><h1>a website</h1></body>",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((r) => {
        // `close()` stops accepting and then WAITS for open connections, and
        // Chromium holds the page's socket open with keep-alive. Without this
        // the first spec hung for its full fifteen-minute timeout after the
        // assertions had already passed, which reads exactly like a wallet bug
        // and is not one.
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface Site {
  harness: Harness;
  page: Page;
  origin: string;
  close: () => Promise<void>;
}

/** The extension loaded, and one ordinary website open beside it. */
async function openSite(): Promise<Site> {
  const harness = await launchWallet();
  const site = await serveBlankPage();
  const page = await harness.context.newPage();
  await page.goto(site.url);
  // The provider is injected by a content script at document_start, so it is
  // there by the time load fires. Waiting on the real condition rather than a
  // sleep, and failing loudly if it never arrives.
  await page.waitForFunction(() => "pocket" in window, undefined, { timeout: 15_000 });
  return {
    harness,
    page,
    origin: new URL(site.url).origin,
    close: async () => {
      await site.close();
      await harness.close();
    },
  };
}

/** Call the page's own provider, the way a dApp does. */
async function ask(page: Page, method: string, params: unknown[] = []) {
  return page.evaluate(
    async ([m, p]) => {
      const provider = (window as unknown as { pocket: Record<string, unknown> }).pocket;
      const fn = provider[m as string] as (...a: unknown[]) => Promise<unknown>;
      return fn(...(p as unknown[]));
    },
    [method, params] as const,
  );
}

test.describe("an ordinary website, with the wallet installed", () => {
  test("serves the provider at all, so nothing below passes vacuously", async () => {
    const site = await openSite();
    try {
      const shape = await site.page.evaluate(() => {
        const p = (window as unknown as { pocket?: Record<string, unknown> }).pocket;
        return {
          present: typeof p === "object" && p !== null,
          methods: p ? Object.keys(p).sort() : [],
          frozen: p ? Object.isFrozen(p) : false,
        };
      });
      expect(shape.present).toBe(true);
      expect(shape.methods).toEqual([
        "getAddress",
        "getNetwork",
        "signAuthEntry",
        "signMessage",
        "signTransaction",
      ]);
      // Frozen, so a second script on the page cannot swap a method out and
      // impersonate the wallet to the first one.
      expect(shape.frozen).toBe(true);
    } finally {
      await site.close();
    }
  });

  test("cannot reach the service worker directly, only through the relay", async () => {
    const site = await openSite();
    try {
      // No `externally_connectable`, so even knowing the extension id, a page
      // has no channel of its own. This is the assertion the manifest test can
      // only approximate.
      const reached = await site.page.evaluate(async (id) => {
        const c = (window as unknown as { chrome?: Record<string, unknown> }).chrome;
        const runtime = c?.runtime as
          | { sendMessage?: (...a: unknown[]) => Promise<unknown> }
          | undefined;
        if (!runtime?.sendMessage) return "no runtime channel in the page at all";
        try {
          return JSON.stringify(await runtime.sendMessage(id, { type: "status" }));
        } catch (e) {
          return `refused: ${(e as Error).message}`;
        }
      }, site.harness.extensionId);
      expect(reached).not.toContain('"ok":true');
      expect(reached).not.toMatch(/G[A-Z2-7]{55}/);
    } finally {
      await site.close();
    }
  });

  test("is told nothing about the owner before a wallet even exists", async () => {
    const site = await openSite();
    try {
      const res = (await ask(site.page, "getAddress")) as { error?: { message: string } };
      expect(res.error, "a wallet-less browser answered getAddress").toBeTruthy();
      expect(JSON.stringify(res)).not.toMatch(/G[A-Z2-7]{55}/);
    } finally {
      await site.close();
    }
  });

  test("is told nothing about the owner of an UNLOCKED wallet it has not been connected to", async () => {
    // The one that matters. A wallet sitting unlocked in the toolbar is the
    // normal state while somebody browses, and every page they visit is
    // running this call.
    const site = await openSite();
    try {
      await new Wallet(site.harness.popup).createWallet(PASSWORD);

      const res = (await ask(site.page, "getAddress")) as { error?: { message: string } };
      expect(res.error, "an unlocked wallet handed its address to an unconnected site").toBeTruthy();
      expect(JSON.stringify(res)).not.toMatch(/G[A-Z2-7]{55}/);
      // And it says what to do, rather than failing silently.
      expect(res.error!.message).toMatch(/not connected|open pocket/i);
    } finally {
      await site.close();
    }
  });

  test("cannot get a signature even WITH a live grant, which is the whole point of a grant", async () => {
    // Written first without the connect step, and it passed for the wrong
    // reason: with no grant, `sep43` refuses at the grant check and never
    // reaches the signing branch at all. Building an extension whose provider
    // happily returned `{signedTxXdr}` left this test green. So the site is
    // connected first, deliberately, and the refusal is then asserted to be the
    // SIGNING refusal rather than the not-connected one.
    //
    // Connecting is done through the worker because it is setup, not the
    // subject: granting is the popup's job and a page cannot do it, which
    // `cannot smuggle a wallet request through the relay's channel` is the test
    // that actually proves.
    const site = await openSite();
    try {
      await new Wallet(site.harness.popup).createWallet(PASSWORD);
      await askWorker(site.harness.popup, { type: "connectDapp", origin: site.origin });

      for (const [method, params] of [
        ["signTransaction", ["AAAAAgAAAAA", {}]],
        ["signAuthEntry", ["AAAAAgAAAAA", {}]],
        ["signMessage", ["hello", {}]],
      ] as const) {
        const res = (await ask(site.page, method, [...params])) as {
          error?: { message: string };
          signedTxXdr?: string;
        };
        expect(res.signedTxXdr, `${method} returned something signed`).toBeUndefined();
        expect(res.error, `${method} did not refuse`).toBeTruthy();
        // The branch that must have run. Without this the test cannot tell a
        // signing policy from a missing grant.
        //
        // Two refusals prove it, not one. `signTransaction` is handed a
        // deliberately unreadable envelope, and the wallet stops at the decode
        // rather than at the policy, which is the designed order: it will not
        // offer to sign what it cannot show. Both sentences are the signing
        // branch; "not connected" is the one that would mean the grant never
        // took, and neither of these is that.
        expect(res.error!.message, `${method} refused for the wrong reason`).toMatch(
          /does not sign|cannot show you|could not read this transaction/i,
        );
      }

      // And the grant really was live, or everything above is vacuous again.
      const withGrant = (await ask(site.page, "getAddress")) as { address?: string };
      expect(withGrant.address, "the grant was not live, so the refusals prove nothing").toMatch(
        /^G[A-Z2-7]{55}$/,
      );
    } finally {
      await site.close();
    }
  });

  test("gets the network, which is about the wallet and not about the user", async () => {
    // The one call that IS answered to anyone. Pinned so that "it answers
    // nothing" is never assumed, and so the set of things it does answer stays
    // a decision rather than a drift.
    const site = await openSite();
    try {
      const res = (await ask(site.page, "getNetwork")) as {
        networkPassphrase?: string;
        error?: unknown;
      };
      expect(res.error).toBeFalsy();
      expect(res.networkPassphrase).toBe("Test SDF Network ; September 2015");
      expect(JSON.stringify(res)).not.toMatch(/G[A-Z2-7]{55}/);
    } finally {
      await site.close();
    }
  });

  test("cannot smuggle a wallet request through the relay's channel", async () => {
    // The provider is frozen, so a hostile page talks to the relay directly.
    // The relay forwards a fixed vocabulary; `{type:"reset"}` and friends must
    // not survive the trip, and neither must a SEP-43 method nobody wrote.
    const site = await openSite();
    try {
      await new Wallet(site.harness.popup).createWallet(PASSWORD);

      const replies = await site.page.evaluate(async () => {
        const CHANNEL = "pocket:sep43";
        const send = (payload: Record<string, unknown>) =>
          new Promise<unknown>((resolve) => {
            const id = `smuggle-${Math.random()}`;
            const onReply = (e: MessageEvent) => {
              const d = e.data as { channel?: string; id?: string; result?: unknown };
              if (d?.channel !== `${CHANNEL}:reply` || d.id !== id) return;
              window.removeEventListener("message", onReply);
              resolve(d.result);
            };
            window.addEventListener("message", onReply);
            window.postMessage({ channel: CHANNEL, id, ...payload }, window.location.origin);
            setTimeout(() => {
              window.removeEventListener("message", onReply);
              resolve("no answer");
            }, 5_000);
          });

        return {
          reset: await send({ method: "reset", params: ["pw"] }),
          connect: await send({ method: "connectDapp", params: ["https://evil.test"] }),
          unlock: await send({ method: "unlock", params: ["pw"] }),
          invented: await send({ method: "exportSeed", params: [] }),
        };
      });

      for (const [name, reply] of Object.entries(replies)) {
        const text = JSON.stringify(reply);
        expect(text, `${name} was not refused`).toContain("error");
        expect(text, `${name} leaked an address`).not.toMatch(/G[A-Z2-7]{55}/);
      }
      // A site granting itself a session is the one that would matter most, so
      // it is named rather than left to the loop.
      expect(JSON.stringify(replies.connect)).toMatch(/unsupported method/i);
    } finally {
      await site.close();
    }
  });

  test("a frame on the page cannot borrow the top frame's relay", async () => {
    // The relay ignores anything whose source is not this window, and it is not
    // injected into subframes at all. Both are checked, because either one
    // alone would let an ad iframe speak for the page the user trusts.
    const site = await openSite();
    try {
      const fromFrame = await site.page.evaluate(async (frameUrl) => {
        const iframe = document.createElement("iframe");
        // A REAL http frame, not `about:blank`. Content scripts do not run in
        // about:blank frames without `match_about_blank`, so an about:blank
        // frame reports "no provider here" whatever the manifest says, and the
        // assertion below would hold even for a build that injected into every
        // frame. Measured: flipping the content script to `allFrames: true`
        // left this test green until the frame became a real origin.
        iframe.src = frameUrl;
        const loaded = new Promise((r) => iframe.addEventListener("load", r, { once: true }));
        document.body.appendChild(iframe);
        await loaded;
        const win = iframe.contentWindow!;
        const hasProvider = "pocket" in win;

        const answered = new Promise<boolean>((resolve) => {
          const onReply = (e: MessageEvent) => {
            const d = e.data as { channel?: string; id?: string };
            if (d?.channel === "pocket:sep43:reply" && d.id === "frame-1") resolve(true);
          };
          window.addEventListener("message", onReply);
          setTimeout(() => resolve(false), 3_000);
        });

        // The post has to happen INSIDE the frame, or `e.source` is the top
        // window and the relay answers it correctly. Calling
        // `frame.contentWindow.parent.postMessage(...)` from here does NOT do
        // that: the source of a MessageEvent comes from the calling realm, and
        // `page.evaluate` runs in the top frame. Written that way first, this
        // test failed, and it was right to: it was asserting about a message
        // the page itself had sent.
        const script = win.document.createElement("script");
        script.textContent =
          'window.parent.postMessage({channel:"pocket:sep43",id:"frame-1",' +
          'method:"getAddress",params:[]}, "*")';
        win.document.body.appendChild(script);

        return { hasProvider, answered: await answered };
      }, `${site.origin}/frame`);
      expect(fromFrame.hasProvider, "the provider was injected into a subframe").toBe(false);
      expect(fromFrame.answered, "the relay answered a subframe").toBe(false);
    } finally {
      await site.close();
    }
  });
});
