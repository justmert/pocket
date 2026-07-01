// The dApp surface, which is the first time this wallet answers anyone but its
// own popup.
//
// It arrived mid-pass and it changes the threat model. Until now every message
// came from an extension page, and `sender.id` was the whole boundary. A content
// script is ALSO the extension by that measure, so `sender.id` no longer says
// anything about who is really asking. What replaces it is the origin Chrome
// stamps on the message, which a page cannot forge, plus a standing grant the
// user gave that exact origin.
//
// Three questions, in order of how much they cost if answered wrongly:
//   1. Can a site reach anything while the wallet is LOCKED?
//   2. Can a site reach anything without a grant from the user?
//   3. Can a site with a grant get a signature without an approval screen?
//
// The `sep43` branch in `background.ts` sits BEFORE the locked-state gate, so
// question 1 is not covered by the generic allowlist and has to be asked here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../../src/lib/polyfill";
import { installChrome, EXTENSION_ID } from "./_harness/chrome";

const chrome = installChrome();

await import("../../src/entrypoints/background");
const { clearSession } = await import("../../src/core/session");
const { KEYS } = await import("../../src/lib/storage");
const { SESSION_TTL_MS, senderOrigin, OriginRefusedError, connect, sessionFor } = await import(
  "../../src/core/provider/session"
);

const PASSWORD = "correct horse battery staple";
const SITE = "https://dapp.example";
const OTHER = "https://evil.example";

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  chrome.alarms.clear();
  chrome.alarmHistory.length = 0;
  clearSession();
});
afterEach(() => clearSession());

/** A message from the relay: our own extension id, plus a browser-stamped origin. */
const fromSite = (method: string, origin = SITE, params: unknown[] = []) =>
  chrome.send({ type: "sep43", method, params }, { id: EXTENSION_ID, origin }) as Promise<
    { ok: boolean; error?: string; data?: unknown } | undefined
  >;

const asPopup = (msg: Record<string, unknown>) =>
  chrome.send(msg, { id: EXTENSION_ID }) as Promise<
    { ok: boolean; error?: string; data?: unknown } | undefined
  >;

async function unlockedWallet() {
  const res = await asPopup({ type: "create", password: PASSWORD });
  expect(res?.ok, `create failed: ${res?.error}`).toBe(true);
  return (res!.data as { address: string }).address;
}

/**
 * The AUTHORED refusal, not merely "a string that mentions being locked".
 *
 * This helper exists because of a mutation result. Deleting the locked check
 * from `sep43` outright turned NOTHING red: the call fell through to
 * `requireSession()`, which throws, and the thrown message is the string
 * "wallet is locked", which satisfied a `/locked/i` assertion perfectly. The
 * tests were passing on an exception rather than on the guard.
 *
 * A SEP-43 refusal is a SUCCESSFUL message carrying an `error` object. An
 * exception escaping the branch is `{ok:false}` with a message from
 * `describeError`. Those two are trivially distinguishable, and only one of
 * them is the wallet deciding something.
 */
function authoredRefusal(res: { ok: boolean; error?: string; data?: unknown } | undefined) {
  expect(res?.ok, `the call threw instead of refusing: ${res?.error}`).toBe(true);
  const data = res!.data as { error?: { code: number; message: string } };
  expect(data.error, "answered without an error object").toBeTruthy();
  return data.error!;
}

