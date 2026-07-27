// A registration whose outcome this device never learned.
//
// The registry ALLOCATES the auditor id and returns it, so the id exists only
// in the invocation result. A `pending` outcome carries no result, and the
// wallet used to answer that with "Nothing was bound" and then, on the next
// attempt, register again: another envelope, another fee, another id, and the
// first one orphaned with nobody able to name it. The comment above the retry
// guard records the measured version of this on testnet: four registrations
// landed, four ids allocated, zero recorded, 0.0192 XLM spent.
//
// `pocket.inflight` is not the record that saves this. It is cleared as soon as
// the chain answers, and for a chain-settled invocation reconciliation applies
// nothing, so the id goes with it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

// The confirmation poll sleeps a second between fifteen attempts, and this
// file deliberately drives it to exhaustion four times. Nothing here depends on
// elapsed time, only on how many replies arrive and what they say, so the sleep
// is collapsed rather than waited out.
const realSetTimeout = globalThis.setTimeout;
vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) =>
  ms && ms >= 1000 ? (fn(), 0) : realSetTimeout(fn, ms)) as typeof setTimeout);

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

/**
 * The one key both sides of the bind check see.
 *
 * `ownAuditorId` derives our key and then reads back what the registry holds
 * under the allocated id, refusing to bind unless they are equal. Both are
 * faked to the same point so the check passes on its real comparison; this file
 * is about the recovery, and the bind refusal has its own coverage.
 */
const OUR_KEY = { x: 11n, y: 22n };

vi.mock("./confidential-ops", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    deriveOwnAuditorKey: async () => ({ publicKey: OUR_KEY }),
    // The envelope's contents do not matter here; what matters is how many
    // times one is sent. A plain payment is enough to be signable.
    buildRegisterAuditor: async (ctx: { source: unknown }) => buildDummy(ctx),
  };
});

vi.mock("./chain/confidential", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, readAuditorKey: async () => OUR_KEY };
});

const { WalletController, PrivatePocketError } = await import("./controller");
const { NETWORKS } = await import("./config");
const { resetLedgerTime } = await import("./chain/submit");
const base = await import("@stellar/stellar-sdk/base");
const { Account, TransactionBuilder, Operation, Asset, BASE_FEE } = base;

const CFG = NETWORKS.testnet.confidential[0]!;

function buildDummy(ctx: unknown): unknown {
  const source = (ctx as { source: InstanceType<typeof Account> }).source;
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORKS.testnet.passphrase,
  })
    .addOperation(
      Operation.payment({ destination: source.accountId(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(180)
    .build();
}

/** Every hash the harness was asked to submit, so a second send is visible. */
let sent: string[] = [];
/** What `getTransaction` answers, set per test. */
let reply: Record<string, unknown> = { status: "NOT_FOUND" };

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    sendTransaction: async (tx: { hash(): { toString(e: string): string } }) => {
      sent.push(tx.hash().toString("hex"));
      return { status: "PENDING" };
    },
    getTransaction: async () => reply,
    getLedgerEntries: async () => ({ entries: [] }),
  });
  return { c, address };
}

/** The private method under test, reached directly: everything above it in
 *  `buildPrivateOp` is a VK read, a circuit load and a prover run, none of
 *  which this behaviour depends on. `source` is all the fake ops read. */
function register(c: unknown, address: string): Promise<number> {
  const ctx = { source: new Account(address, "100") };
  return (c as { ownAuditorId(ctx: unknown, cfg: unknown): Promise<number> }).ownAuditorId(
    ctx,
    CFG,
  );
}

/** The marker key `ownAuditorId` records an unsettled attempt under. */
function markerKey(address: string): string {
  // Same prefix as the id itself, which is also what makes erase sweep it.
  return `pocket.auditorid.${CFG.auditor}.${CFG.token}.${address}.pending`;
}

beforeEach(() => {
  store.clear();
  sent = [];
  reply = { status: "NOT_FOUND" };
  resetLedgerTime();
});

describe("a registration the wallet never got an answer about", () => {
  it("does not tell the user nothing was bound", async () => {
    const { c, address } = await worker();
    // NOT_FOUND for every poll, inside the window: the honest reading is "we
    // do not know", and the transaction may be on chain right now.
    const err = await register(c, address).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PrivatePocketError);
    const said = (err as Error).message;
    expect(said, "claimed nothing was bound about an unknown outcome").not.toMatch(
      /Nothing was bound/i,
    );
    expect(said).toMatch(/did not learn whether it landed/i);
  });

  it("records the attempt, so the next open can ask about it", async () => {
    const { c, address } = await worker();
    await register(c, address).catch(() => undefined);

    const marker = store.get(markerKey(address)) as { hash: string } | undefined;
    expect(marker, "the only record of an id that may already exist").toBeDefined();
    expect(marker!.hash).toBe(sent.at(-1));
  });

  it("reads the id back off the chain instead of registering a second time", async () => {
    const { c, address } = await worker();
    await register(c, address).catch(() => undefined);
    const attempts = sent.length;
    expect(attempts).toBeGreaterThan(0);

    // Same device, later session: the envelope did land, and the registry
    // handed it id 7.
    reply = {
      status: "SUCCESS",
      ledger: 500,
      applicationOrder: 1,
      returnValue: base.xdr.ScVal.scvU32(7),
      latestLedgerCloseTime: 1_800_000_000,
    };
    await expect(register(c, address)).resolves.toBe(7);

    expect(sent.length, "paid for a second registration it already had").toBe(attempts);
    expect(store.get(markerKey(address)), "marker outlived the id it recovered").toBeUndefined();
    expect(store.get(markerKey(address).replace(/\.pending$/, ""))).toBe(7);
  });

  it("refuses to register again while the answer is still unknown", async () => {
    const { c, address } = await worker();
    await register(c, address).catch(() => undefined);
    const attempts = sent.length;

    // Still NOT_FOUND, still inside the envelope's own validity window.
    const err = await register(c, address).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/still waiting to hear/i);
    expect(sent.length, "sent a second registration on an undecided one").toBe(attempts);
  });

  it("registers afresh once the chain says the envelope failed", async () => {
    const { c, address } = await worker();
    await register(c, address).catch(() => undefined);
    const attempts = sent.length;

    // FAILED is decisive: it applied and reverted, so no id was allocated and
    // registering again is the only way forward.
    reply = { status: "FAILED", ledger: 500, latestLedgerCloseTime: 1_800_000_000 };
    await register(c, address).catch(() => undefined);

    expect(sent.length, "wedged on a registration that is known to have failed").toBeGreaterThan(
      attempts,
    );
  });
});

describe("a registration that lands", () => {
  it("records the id and leaves no marker behind", async () => {
    const { c, address } = await worker();
    reply = {
      status: "SUCCESS",
      ledger: 500,
      applicationOrder: 1,
      returnValue: base.xdr.ScVal.scvU32(3),
      latestLedgerCloseTime: 1_800_000_000,
    };

    await expect(register(c, address)).resolves.toBe(3);
    expect(store.get(markerKey(address))).toBeUndefined();
    // And a second call costs nothing: the id is on disk.
    const attempts = sent.length;
    await expect(register(c, address)).resolves.toBe(3);
    expect(sent.length).toBe(attempts);
  });
});
