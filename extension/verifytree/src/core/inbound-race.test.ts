// A late inbound credit must not overwrite a newer opening.
//
// `privatePocket()` is a read that happens to WRITE: since inbound crediting
// landed it persists what it finds. The scan in the middle paginates the RPC's
// whole retained window, which is slow, and the popup calls it on every mount.
// So two tabs are enough: one scans, the other merges, the scan finishes and
// writes back a snapshot taken before the merge. The receiving side is the
// point of the write; the SPENDABLE side rides along stale, and a spendable
// opening that no longer matches the chain is money that can never be proved
// against again.
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

const { WalletController } = await import("./controller");

describe("the queue covers every write to the opening store", () => {
  beforeEach(() => store.clear());

  it("serialises a slow credit against a fast merge, rather than letting it win", async () => {
    const c = new WalletController();
    await c.init();
    await c.create("pw");

    // Two writes issued together, one deliberately slower. Whichever runs
    // second must observe the first: that is what the queue is for, and it is
    // the property that was missing when the credit path wrote outside it.
    const order: string[] = [];
    const slow = c["exclusive"](async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
    });
    const fast = c["exclusive"](async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);

    // Issued slow-first, so slow must complete first. If the queue were not
    // covering both, "fast" would land first and a stale write could follow a
    // fresh one.
    expect(order).toEqual(["slow", "fast"]);
  });

  it("keeps the queue usable after a write throws", async () => {
    const c = new WalletController();
    await c.init();
    await expect(
      c["exclusive"](async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    // One failure must not wedge every later write, or a single bad credit
    // freezes the wallet.
    await expect(c["exclusive"](async () => "ok")).resolves.toBe("ok");
  });
});
