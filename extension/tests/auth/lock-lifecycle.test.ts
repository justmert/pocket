// The lock: what arms it, what postpones it, and what is left reachable after
// it fires.
//
// Driven through the shipped `background.ts` listener and a chrome that records
// what the worker did to it, because the idle lock is entirely a conversation
// between that listener and `chrome.alarms`. An alarm rather than a setTimeout
// is load-bearing: a setTimeout dies with the worker, so a wallet relying on one
// would silently stay unlocked across a restart it never noticed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../../src/lib/polyfill";
import { installChrome, EVERY_REQUEST } from "./_harness/chrome";
import { FaultServer, rpcOk } from "../failure/_harness/faults";
import { accountKey, accountEntry, entryFor, entriesResult } from "../failure/_harness/ledger";

const chrome = installChrome();

await import("../../src/entrypoints/background");
const { NETWORKS } = await import("../../src/core/config");
const { WalletController } = await import("../../src/core/controller");
const { getSession, isUnlocked, clearSession } = await import("../../src/core/session");
const { KEYS } = await import("../../src/lib/storage");

/** Flush the fire-and-forget mirror write so the RAM store can be read back. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const PASSWORD = "correct horse battery staple";
const AUTO_LOCK = "pocket.autolock";
const REAL_RPC = NETWORKS.testnet.rpcUrl;
const open: FaultServer[] = [];

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  chrome.alarms.clear();
  chrome.alarmHistory.length = 0;
  clearSession();
});

afterEach(async () => {
  NETWORKS.testnet.rpcUrl = REAL_RPC;
  await Promise.all(open.splice(0).map((s) => s.close()));
  clearSession();
});

const send = (msg: Record<string, unknown>) =>
  chrome.send(msg) as Promise<{ ok: boolean; error?: string; data?: unknown } | undefined>;

const autoLocks = () => chrome.alarmHistory.filter((a) => a.name === AUTO_LOCK);

/** A wallet created through the real message path, so the worker owns it. */
async function createWallet() {
  const res = await send({ type: "create", password: PASSWORD });
  expect(res?.ok, `create failed: ${res?.error}`).toBe(true);
  return (res!.data as { address: string }).address;
}

describe("the idle lock is armed by activity and only by activity", () => {
  it("arms a fifteen-minute alarm after a real operation", async () => {
    await createWallet();
    const armed = autoLocks();
    expect(armed.length).toBeGreaterThan(0);
    expect(armed.at(-1)?.delayInMinutes).toBe(15);
  });

  it("does NOT re-arm on a status poll", async () => {
    await createWallet();
    const before = autoLocks().length;
    for (let i = 0; i < 5; i++) await send({ type: "status" });
    expect(autoLocks()).toHaveLength(before);
  });

  it("does NOT re-arm on the in-flight check the popup runs every mount", async () => {
    await createWallet();
    const before = autoLocks().length;
    await send({ type: "inFlight" });
    expect(autoLocks()).toHaveLength(before);
  });

  it("does NOT re-arm on an unrecognised message", async () => {
    await createWallet();
    const before = autoLocks().length;
    await send({ type: "drainWallet" });
    await chrome.send({ channel: "pocket.prover", kind: "status" });
    expect(autoLocks()).toHaveLength(before);
  });

  it("does NOT arm anything while the wallet is locked", async () => {
    await createWallet();
    await send({ type: "lock" });
    chrome.alarmHistory.length = 0;
    for (const { msg } of EVERY_REQUEST) await send(msg);
    // `create`, `import` and `recoverFromMnemonic` are activity types, but the
    // wallet is locked and their own guards refuse, so nothing may re-arm.
    expect(autoLocks()).toHaveLength(0);
  });

  it("re-arms on the next genuine operation, so an active session stays open", async () => {
    const address = await createWallet();
    // Answer like a real RPC: the account key returns the account entry, any
    // other key (balances() now also reads a USDC trustline) returns empty, so
    // the trustline is omitted rather than read back as the wrong entry.
    const server = await FaultServer.start({
      fallback: (req) =>
        req.body.includes(accountKey(address).toXDR("base64"))
          ? rpcOk(
              entriesResult([entryFor(accountKey(address), accountEntry(address, 100_0000000n))]),
            )
          : rpcOk(entriesResult([])),
    });
    open.push(server);
    NETWORKS.testnet.rpcUrl = server.url;

    const before = autoLocks().length;
    expect((await send({ type: "balances" }))?.ok).toBe(true);
    expect(autoLocks().length).toBe(before + 1);
  });
});

