// The lock, as the message boundary actually enforces it.
//
// Driven through the SHIPPED background listener, not through `dispatch`
// directly, because the gate lives in `background.ts` and a test that calls
// `isAllowedWhileLocked` proves only that a helper agrees with itself. Every
// message here goes in the way the popup sends one and the reply is the reply
// the popup would receive.
//
// Both directions matter. A type wrongly refused while locked is an annoyance;
// a type wrongly ALLOWED while locked is key material reachable without a
// password, so the refusing direction is asserted for every member of the union
// rather than for a sample.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../../src/lib/polyfill";
import { installChrome, EVERY_REQUEST, ALLOWED_WHILE_LOCKED, EXTENSION_ID, POPUP_SENDER } from "./_harness/chrome";

const chrome = installChrome();

await import("../../src/entrypoints/background");
const { isAllowedWhileLocked, isUserActivity } = await import("../../src/core/dispatch");
const { clearSession, isUnlocked } = await import("../../src/core/session");

const LOCKED = "Wallet is locked.";

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  chrome.alarms.clear();
  chrome.alarmHistory.length = 0;
  clearSession();
});

afterEach(() => {
  clearSession();
});

/** Send as the popup does, and hand back what the popup would see. */
async function send(msg: Record<string, unknown>) {
  return (await chrome.send(msg)) as { ok: boolean; error?: string; data?: unknown } | undefined;
}

describe("the locked wallet refuses everything that is not on the allowlist", () => {
  const refused = EVERY_REQUEST.filter((r) => !ALLOWED_WHILE_LOCKED.includes(r.type));

  it("has something to refuse, so this suite cannot pass vacuously", () => {
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length + ALLOWED_WHILE_LOCKED.length).toBe(EVERY_REQUEST.length);
  });

  for (const { type, msg } of refused) {
    it(`refuses ${type} with the locked message and nothing else`, async () => {
      expect(isUnlocked()).toBe(false);
      const res = await send(msg);
      expect(res).toEqual({ ok: false, error: LOCKED });
    });
  }

  for (const { type, msg } of refused) {
    it(`does not let ${type} arm the idle lock, which would imply it ran`, async () => {
      // The idle alarm is only armed after a successful, unlocked operation.
      // An armed alarm here would mean the refusal happened after the work.
      await send(msg);
      expect(chrome.alarmHistory.filter((a) => a.name === "pocket.autolock")).toHaveLength(0);
    });
  }

  it("refuses a type outside the union entirely", async () => {
    const res = await send({ type: "drainWallet" });
    expect(res).toEqual({ ok: false, error: LOCKED });
  });

  it("ignores a message with no type rather than answering it", async () => {
    // The prover speaks on this same runtime channel with its own
    // discriminator. Answering anything that is not a wallet request would
    // re-arm the idle lock on somebody else's traffic.
    await expect(send({ channel: "pocket.prover", kind: "status" })).resolves.toBeUndefined();
    await expect(send({})).resolves.toBeUndefined();
    await expect(send("hello" as unknown as Record<string, unknown>)).resolves.toBeUndefined();
  });
});

describe("the six on the allowlist are reachable while locked", () => {
  for (const type of ALLOWED_WHILE_LOCKED) {
    it(`lets ${type} through the lock gate`, async () => {
      const entry = EVERY_REQUEST.find((r) => r.type === type)!;
      const res = await send(entry.msg);
      // It may still fail on its OWN guard, which is the next spec's subject.
      // What it must not do is come back with the locked refusal.
      expect(res?.error).not.toBe(LOCKED);
    });
  }

  it("answers status with the real locked state rather than refusing it", async () => {
    const res = await send({ type: "status" });
    expect(res?.ok).toBe(true);
    expect(res?.data).toMatchObject({ initialised: false, locked: true });
    expect((res?.data as { address?: string }).address).toBeUndefined();
  });
});

