// Two tabs creating a wallet at the same moment.
//
// The popup is an ordinary extension page and opens in a tab, so this is
// reachable by a user, not a synthetic race. Before it was serialised, both
// callers passed the "already exists" guard, both installed a seed, and both
// were shown a recovery phrase under the words "the only way to recover your
// wallet". Last write won. The loser's phrase owned nothing and its holder had
// no way to find out, because the phrase is shown exactly once.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
/** Milliseconds a write takes. Zero for ordinary tests, nonzero to force a race. */
let writeDelay = 0;
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        // A real chrome.storage write crosses a process boundary. Resolving on
        // the microtask queue makes two callers look serialised when nothing
        // is serialising them, so a race test written against it passes while
        // the race is wide open. This is the smallest delay that lets another
        // caller's read observe a half-written state.
        if (writeDelay > 0) await new Promise((r) => setTimeout(r, writeDelay));
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

const { WalletController, WalletExistsError } = await import("./controller");
const { KEYS, readLocal } = await import("../lib/storage");

describe("two tabs creating a wallet at once", () => {
  beforeEach(() => store.clear());

  it("installs exactly one seed and refuses the other", async () => {
    const c = new WalletController();
    await c.init();

    const [a, b] = await Promise.allSettled([c.create("first tab"), c.create("second tab")]);
    const ok = [a, b].filter((r) => r.status === "fulfilled");
    const refused = [a, b].filter((r) => r.status === "rejected");

    // Exactly one phrase may be handed out, because only one can be true.
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(WalletExistsError);
  });

  it("the phrase it handed out is the one that owns the stored wallet", async () => {
    const c = new WalletController();
    await c.init();

    const results = await Promise.allSettled([
      c.create("first tab"),
      c.create("second tab"),
      c.create("third tab"),
    ]);
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      mnemonic: string;
      address: string;
    }>;
    expect(winner).toBeDefined();

    // The address on disk must be the winner's. Before serialising, a later
    // create overwrote the vault while an earlier one had already returned its
    // phrase to the screen.
    expect(await readLocal<string>(KEYS.publicAddress)).toBe(winner.value.address);

    // And that phrase must reproduce it, which is the whole promise made on
    // the backup screen.
    const fresh = new WalletController();
    await fresh.init();
    store.delete(KEYS.vaultHeader);
    store.delete(KEYS.state);
    const { address } = await fresh.import("a new password", winner.value.mnemonic);
    expect(address).toBe(winner.value.address);
  });

  it("says a wallet already exists rather than something went wrong", async () => {
    const { describeError } = await import("./dispatch");
    const c = new WalletController();
    await c.init();
    await c.create("first");

    const err = await c.create("second").catch((e: unknown) => e);
    // Told "try again", a user retries, keeps failing, and removes the
    // extension, which discards the confidential openings for good.
    expect(describeError(err)).toMatch(/already exists/i);
    expect(describeError(err)).not.toMatch(/Something went wrong/);
  });

  it("import says it too, rather than being swallowed", async () => {
    const { describeError } = await import("./dispatch");
    const c = new WalletController();
    await c.init();
    const { mnemonic } = await c.create("first");

    const err = await c.import("second", mnemonic).catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/already exists/i);
  });
});