describe("a locked wallet tells a site nothing about its owner", () => {
  it("refuses getAddress while locked", async () => {
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    await asPopup({ type: "lock" });

    const err = authoredRefusal(await fromSite("getAddress"));
    expect(err.code).toBe(-4); // USER_REJECTED: the dapp must not retry
    expect(err.message).toMatch(/locked/i);
    expect(JSON.stringify(err)).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it("refuses getAddress after a worker restart, with the grant still on disk", async () => {
    // The case that makes the locked check load-bearing rather than
    // theoretical. Locking through the button clears the grants too, so after a
    // deliberate lock there is no grant left for the locked check to stand in
    // front of. MV3 evicting the worker is different: the session dies with the
    // worker's memory and the grant, which lives in storage, does not. That is
    // the normal state of an idle browser, and it is the one where "is there a
    // session" is the only thing left saying no.
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    expect(await sessionFor(SITE), "no grant to survive the restart").toBeTruthy();

    clearSession(); // the worker died; storage did not

    expect(await sessionFor(SITE), "the grant did not survive, so this proves nothing").toBeTruthy();
    const err = authoredRefusal(await fromSite("getAddress"));
    expect(err.code).toBe(-4);
    expect(err.message).toMatch(/locked/i);
    expect(JSON.stringify(err)).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it("refuses every signing method while locked", async () => {
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    await asPopup({ type: "lock" });

    for (const method of ["signTransaction", "signAuthEntry", "signMessage"]) {
      const err = authoredRefusal(await fromSite(method, SITE, ["anything"]));
      expect(err.message, method).toMatch(/locked/i);
    }
  });

  it("answers getNetwork while locked, which is about the wallet not the user", async () => {
    // Deliberately allowed: it tells a site whether to bother, and it reveals
    // nothing a visitor could not read off the extension listing.
    const res = await fromSite("getNetwork");
    expect(res?.ok).toBe(true);
    const data = res!.data as { network: string; networkPassphrase: string };
    expect(data.network).toBe("testnet");
    expect(JSON.stringify(data)).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it("does not let a dApp call postpone the idle lock", async () => {
    // A site polling getNetwork must not hold a funded wallet open.
    await unlockedWallet();
    chrome.alarmHistory.length = 0;
    for (let i = 0; i < 5; i++) await fromSite("getNetwork");
    expect(chrome.alarmHistory.filter((a) => a.name === "pocket.autolock")).toHaveLength(0);
  });
});

describe("an unlocked wallet still tells an unconnected site nothing", () => {
  it("refuses getAddress without a grant", async () => {
    await unlockedWallet();
    const res = await fromSite("getAddress");
    const payload = JSON.stringify(res?.data ?? res);
    expect(payload).toMatch(/not connected/i);
    expect(payload).not.toMatch(/G[A-Z2-7]{55}/);
  });

  it("does not let one site borrow another site's grant", async () => {
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });

    const granted = await fromSite("getAddress", SITE);
    expect((granted!.data as { address: string }).address).toBe(address);

    const borrowed = await fromSite("getAddress", OTHER);
    const payload = JSON.stringify(borrowed?.data ?? borrowed);
    expect(payload).toMatch(/not connected/i);
    expect(payload).not.toContain(address);
  });

  it("treats http and https as different origins", async () => {
    // Same host, different scheme, and one of them cannot be trusted to be who
    // it says. The grant must not carry across.
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: "https://a.example" });
    const res = await fromSite("getAddress", "http://a.example");
    expect(JSON.stringify(res?.data ?? res)).not.toContain(address);
  });

  it("treats a subdomain as a different origin", async () => {
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: "https://a.example" });
    const res = await fromSite("getAddress", "https://evil.a.example");
    expect(JSON.stringify(res?.data ?? res)).not.toContain(address);
  });

  it("refuses when the browser did not stamp an origin at all", async () => {
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    const res = (await chrome.send(
      { type: "sep43", method: "getAddress", params: [] },
      { id: EXTENSION_ID },
    )) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not determine which site/i);
  });

  it("refuses a sandboxed frame's null origin rather than defaulting it", () => {
    // `null` is what a sandboxed iframe or a data: URL reports. Treating it as
    // an origin would give every one of them the same grant.
    expect(() => senderOrigin({ origin: "null" } as never)).toThrow(OriginRefusedError);
    expect(() => senderOrigin({} as never)).toThrow(OriginRefusedError);
    expect(() => senderOrigin({ origin: "" } as never)).toThrow(OriginRefusedError);
  });

  it("takes the origin from the browser, never from the message", async () => {
    // The page controls the payload and nothing else. A payload that claims an
    // origin must not be believed.
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    const res = (await chrome.send(
      { type: "sep43", method: "getAddress", params: [], origin: SITE },
      { id: EXTENSION_ID, origin: OTHER },
    )) as { ok: boolean; data?: unknown; error?: string };
    expect(JSON.stringify(res.data ?? res)).not.toContain(address);
  });
});

describe("a grant is a grant to ask, never a grant to sign", () => {
  it("refuses to sign for a connected site, unlocked, with a live grant", async () => {
    // The strongest position a site can be in, and it still gets nothing.
    // Signing needs an approval screen showing exactly what is being signed;
    // routing a site's bytes through a worker that signs without one is the
    // single worst thing this wallet could do.
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });

    for (const method of ["signTransaction", "signAuthEntry", "signMessage"]) {
      const res = await fromSite(method, SITE, ["AAAAAgAAAA..."]);
      const payload = JSON.stringify(res?.data ?? res);
      expect(payload, method).toMatch(/will not sign anything it cannot show you/i);
    }
  });

  it("refuses a method that is not in the provider's vocabulary", async () => {
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    for (const method of ["exportSeed", "getSeed", "__proto__", "", "signAllTheThings"]) {
      const res = await fromSite(method, SITE);
      const payload = JSON.stringify(res?.data ?? res);
      expect(payload, method).toMatch(/unsupported method/i);
      expect(payload).not.toMatch(/G[A-Z2-7]{55}/);
    }
  });

  it("never routes a dApp call into the wallet router", async () => {
    // `sep43` is handled before `dispatch` and must never reach it. A site
    // asking for `confirmPayment` by name gets the provider's refusal, not the
    // wallet's behaviour.
    await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    for (const method of ["confirmPayment", "reset", "recoverFromMnemonic", "buildPayment"]) {
      const res = await fromSite(method, SITE, [{ password: PASSWORD }]);
      expect(JSON.stringify(res?.data ?? res), method).toMatch(/unsupported method/i);
    }
    // And the wallet is untouched.
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
  });
});

