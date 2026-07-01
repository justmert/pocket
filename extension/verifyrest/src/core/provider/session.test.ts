// dApp sessions: what a connection does and does not grant.
import { describe, it, expect, beforeEach, vi } from "vitest";

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

const S = await import("./session");
const ADDR = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";

describe("origin is taken from the browser, never from the page", () => {
  it("uses sender.origin when Chrome provides it", () => {
    expect(S.senderOrigin({ origin: "https://app.example" } as chrome.runtime.MessageSender)).toBe(
      "https://app.example",
    );
  });

  it("falls back to the origin of sender.url, not to the url itself", () => {
    expect(
      S.senderOrigin({ url: "https://app.example/deep/path?q=1" } as chrome.runtime.MessageSender),
    ).toBe("https://app.example");
  });

  it("REFUSES when there is no origin to name", () => {
    // A message we cannot attribute must not be attributed to anyone. The
    // alternative is a default, and a default here is a grant.
    expect(() => S.senderOrigin({} as chrome.runtime.MessageSender)).toThrow(S.OriginRefusedError);
    expect(() => S.senderOrigin({ origin: "null" } as chrome.runtime.MessageSender)).toThrow(
      S.OriginRefusedError,
    );
  });
});

describe("a session is scoped to exactly one origin", () => {
  beforeEach(() => store.clear());

  it("does not leak across scheme, subdomain or port", async () => {
    await S.connect("https://app.example", ADDR);
    expect(await S.sessionFor("https://app.example")).not.toBeNull();
    // Each of these is a different security principal and must not inherit.
    expect(await S.sessionFor("http://app.example")).toBeNull();
    expect(await S.sessionFor("https://evil.app.example")).toBeNull();
    expect(await S.sessionFor("https://app.example:8443")).toBeNull();
    expect(await S.sessionFor("https://app.example.evil.com")).toBeNull();
  });

  it("expires rather than lasting forever", async () => {
    await S.connect("https://app.example", ADDR);
    const sessions = await chrome.storage.local.get("pocket.dapps");
    const all = sessions["pocket.dapps"] as Record<string, { connectedAt: number }>;
    all["https://app.example"]!.connectedAt = Date.now() - S.SESSION_TTL_MS - 1;
    await chrome.storage.local.set({ "pocket.dapps": all });

    expect(await S.sessionFor("https://app.example")).toBeNull();
    // And the expired grant is removed, not merely ignored.
    const after = (await chrome.storage.local.get("pocket.dapps"))["pocket.dapps"] as object;
    expect(Object.keys(after)).toHaveLength(0);
  });

  it("records which address was revealed, so an account switch is visible", async () => {
    const s = await S.connect("https://app.example", ADDR);
    expect(s.address).toBe(ADDR);
  });

  it("disconnect and clear remove the grant", async () => {
    await S.connect("https://a.example", ADDR);
    await S.connect("https://b.example", ADDR);
    await S.disconnect("https://a.example");
    expect(await S.sessionFor("https://a.example")).toBeNull();
    expect(await S.sessionFor("https://b.example")).not.toBeNull();

    await S.clearSessions();
    expect(await S.listSessions()).toHaveLength(0);
  });
});