describe("every path that installs a seed is serialised, not just create", () => {
  beforeEach(() => store.clear());

  it("two concurrent imports of DIFFERENT phrases leave one coherent wallet", async () => {
    // The `create` fix was only half a fix: `import` had the same guard and no
    // lock. The mild outcome is a user shown an address the device does not
    // hold. The bad one is a header from one wallet beside state from the
    // other, because installSeed writes address, header and state separately.
    // That DEK cannot decrypt that state, so neither phrase opens the vault.
    const a = new WalletController();
    const b = new WalletController();
    await Promise.all([a.init(), b.init()]);

    const seedA = (await a.create("first")).mnemonic;
    store.clear();
    const seedB = (await b.create("second")).mnemonic;
    store.clear();

    const x = new WalletController();
    await x.init();
    const results = await Promise.allSettled([
      x.import("password one", seedA),
      x.import("password two", seedB),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // The decisive check: the vault must actually open. A blended header and
    // state throws on unlock, which is the failure worth preventing.
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      address: string;
    }>;
    const opened = new WalletController();
    await opened.init();
    const pw = winner.value.address === (await a.status()).address ? "password one" : "password two";
    await expect(opened.unlock(pw)).resolves.toBeDefined();
    expect((await opened.status()).address).toBe(winner.value.address);
  });

  it("creating in one tab while importing in another leaves one coherent wallet", async () => {
    const src = new WalletController();
    await src.init();
    const phrase = (await src.create("x")).mnemonic;
    store.clear();

    const c = new WalletController();
    await c.init();
    const results = await Promise.allSettled([c.create("via create"), c.import("via import", phrase)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readLocal(KEYS.vaultHeader)).toBeDefined();
    expect(await readLocal(KEYS.state)).toBeDefined();
  });
});

/**
 * HONEST LABEL: these two assert COHERENCE, and they do NOT pin the
 * serialisation.
 *
 * `recoverFromMnemonic` goes through `exclusive`, and reverting that to a
 * direct call leaves both of these green. I tried three ways to make them
 * fail -- a stranger's phrase, the wallet's own phrase, and a storage mock
 * with a real delay on every write -- and could not. So by this pass's own
 * rule they are reported as tests that could not be made to fail rather than
 * quietly counted as coverage.
 *
 * What they DO hold is worth keeping: whatever the interleaving, exactly one
 * password opens the vault afterwards. A blended header and state, which is
 * the unrecoverable outcome, would show up here as zero.
 *
 * What would actually pin it is a hook that holds one caller's write open
 * while another proceeds, which is how T5b's harness forces the import race.
 * That belongs in `tests/auth`, which owns that harness.
 */
describe("recovery leaves a coherent wallet, however it interleaves", () => {
  beforeEach(() => {
    store.clear();
    writeDelay = 0;
  });
  afterEach(() => {
    writeDelay = 0;
  });

  // UNPINNED before this: reverting `exclusive(() => doRecoverFromMnemonic(...))`
  // to a direct call turned nothing red. Recovery has the same check-then-act
  // shape as create and import, and it ends by calling doImport, so it can
  // interleave with either of them and leave a header from one wallet beside
  // state sealed under the other's DEK.
  it("a recovery racing an import leaves one wallet that actually opens", async () => {
    writeDelay = 2;
    const other = new WalletController();
    await other.init();
    const strangerPhrase = (await other.create("stranger")).mnemonic;
    store.clear();

    const c = new WalletController();
    await c.init();
    // The recovery uses THIS wallet's own phrase, because recoverFromMnemonic
    // refuses one belonging to a different wallet, and that refusal is a
    // separate property already tested above.
    const { mnemonic } = await c.create("original");

    const results = await Promise.allSettled([
      c.recoverFromMnemonic(mnemonic, "recovered password"),
      c.import("imported password", strangerPhrase),
    ]);
    // Import refuses over an existing vault, so exactly one can win. What
    // matters is that the survivor is coherent, not which one it is.
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const opened = new WalletController();
    await opened.init();
    const pw = ["recovered password", "imported password", "original"];
    const worked = await Promise.allSettled(pw.map((p) => opened.unlock(p)));
    // Exactly one password opens it. Zero means a blended header and state,
    // which is a vault no phrase can ever open.
    expect(worked.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("two concurrent recoveries of the same phrase leave one coherent wallet", async () => {
    writeDelay = 2;
    const c = new WalletController();
    await c.init();
    const { mnemonic } = await c.create("original");

    // The same phrase twice, two different new passwords. Both are legitimate
    // and both erase then reinstall, so an interleave puts a header from one
    // beside state sealed under the other's DEK.
    await Promise.allSettled([
      c.recoverFromMnemonic(mnemonic, "password a"),
      c.recoverFromMnemonic(mnemonic, "password b"),
    ]);

    const opened = new WalletController();
    await opened.init();
    const worked = await Promise.allSettled(
      ["password a", "password b"].map((p) => opened.unlock(p)),
    );
    expect(worked.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