describe("when the alarm fires", () => {
  it("clears the session", async () => {
    await createWallet();
    expect(isUnlocked()).toBe(true);
    chrome.fireAlarm(AUTO_LOCK);
    expect(isUnlocked()).toBe(false);
  });

  it("makes every non-allowlisted operation refuse again", async () => {
    await createWallet();
    chrome.fireAlarm(AUTO_LOCK);
    for (const { type, msg } of EVERY_REQUEST) {
      const res = await send(msg);
      if (["status", "create", "import", "unlock", "lock", "recoverFromMnemonic"].includes(type)) {
        continue;
      }
      expect(res, `${type} answered after the idle lock`).toEqual({
        ok: false,
        error: "Wallet is locked.",
      });
    }
  });

  it("ignores an alarm that is not ours", async () => {
    await createWallet();
    chrome.fireAlarm("some.other.alarm");
    expect(isUnlocked()).toBe(true);
  });

  it("postpones rather than locking while an operation is in flight", async () => {
    // Locking mid-operation strands a transaction that has already been
    // submitted: the write that records what it did needs the very keys the
    // lock destroys, and `clearSession` zeroes the seed in place, so an
    // operation holding a reference is not spared either.
    const address = await createWallet();
    const server = await FaultServer.start({ fallback: { kind: "stall" } });
    open.push(server);
    NETWORKS.testnet.rpcUrl = server.url;
    void address;

    const inFlight = send({ type: "balances" });
    // Let the listener increment its running counter before the alarm lands.
    await Promise.resolve();

    chrome.alarmHistory.length = 0;
    chrome.fireAlarm(AUTO_LOCK);

    expect(isUnlocked(), "locked while an operation was running").toBe(true);
    const rearmed = autoLocks();
    expect(rearmed.length).toBeGreaterThan(0);
    expect(rearmed.at(-1)?.delayInMinutes).toBe(1);

    await server.close();
    open.splice(open.indexOf(server), 1);
    await inFlight.catch(() => undefined);
  }, 60_000);
});

describe("the two ways a wallet locks must agree", () => {
  // A wallet locks by the button or by sitting idle for fifteen minutes, and
  // from the user's side those are the same state: "locked". Anything the
  // button clears and the alarm does not is a protection that exists only for
  // people who remember to press it, which is the opposite of who an idle lock
  // is for.
  //
  // `controller.lock()` is where that clearing lives. The button reaches it
  // through `dispatch`. The alarm does not go through the controller at all.
  const ORIGIN = "https://example.com";

  /** Grants, read back through the message path the popup uses. */
  async function grants(): Promise<{ origin: string }[]> {
    const res = await send({ type: "dappSessions" });
    expect(res?.ok, `dappSessions failed: ${res?.error}`).toBe(true);
    return res!.data as { origin: string }[];
  }

  it("the button drops a site's standing grant", async () => {
    await createWallet();
    expect((await send({ type: "connectDapp", origin: ORIGIN }))?.ok).toBe(true);
    expect(await grants()).toHaveLength(1);

    await send({ type: "lock" });
    expect((await send({ type: "unlock", password: PASSWORD }))?.ok).toBe(true);
    expect(await grants()).toHaveLength(0);
  });

  it("so must the idle alarm, which is the one that fires when nobody is there", async () => {
    // The grant says a site may see this account. A locked wallet says it may
    // not. Walking away is the case the whole idle lock exists for, so it is
    // the worst one to leave a standing grant open through.
    await createWallet();
    expect((await send({ type: "connectDapp", origin: ORIGIN }))?.ok).toBe(true);
    expect(await grants()).toHaveLength(1);

    chrome.fireAlarm(AUTO_LOCK);
    expect(isUnlocked(), "the alarm did not lock the wallet at all").toBe(false);

    expect((await send({ type: "unlock", password: PASSWORD }))?.ok).toBe(true);
    expect(await grants(), "the idle lock left a standing grant behind").toHaveLength(0);
  });

  it("leaves the wallet in one state whichever way it got there", async () => {
    // Not a duplicate of the two above: this compares the WHOLE reported
    // status, so a field added to it later is covered without anyone
    // remembering to come back here.
    await createWallet();
    await send({ type: "lock" });
    const afterButton = (await send({ type: "status" }))!.data;

    chrome.local.clear();
    chrome.alarms.clear();
    clearSession();
    await createWallet();
    chrome.fireAlarm(AUTO_LOCK);
    const afterAlarm = (await send({ type: "status" }))!.data;

    expect(afterAlarm).toEqual(afterButton);
  });
});

