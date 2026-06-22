// Two tabs creating a wallet at the same moment.
//
// The popup is an ordinary extension page and opens in a tab, so this is
// reachable by a user, not a synthetic race. Before it was serialised, both
// callers passed the "already exists" guard, both installed a seed, and both
// were shown a recovery phrase under the words "the only way to recover your
// wallet". Last write won. The loser's phrase owned nothing and its holder had
// no way to find out, because the phrase is shown exactly once.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
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
