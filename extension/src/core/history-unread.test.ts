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

/** What the ARCHIVE does. Only the network read is faked; the loop is the real one. */
let archiveRead: (token: string) => Promise<unknown[]>;

vi.mock("./chain/archive", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    ArchiveClient: class {
      async allEvents(token: string) {
        return archiveRead(token);
      }
    },
  };
});

// Yield and the archive URL are build-time env, absent in a unit run. Supplied
// here so `computePrivateHistory` gets past its own `!net.archiveUrl` branch and
// the per-asset loop under test is reachable at all.
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

beforeEach(() => {
  store.clear();
  publicRead = async () => ({ entries: [], more: false, tokenOf: {} });
  archiveRead = async () => [];
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
    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });

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
    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });
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

    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });
    const after = await c.history();
    expect(after.unread).toBeUndefined();
  });
});

describe("the REAL private read, not a stub standing in for it", () => {
  // Every test above replaces `computePrivateHistory` wholesale, and that method
  // is exactly where the defect lived: a per-asset `catch {}` swallowed every
  // failure of the replay, so the method could never reject, so the reporting
  // the tests above assert was unreachable in production. A test that mocks over
  // the broken function passes while the bug ships. These drive the real loop.

  it("reports an archive outage instead of calling it an empty account", async () => {
    const c = await worker();
    archiveRead = async () => {
      throw new Error("https://archive.invalid refused the connection");
    };

    const page = await c.history(undefined, 30, "private");
    expect(page.entries).toEqual([]);
    expect(page.unread, "an archive outage rendered as 'No activity yet'").toHaveLength(1);
    expect(page.unread?.[0]?.pocket).toBe("private");
  });

  it("names the assets it could not read, and nothing the archive said", async () => {
    const c = await worker();
    archiveRead = async () => {
      throw new Error("https://archive.invalid:8080 refused the connection");
    };

    const page = await c.history(undefined, 30, "private");
    const reason = page.unread?.[0]?.reason ?? "";
    expect(reason).toMatch(/XLM/);
    expect(reason, "the archive's own words reached the screen").not.toMatch(
      /archive\.invalid|8080|refused/,
    );
  });

  it("still shows the assets it COULD read, and says the list is incomplete", async () => {
    // The per-asset isolation is right and stays. Only the silence was wrong.
    const c = await worker();
    const { NETWORKS } = await import("./config");
    const first = NETWORKS.testnet.confidential[0]!.token;
    archiveRead = async (token: string) => {
      if (token === first) throw new Error("gap");
      return [];
    };

    const page = await c.history(undefined, 30, "private");
    expect(page.unread).toHaveLength(1);
    expect(page.unread?.[0]?.reason).toMatch(/incomplete/i);
  });

  it("does not pin a partial answer in the memo for twenty seconds", async () => {
    // The memo caches a successful read so scrolling does not re-replay the
    // archive. Caching a PARTIAL one kept the wrong answer on screen after the
    // archive came back, which is the same defect one level down.
    const c = await worker();
    let calls = 0;
    let down = true;
    archiveRead = async () => {
      calls++;
      if (down) throw new Error("down");
      return [];
    };
    await c.history(undefined, 30, "private");
    const firstCalls = calls;
    expect(firstCalls).toBeGreaterThan(0);

    down = false;
    const after = await c.history(undefined, 30, "private");
    expect(calls, "the failed read was memoised and never retried").toBeGreaterThan(firstCalls);
    expect(after.unread).toBeUndefined();
  });

  it("says so when the build has no archive at all, rather than 'no activity'", async () => {
    // `.env.production` ships VITE_ARCHIVE_URL commented out, and nothing else
    // about the private pocket needs an archive: shield, transfer, merge and
    // unshield all work off local openings. So this build has a working private
    // pocket whose Activity claimed the account had never done anything.
    vi.resetModules();
    vi.doMock("./config", async (orig) => {
      const real = (await orig()) as { NETWORKS: Record<string, Record<string, unknown>> };
      return {
        ...real,
        NETWORKS: {
          ...real.NETWORKS,
          testnet: { ...real.NETWORKS.testnet, archiveUrl: undefined },
        },
      };
    });
    const { WalletController: Fresh } = await import("./controller");
    const c2 = new Fresh();
    await c2.init();
    await c2.create("pw2");

    const page = await c2.history(undefined, 30, "private");
    expect(page.entries).toEqual([]);
    expect(page.unread, "a build with no archive claimed the account was empty").toHaveLength(1);
    expect(page.unread?.[0]?.reason).toMatch(/archive/i);
    vi.doUnmock("./config");
    vi.resetModules();
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
    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });
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
    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });
    publicRead = async () => ({ entries: [], more: true, tokenOf: {} });

    const { encodeCursor, decodeCursor } = await import("./chain/history");
    const before = encodeCursor({ at: 1_700_000_000_000, id: "e", token: "tok-999" });

    const page = await c.history(before);
    expect(decodeCursor(page.cursor ?? undefined)?.token).toBe("tok-999");
  });

  it("ends the list when there really is no more", async () => {
    // The other direction: a null cursor still has to mean "that is all".
    const c = await worker();
    (c as unknown as { computePrivateHistory: () => Promise<unknown> }).computePrivateHistory =
      async () => ({ entries: [] });
    publicRead = async () => ({ entries: [], more: false, tokenOf: {} });

    const { encodeCursor } = await import("./chain/history");
    const page = await c.history(encodeCursor({ at: 1, id: "e", token: "tok-1" }));
    expect(page.cursor).toBeNull();
  });
});
