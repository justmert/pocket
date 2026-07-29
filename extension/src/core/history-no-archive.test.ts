// A build with no archive must not claim the account has no private history.
//
// Nothing else about the private pocket needs the archive: register, shield,
// private transfer, merge and unshield all run off local openings and Soroban
// RPC, and only the rebuild reads it. So a package shipped without
// VITE_ARCHIVE_URL has a fully working private pocket whose Activity read "No
// activity yet. Your transactions will appear here." forever, which is a claim
// about the ACCOUNT and is false.
//
// Not hypothetical: `.env.production` ships the variable commented out, so this
// is the state of every installable build until an archive is deployed.
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

// The shape a package built with no VITE_ARCHIVE_URL actually has. Set here
// rather than relied on, because a unit run has no build env either way and a
// test that passes for the wrong reason is not a test.
vi.mock("./config", async (orig) => {
  const real = (await orig()) as { NETWORKS: Record<string, Record<string, unknown>> };
  return {
    ...real,
    NETWORKS: {
      ...real.NETWORKS,
      testnet: { ...real.NETWORKS.testnet, archiveUrl: undefined },
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");

beforeEach(() => store.clear());

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

describe("private activity on a build with no archive configured", () => {
  it("has the premise this file needs: no archive URL", () => {
    // Guards against the mock drifting and every assertion below passing
    // vacuously against a configured build.
    expect(NETWORKS.testnet.archiveUrl).toBeUndefined();
  });

  it("says the archive is missing rather than that there is nothing", async () => {
    const c = await worker();
    const page = await c.history(undefined, 30, "private");

    expect(page.entries).toEqual([]);
    expect(page.unread, "an empty page with no reason renders as 'No activity yet'").toBeDefined();
    expect(page.unread!.map((u) => u.reason).join(" ")).toMatch(/durable event archive/i);
  });

  it("says the balances are unaffected, because they are", async () => {
    // The private pocket works completely without the archive. A user told
    // their activity cannot be read must not conclude their money is at risk.
    const c = await worker();
    const page = await c.history(undefined, 30, "private");
    expect(page.unread!.map((u) => u.reason).join(" ")).toMatch(/balances are unaffected/i);
  });

  it("attributes it to the private pocket, not the public one", async () => {
    const c = await worker();
    const page = await c.history(undefined, 30, "private");
    expect(page.unread!.every((u) => u.pocket === "private")).toBe(true);
  });

  it("leaves the public list alone", async () => {
    // The public half needs no archive at all, so nothing about it changes.
    const c = await worker();
    const page = await c.history(undefined, 30, "public");
    expect(page.unread).toBeUndefined();
  });
});