describe("nothing sensitive survives the lock", () => {
  it("zeroes the key material rather than only dropping the reference", async () => {
    await createWallet();
    const session = getSession()!;
    const dek = session.dek;
    const seed = session.seed;
    expect(dek.some((b) => b !== 0)).toBe(true);
    expect(seed.some((b) => b !== 0)).toBe(true);

    await send({ type: "lock" });

    // The same buffers, now zeroed in place. It does not defeat a dump taken
    // mid-session; it shortens the window in which a key sits in a reachable
    // heap object after lock.
    expect(dek.every((b) => b === 0)).toBe(true);
    expect(seed.every((b) => b === 0)).toBe(true);
    expect(getSession()).toBeNull();
  });

  it("mirrors only the DEK to session storage, and clears it on lock", async () => {
    // The unlocked session survives worker eviction by mirroring the DEK, and
    // ONLY the DEK, into chrome.storage.session (RAM, wiped on browser close).
    // The seed and the phrase must never be mirrored, and a real lock must take
    // the mirror with it or a restart would come straight back unlocked.
    await createWallet();
    await settle();

    const rec = chrome.session.get("pocket.session") as
      | { dek?: unknown; lockAt?: unknown }
      | undefined;
    expect(rec, "the DEK must be mirrored while unlocked").toBeTruthy();
    expect(typeof rec!.dek).toBe("string");
    expect(typeof rec!.lockAt).toBe("number");

    const dump = JSON.stringify([...chrome.session.entries()]);
    // Never the seed, never the mnemonic. 24 words in a row would be a phrase.
    expect(dump).not.toMatch(/"seed"/);
    expect(dump).not.toMatch(/"mnemonic"/);
    expect(dump).not.toMatch(/\b([a-z]{3,8} ){23}[a-z]{3,8}\b/);

    await send({ type: "lock" });
    expect([...chrome.session.keys()]).toEqual([]);
  });

  it("stores no seed or phrase in the clear", async () => {
    const address = await createWallet();
    await send({ type: "lock" });

    const dump = JSON.stringify([...chrome.local.entries()]);
    // The address is public by nature and is stored deliberately, so it is the
    // one identifier allowed to appear.
    expect(dump).toContain(address);
    // Nothing that could be a phrase or a key. 24 BIP-39 words in a row, or a
    // long run of hex, would both show up here.
    expect(dump).not.toMatch(/\b([a-z]{3,8} ){23}[a-z]{3,8}\b/);
    expect(dump).not.toMatch(/"mnemonic"/);
    expect(dump).not.toMatch(/"seed"/);
    expect(dump).not.toMatch(/"dek"/);
  });

  it("reports the private pocket as unavailable again after locking", async () => {
    // `privateReady` is cached from the last read and is only true for the
    // account that read it. Left set, a locked wallet still reports it and the
    // home screen offers to open a pocket it cannot reach.
    await createWallet();
    await send({ type: "lock" });
    const s = (await send({ type: "status" }))!.data as {
      locked: boolean;
      privateEnabled: boolean;
      address?: string;
    };
    expect(s.locked).toBe(true);
    expect(s.privateEnabled).toBe(false);
    expect(s.address).toBeUndefined();
  });

  it("restores from the RAM mirror when the worker restarts inside the window", async () => {
    // MV3 evicts the worker constantly, but a routine eviction is not a lock: the
    // DEK mirror lets a fresh worker re-open the vault without the password, up to
    // the idle deadline. This is the MetaMask model, and the point of the mirror.
    await createWallet();
    await settle();
    expect(isUnlocked()).toBe(true);

    // A restart: the module-level session is gone; the disk and the RAM mirror
    // are not.
    clearSession();
    expect(isUnlocked()).toBe(false);
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);

    // A fresh worker runs init(), which restores from the mirror.
    await new WalletController().init();
    expect(isUnlocked(), "a restart inside the window must restore").toBe(true);
  });

  it("stays locked when the worker restarts after the deadline", async () => {
    await createWallet();
    await settle();
    // Expire the mirror's deadline, as if the idle window had elapsed while the
    // worker was dead.
    const rec = chrome.session.get("pocket.session") as { dek: string; lockAt: number };
    chrome.session.set("pocket.session", { ...rec, lockAt: Date.now() - 1 });
    clearSession();

    await new WalletController().init();
    expect(isUnlocked(), "an expired session must not restore").toBe(false);
    // The stale record is purged rather than left to be tried again.
    expect(chrome.session.has("pocket.session")).toBe(false);
  });

  it("cannot restore after an explicit lock cleared the mirror", async () => {
    // An explicit lock, or a browser close (which wipes session storage), leaves
    // nothing to restore from. The password is required again.
    await createWallet();
    await settle();
    await send({ type: "lock" });
    expect(chrome.session.has("pocket.session")).toBe(false);
    clearSession();

    await new WalletController().init();
    expect(isUnlocked(), "an explicit lock must survive a restart").toBe(false);
  });

  it("needs the password again, not just a reopened popup", async () => {
    await createWallet();
    await send({ type: "lock" });
    expect((await send({ type: "unlock", password: "wrong" }))?.error).toBe("Wrong password.");
    expect(isUnlocked()).toBe(false);
    expect((await send({ type: "unlock", password: PASSWORD }))?.ok).toBe(true);
    expect(isUnlocked()).toBe(true);
  });
});
