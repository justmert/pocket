// What a wipe leaves behind, and what it must not.
//
// `erase` is shared by two callers that mean different things. `reset` is a
// person removing this wallet from this device. `recoverFromMnemonic` is the
// same account coming straight back through a forgotten password. Everything
// else about them is identical, so a key that survives one survives the other
// unless somebody decided otherwise.
//
// `pocket.auditorid.<registry>.<token>.<address>` was surviving both. Half of
// that is correct and half of it is a leak:
//
//   - after a RESET the key names the erased account's Stellar address and sits
//     beside no vault, telling anyone who opens the device's storage that this
//     account was here and used the private pocket. Nothing about it is
//     exploitable and no money is at risk. It is simply the wallet failing to do
//     what the user asked, in the one product area it makes claims about.
//   - after a RECOVERY the key is load-bearing. `ownAuditorId` reuses it after
//     checking it against the chain, and without it the next registration
//     allocates a second id for a key that already has one.
//
// Both directions are asserted, because either one alone is satisfied by an
// implementation that gets the other backwards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installChrome, POPUP_SENDER } from "./_harness/chrome";

const chrome = installChrome();
await import("../../src/entrypoints/background");
const { clearSession } = await import("../../src/core/session");
const { KEYS } = await import("../../src/lib/storage");

const PASSWORD = "correct horse battery staple";
const REGISTRY = "CAUDITOR2222222222222222222222222222222222222222222222222";
const TOKEN = "CTOKEN33333333333333333333333333333333333333333333333333";

const asPopup = (msg: Record<string, unknown>) =>
  chrome.send(msg, POPUP_SENDER) as Promise<
    { ok: boolean; error?: string; data?: unknown } | undefined
  >;

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  chrome.alarms.clear();
  clearSession();
});
afterEach(() => clearSession());

/** The id `ownAuditorId` would have recorded for this account. */
const auditorKeyFor = (address: string) => `${KEYS.auditorId}.${REGISTRY}.${TOKEN}.${address}`;

/** Every surviving key that mentions an auditor id. */
const survivingAuditorKeys = () =>
  [...chrome.local.keys()].filter((k) => k.startsWith(`${KEYS.auditorId}.`));

async function walletWithRegistration() {
  const res = await asPopup({ type: "create", password: PASSWORD });
  expect(res?.ok, `create failed: ${res?.error}`).toBe(true);
  const { address, mnemonic } = res!.data as { address: string; mnemonic: string };
  // Stand in for a completed `register`, which needs a chain this test has no
  // business simulating: the only artefact that outlives it is this record.
  chrome.local.set(auditorKeyFor(address), 7);
  expect(survivingAuditorKeys(), "the fixture did not take").toHaveLength(1);
  return { address, mnemonic };
}

describe("reset removes what it says it removes", () => {
  it("sweeps the recorded auditor id", async () => {
    const { address } = await walletWithRegistration();

    const res = await asPopup({ type: "reset", password: PASSWORD });
    expect(res?.ok, `reset failed: ${res?.error}`).toBe(true);

    expect(
      survivingAuditorKeys(),
      "an erased wallet left a key naming its own address behind",
    ).toEqual([]);
    // Named directly too, because an empty list also passes if the sweep took
    // the whole of storage and the wallet is now broken in a different way.
    expect(chrome.local.has(auditorKeyFor(address))).toBe(false);
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(false);
  });

  it("leaves nothing carrying the erased address anywhere in storage", async () => {
    // The general form. The specific key above is the one that was found; this
    // is the property that was actually meant, and it is what a new key added
    // later would trip over.
    const { address } = await walletWithRegistration();
    await asPopup({ type: "reset", password: PASSWORD });

    const left = [...chrome.local.entries()].map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(" ");
    expect(left, "the erased account's address survived the wipe").not.toContain(address);
  });

  it("does not sweep it on a wrong password, because nothing is erased at all", async () => {
    // The control for the sweep itself: it must be a consequence of erasing,
    // not something that happens on the way to the password check.
    const { address } = await walletWithRegistration();
    const res = await asPopup({ type: "reset", password: "not the password" });
    expect(res?.ok).toBe(false);
    expect(chrome.local.has(auditorKeyFor(address))).toBe(true);
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
  });
});

describe("recovery keeps what the same account still needs", () => {
  it("keeps the recorded auditor id, because the account is coming back", async () => {
    const { address, mnemonic } = await walletWithRegistration();

    const res = await asPopup({
      type: "recoverFromMnemonic",
      mnemonic,
      password: "a different password entirely",
    });
    expect(res?.ok, `recovery failed: ${res?.error}`).toBe(true);
    // `recoverFromMnemonic` answers with the address as a bare string, not
    // wrapped in an object. Reading `.address` off it yields undefined, which
    // would have made this assertion pass against the wrong account too.
    expect(res!.data, "recovery produced a different account").toBe(address);

    expect(
      chrome.local.get(auditorKeyFor(address)),
      "recovery discarded the id, so the next register will orphan a key on chain",
    ).toBe(7);
  });

  it("still destroys the vault and the openings it cannot recover", async () => {
    // The keep must be narrow. Recovery is still an erase, and the openings are
    // still gone: they are sealed under a DEK that is about to be replaced, and
    // the phrase cannot reconstruct them.
    const { address, mnemonic } = await walletWithRegistration();
    chrome.local.set(`${KEYS.openings}.${TOKEN}.${address}`, { sealed: "whatever" });

    await asPopup({ type: "recoverFromMnemonic", mnemonic, password: "a different password" });

    expect(
      [...chrome.local.keys()].filter((k) => k.startsWith(`${KEYS.openings}.`)),
      "an opening sealed under the old DEK survived recovery",
    ).toEqual([]);
  });
});