describe("the allowlist and the activity list are exactly what the code says", () => {
  // A coverage guard rather than a behaviour test, and labelled as one. It
  // exists because the risk is a type added to the union and to `dispatch`
  // without anyone deciding which side of the lock it belongs on. That mistake
  // compiles, ships, and is invisible to every other test in this file.
  const source = readFileSync(
    fileURLToPath(new URL("../../src/core/messages.ts", import.meta.url)),
    "utf8",
  );
  const union = source.slice(
    source.indexOf("export type WalletRequest"),
    source.indexOf("/** The five private-pocket operations"),
  );
  const declared = [...union.matchAll(/type:\s*"([a-zA-Z]+)"/g)].map((m) => m[1] as string);

  it("covers every type the WalletRequest union declares", () => {
    expect(declared.length).toBeGreaterThan(10);
    expect([...declared].sort()).toEqual(EVERY_REQUEST.map((r) => r.type).sort());
  });

  it("agrees with isAllowedWhileLocked for every declared type", () => {
    for (const type of declared) {
      expect(isAllowedWhileLocked(type)).toBe(ALLOWED_WHILE_LOCKED.includes(type));
    }
  });

  it("treats no unknown type as allowed while locked", () => {
    for (const type of ["drainWallet", "exportSeed", "", "__proto__", "constructor"]) {
      expect(isAllowedWhileLocked(type)).toBe(false);
    }
  });
});

describe("a status poll must not keep a funded wallet unlocked forever", () => {
  // The idle lock is the only thing that closes a wallet left open on a shared
  // machine. If a background poll counts as activity, it never fires.
  it("does not count status as user activity", () => {
    expect(isUserActivity("status")).toBe(false);
  });

  it("does not count the read-only in-flight checks as user activity", () => {
    // The popup runs `inFlight` on every mount, including mounts the user did
    // not cause.
    expect(isUserActivity("inFlight")).toBe(false);
    expect(isUserActivity("reconcileInFlight")).toBe(false);
  });

  it("does count the operations a user actually performs", () => {
    for (const type of [
      "unlock",
      "balances",
      "buildPayment",
      "confirmPayment",
      "buildPrivateOp",
      "confirmPrivateOp",
      "privatePocket",
      "create",
      "import",
      "setNetwork",
      "recoverFromMnemonic",
    ]) {
      expect(isUserActivity(type), `${type} should postpone the idle lock`).toBe(true);
    }
  });

  it("counts no unknown type as activity", () => {
    for (const type of ["drainWallet", "", "__proto__"]) {
      expect(isUserActivity(type)).toBe(false);
    }
  });
});

