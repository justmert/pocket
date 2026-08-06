// A private transaction that has landed but is not in the list yet.
//
// The private Activity list comes only from the event archive: nothing else has
// the events to replay. An indexer is always some way behind the chain, so
// between a private transfer confirming and the archive ingesting it, the
// transaction exists on chain, its openings are already written locally and the
// balance already reflects it, and Activity shows nothing at all.
//
// The screen's silence then reads as "that did not happen" about something that
// did, on the one surface a user checks to find out.
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

vi.mock("./chain/history", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, publicHistory: async () => ({ entries: [], more: false, tokenOf: {} }) };
});

/** How far the archive says it has ingested. */
let ingestedThrough = 1_000;

vi.mock("./chain/archive", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    ArchiveClient: class {
      async health() {
        return { ingested_through: ingestedThrough };
      }
      async allEvents() {
        return [];
      }
    },
  };
});

vi.mock("./config", async (orig) => {
  const real = (await orig()) as { NETWORKS: Record<string, Record<string, unknown>> };
  return {
    ...real,
    NETWORKS: {
      ...real.NETWORKS,
      testnet: { ...real.NETWORKS.testnet, archiveUrl: "https://archive.invalid" },
    },
  };
});

const { WalletController } = await import("./controller");
const { Account } = await import("@stellar/stellar-sdk/base");

/** The chain's own head. */
let tip = 1_000;

beforeEach(() => {
  store.clear();
  ingestedThrough = 1_000;
  tip = 1_000;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: tip }),
  });
  return c;
}

const reasons = (p: { unread?: { reason: string }[] }) =>
  (p.unread ?? []).map((u) => u.reason).join(" ");

describe("the private list while the archive catches up", () => {
  it("says the list may be missing the last few minutes", async () => {
    const c = await worker();
    tip = 1_600; // 600 ledgers, about fifty minutes
    const page = await c.history(undefined, 30, "private");
    expect(reasons(page), "the list was silent about being behind").toMatch(
      /may not be listed yet/i,
    );
  });

  it("stays quiet when the archive is keeping up", async () => {
    // Saying it on every read would be noise, and noise teaches people to
    // ignore the line that matters.
    const c = await worker();
    tip = 1_005;
    const page = await c.history(undefined, 30, "private");
    expect(page.unread).toBeUndefined();
  });

  it("stays quiet when the chain's own position cannot be read", async () => {
    // A lag that cannot be measured is not announced: inventing a figure would
    // be worse than the silence this exists to fix.
    const c = await worker();
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account("G".padEnd(56, "A"), "100"),
      getLatestLedger: async () => {
        throw new Error("no rpc");
      },
    });
    const page = await c.history(undefined, 30, "private");
    expect(page.unread).toBeUndefined();
  });

  it("does not put the notice on the public list, which needs no archive", async () => {
    const c = await worker();
    tip = 1_600;
    const page = await c.history(undefined, 30, "public");
    expect(page.unread).toBeUndefined();
  });
});