describe("a grant expires and can be revoked", () => {
  it("stops working once its twenty-four hours are up", async () => {
    const address = await unlockedWallet();
    await connect(SITE, address);

    // Age the stored grant rather than the clock, so nothing else in the worker
    // is moved and the assertion is about the TTL alone.
    const sessions = chrome.local.get(KEYS.dappSessions) as Record<
      string,
      { connectedAt: number }
    >;
    sessions[SITE]!.connectedAt = Date.now() - SESSION_TTL_MS - 1;
    chrome.local.set(KEYS.dappSessions, sessions);

    expect(await sessionFor(SITE)).toBeNull();
    const res = await fromSite("getAddress", SITE);
    expect(JSON.stringify(res?.data ?? res)).not.toContain(address);
  });

  it("forgets an expired grant rather than leaving it to be renewed", async () => {
    const address = await unlockedWallet();
    await connect(SITE, address);
    const sessions = chrome.local.get(KEYS.dappSessions) as Record<
      string,
      { connectedAt: number }
    >;
    sessions[SITE]!.connectedAt = Date.now() - SESSION_TTL_MS - 1;
    chrome.local.set(KEYS.dappSessions, sessions);

    await sessionFor(SITE);
    const after = (chrome.local.get(KEYS.dappSessions) ?? {}) as Record<string, unknown>;
    expect(Object.keys(after)).not.toContain(SITE);
  });

  it("is revoked by disconnectDapp and takes effect at once", async () => {
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    expect((await fromSite("getAddress", SITE))?.ok).toBe(true);

    await asPopup({ type: "disconnectDapp", origin: SITE });
    const res = await fromSite("getAddress", SITE);
    expect(JSON.stringify(res?.data ?? res)).not.toContain(address);
  });

  it("records which address the user consented to reveal", async () => {
    // So a later account switch is visible rather than silently re-scoped.
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    const listed = (await asPopup({ type: "dappSessions" }))!.data as {
      origin: string;
      address: string;
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ origin: SITE, address });
  });
});

describe("granting is the popup's job, not the site's", () => {
  it("refuses connectDapp while locked", async () => {
    await unlockedWallet();
    await asPopup({ type: "lock" });
    expect(await asPopup({ type: "connectDapp", origin: SITE })).toEqual({
      ok: false,
      error: "Wallet is locked.",
    });
  });

  it("refuses dappSessions and disconnectDapp while locked", async () => {
    await unlockedWallet();
    await asPopup({ type: "lock" });
    expect(await asPopup({ type: "dappSessions" })).toEqual({
      ok: false,
      error: "Wallet is locked.",
    });
    expect(await asPopup({ type: "disconnectDapp", origin: SITE })).toEqual({
      ok: false,
      error: "Wallet is locked.",
    });
  });

  it("does not let a site grant itself a session", async () => {
    // `connectDapp` is a wallet request, so it goes through `dispatch` and the
    // sender check. A site can only send `sep43`, and `connect` is not one of
    // its methods.
    await unlockedWallet();
    const res = await fromSite("connectDapp", SITE, [SITE]);
    // Refused, and the wording is incidental: an unconnected site is turned
    // away by the session check before the method switch is even reached. What
    // matters is that asking did not create the thing being asked for.
    expect(JSON.stringify(res?.data ?? res)).toMatch(/not connected|unsupported method/i);
    expect(chrome.local.get(KEYS.dappSessions) ?? {}).toEqual({});
  });
});

describe("grants do not outlive the wallet that issued them", () => {
  it("is cleared when the wallet is erased and re-imported", async () => {
    // A grant that survives a wipe is a standing permission held by a site over
    // a wallet whose owner may have changed. Every trace of the old wallet is
    // supposed to be gone.
    const address = await unlockedWallet();
    await asPopup({ type: "connectDapp", origin: SITE });
    expect(Object.keys((chrome.local.get(KEYS.dappSessions) ?? {}) as object)).toContain(SITE);
    void address;

    const res = await asPopup({ type: "reset", password: PASSWORD });
    expect(res?.ok, `reset failed: ${res?.error}`).toBe(true);

    const left = (chrome.local.get(KEYS.dappSessions) ?? {}) as Record<string, unknown>;
    expect(
      Object.keys(left),
      "a dApp grant survived the wipe that was supposed to remove everything",
    ).toEqual([]);
  });
});