describe("the sender check", () => {
  // There is no content script and no externally_connectable in the manifest,
  // so a web page cannot reach this listener at all. The check is defence in
  // depth for the worker that holds the keys, and defence in depth that is
  // never exercised is decoration.
  it("refuses a message whose sender is not this extension", async () => {
    const res = (await chrome.send({ type: "status" }, { id: "some-other-extension" })) as {
      ok: boolean;
      error: string;
    };
    expect(res).toEqual({ ok: false, error: "Unauthorized sender." });
  });

  it("refuses a message with no sender id at all", async () => {
    const res = (await chrome.send({ type: "status" }, {})) as { ok: boolean; error: string };
    expect(res).toEqual({ ok: false, error: "Unauthorized sender." });
  });

  it("refuses a foreign sender even for an allowlisted, unlocked-safe type", async () => {
    // `status` is the most harmless message in the union. The sender check must
    // still come first, or the boundary is a function of the payload.
    for (const { msg } of EVERY_REQUEST) {
      const res = (await chrome.send(msg, { id: "evil" })) as { ok: boolean; error: string };
      expect(res).toEqual({ ok: false, error: "Unauthorized sender." });
    }
  });

  it("accepts this extension's own pages", async () => {
    const res = await chrome.send({ type: "status" }, POPUP_SENDER);
    expect((res as { ok: boolean }).ok).toBe(true);
  });

  it("exposes exactly one relay to the web, and nothing else", () => {
    // This assertion USED to read "no content script at all", and it was true
    // until a SEP-43 provider landed mid-pass. It went red on the next run,
    // which is the whole reason it is phrased against the BUILT manifest rather
    // than against intent. What replaces it is not "a content script is fine":
    // it is the narrower set of facts that make this one safe.
    //
    // Read from a build this suite OWNS when one is named. `.output/chrome-mv3`
    // is shared with a dozen agents, and this assertion has already failed once
    // with ENOENT because somebody else's `npm run build` had deleted the
    // directory mid-read. That is a false red, which costs as much trust as a
    // false green. `POCKET_EXT_PATH` points at `.output-t5/chrome-mv3`, built
    // from `wxt.t5.config.ts`, and the browser spec in this slice uses the same
    // one, so the manifest asserted here is the manifest that was driven.
    const built = process.env.POCKET_EXT_PATH
      ? `${process.env.POCKET_EXT_PATH}/manifest.json`
      : fileURLToPath(new URL("../../.output/chrome-mv3/manifest.json", import.meta.url));
    let raw: string;
    try {
      raw = readFileSync(built, "utf8");
    } catch (e) {
      throw new Error(
        `no built manifest at ${built}. Build one first: ` +
          `npm run build -- -c wxt.t5.config.ts, then set POCKET_EXT_PATH. ` +
          `Reading the shared .output is what made this flaky. (${String(e)})`,
      );
    }
    const manifest = JSON.parse(raw) as Record<string, unknown>;

    // No page may connect to the worker directly. Everything from the web has
    // to go through the relay, where the browser stamps a real origin on it.
    expect(manifest.externally_connectable).toBeUndefined();

    const scripts = (manifest.content_scripts ?? []) as {
      js?: string[];
      world?: string;
      matches?: string[];
    }[];
    expect(scripts).toHaveLength(1);
    // ISOLATED, so a hostile page cannot reach into the relay's scope and call
    // `chrome.runtime` with a request of its own choosing.
    expect(scripts[0]?.world ?? "ISOLATED").toBe("ISOLATED");

    // Only the injected provider is reachable from a page. Anything else here
    // would be extension internals served to the open web.
    const war = (manifest.web_accessible_resources ?? []) as { resources?: string[] }[];
    const exposed = war.flatMap((w) => w.resources ?? []);
    expect(exposed.filter((r) => !/injected/.test(r))).toEqual([]);

    // And the permissions that would widen this are still absent.
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("<all_urls>");
    expect(manifest.permissions).not.toContain("scripting");

    // The exact host set. A content script runs in every page this wallet is
    // injected into, so a host permission is not only what the WORKER may fetch:
    // it is the blast radius if that relay is ever tricked into speaking for a
    // page. Each entry is a named endpoint, and none is a wildcard host.
    //
    // The mainnet Horizon entry is narrowed to `/trade_aggregations` on purpose.
    // Horizon accepts `POST /transactions`, so an unscoped grant would put a
    // real-money submission endpoint inside that blast radius. See
    // tests/qa/network-guard.test.ts, which asserts that rule on its own.
    expect(manifest.host_permissions).toEqual([
      "https://soroban-testnet.stellar.org/*",
      "https://horizon-testnet.stellar.org/*",
      "https://horizon.stellar.org/trade_aggregations*",
    ]);
    for (const h of manifest.host_permissions as string[]) {
      expect(h, "a wildcard host would make the relay a general-purpose fetcher").not.toMatch(
        /^https?:\/\/\*/,
      );
    }
  });
});


describe("the extension's own pages are the boundary, not the extension's id", () => {
  // `sender.id === chrome.runtime.id` is true of a content script: it runs in a
  // hostile page's process and carries our id. So it cannot be what separates
  // the wallet router from the web. This is what a content script's message
  // looks like: our id, and a page URL.
  const AS_CONTENT_SCRIPT = { id: EXTENSION_ID, origin: "https://evil.example", url: "https://evil.example/x" };

  it("refuses a wallet request that did not come from one of our pages", async () => {
    for (const msg of [
      { type: "status" },
      { type: "create", password: "correct horse battery staple" },
      { type: "unlock", password: "correct horse battery staple" },
      { type: "balances" },
      { type: "dappSessions" },
    ]) {
      const res = (await chrome.send(msg, AS_CONTENT_SCRIPT)) as { ok: boolean; error?: string };
      expect(res?.ok, msg.type).toBe(false);
      expect(res?.error, msg.type).toMatch(/unauthorized sender/i);
    }
  });

  it("still lets the one relay through, because that is what it is for", async () => {
    const res = (await chrome.send(
      { type: "sep43", method: "getNetwork", params: [] },
      AS_CONTENT_SCRIPT,
    )) as { ok: boolean; data?: unknown };
    // getNetwork is about the wallet, not the user, so it answers even locked.
    expect(res?.ok).toBe(true);
  });
});
