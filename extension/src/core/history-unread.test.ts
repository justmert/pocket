// "No activity yet" must be a fact about the account, not about the network.
//
// `history()` catches at three layers so one pocket's failure cannot take the
// other's list down with it, which is right. What was wrong is that every catch
// returned `[]` and said nothing, so an unreachable Horizon, an unavailable
// archive and a genuinely empty account arrived as the identical page. The
// screen renders that as "No activity yet. Your transactions will appear here."
//
// The private memo made it stick: a failed read was cached for twenty seconds,
// so the wrong answer outlived the failure that caused it.
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

/** What the public (Horizon) read does this test. */
let publicRead: () => Promise<{ entries: unknown[]; more: boolean; tokenOf?: unknown }>;

vi.mock("./chain/history", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, publicHistory: () => publicRead() };
});

const { WalletController } = await import("./controller");

beforeEach(() => {
  store.clear();
  publicRead = async () => ({ entries: [], more: false, tokenOf: {} });
});

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

/** Make the private replay fail, the way an unreachable archive does. */
function privateFails(c: InstanceType<typeof WalletController>, name: string) {
  (c as unknown as { computePrivateHistory: () => Promise<never> }).computePrivateHistory =
    async () => {
      const e = new Error("http://archive.internal:8080 refused the connection");
      e.name = name;
      throw e;
    };
}

describe("a history half that could not be read", () => {
  it("says nothing is unread when the account really is empty", async () => {
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];

    const page = await c.history();
    expect(page.entries).toEqual([]);
    // The one case where "No activity yet" is true.
    expect(page.unread).toBeUndefined();
  });

  it("reports the private half when the archive does not answer", async () => {
    const c = await worker();
    privateFails(c, "ArchiveUnavailableError");

    const page = await c.history();
    expect(page.unread).toHaveLength(1);
    expect(page.unread?.[0]?.pocket).toBe("private");
    expect(page.unread?.[0]?.reason).toMatch(/archive/i);
  });

  it("reports the public half when Horizon does not answer", async () => {
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];
    publicRead = async () => {
      throw new Error("fetch failed");
    };

    const page = await c.history();
    expect(page.unread?.map((u) => u.pocket)).toEqual(["public"]);
  });

  it("never leaks the archive's own words onto the screen", async () => {
    // The reason string goes straight into the UI, so it is an allowlist by
    // class name, the same discipline `describeError` follows. An RPC message
    // can carry a URL, a port or a stack fragment.
    const c = await worker();
    privateFails(c, "SomethingNobodyNamed");

    const page = await c.history();
    expect(page.unread?.[0]?.reason).not.toMatch(/archive\.internal|8080|refused/);
    expect(page.unread?.[0]?.reason).toMatch(/could not be read/i);
  });

  it("does not memoise a failure, so a recovered read is not shadowed for 20s", async () => {
    // The failed private read used to be cached like a successful one, pinning
    // "you have no private history" in front of the user long after the archive
    // came back.
    const c = await worker();
    privateFails(c, "ArchiveUnavailableError");
    expect((await c.history()).unread).toHaveLength(1);

    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];
    const after = await c.history();
    expect(after.unread).toBeUndefined();
  });
});

describe("a page that found nothing but knows there is more", () => {
  // The deep-scroll dead end. `publicHistory` correctly reports `more: true`
  // when it stops at its page cap, and the cursor was derived from the last
  // entry in the page. With no entries there is no last entry, so the cursor
  // came back null, the popup set its cursor to null, `loadMore` returned early
  // forever, and Activity stopped partway back saying nothing.
  it("still issues a cursor, so the list can keep going", async () => {
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];
    publicRead = async () => ({ entries: [], more: true, tokenOf: {} });

    const { encodeCursor } = await import("./chain/history");
    const before = encodeCursor({ at: 1_700_000_000_000, id: "e", token: "tok-999" });

    const page = await c.history(before);
    expect(page.entries).toEqual([]);
    expect(
      page.cursor,
      "an empty page that knows there is more must not end the list",
    ).not.toBeNull();
  });

  it("carries the Horizon position forward through that empty page", async () => {
    // Otherwise the next call restarts the walk and hits the same wall.
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];
    publicRead = async () => ({ entries: [], more: true, tokenOf: {} });

    const { encodeCursor, decodeCursor } = await import("./chain/history");
    const before = encodeCursor({ at: 1_700_000_000_000, id: "e", token: "tok-999" });

    const page = await c.history(before);
    expect(decodeCursor(page.cursor ?? undefined)?.token).toBe("tok-999");
  });

  it("ends the list when there really is no more", async () => {
    // The other direction: a null cursor still has to mean "that is all".
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown[]> }).computePrivateHistory =
      async () => [];
    publicRead = async () => ({ entries: [], more: false, tokenOf: {} });

    const { encodeCursor } = await import("./chain/history");
    const page = await c.history(encodeCursor({ at: 1, id: "e", token: "tok-1" }));
    expect(page.cursor).toBeNull();
  });
});
