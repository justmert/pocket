import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import {
  readAccountTtl,
  needsKeepAlive,
  jitteredDelayMs,
  KEEPALIVE_THRESHOLD_DAYS,
  SECONDS_PER_LEDGER,
} from "./ttl";
import { NETWORKS } from "../config";

/** Addresses come from the tracked config, never from an untracked file. */
function deployment() {
  const c = NETWORKS.testnet.confidential[0];
  if (!c) throw new Error("no confidential deployment configured for testnet");
  return c;
}

const dep = deployment();
const server = new rpc.Server(NETWORKS.testnet.rpcUrl);
const REGISTERED = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

describe("live TTL of our registered account", () => {
  it("reads a real expiry and reports it as a date", async () => {
    const s = await readAccountTtl(server, dep.token, REGISTERED, "testnet");
    // We registered minutes ago, so it must be live.
    expect(["healthy", "expiring"]).toContain(s.kind);
    if (s.kind === "healthy" || s.kind === "expiring") {
      expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(s.daysRemaining).toBeGreaterThan(0);
      console.log(
        `account TTL: ${s.kind}, ${s.daysRemaining.toFixed(1)} days, expires ${s.expiresAt.toISOString()}`,
      );
    }
  }, 30_000);

  it("reports an account that never registered as absent", async () => {
    const ghost = Keypair.random().publicKey();
    expect((await readAccountTtl(server, dep.token, ghost, "testnet")).kind).toBe("absent");
  }, 30_000);
});

describe("keep-alive policy", () => {
  it("triggers only inside the threshold window", () => {
    expect(needsKeepAlive({ kind: "expiring", expiresAt: new Date(), daysRemaining: 3 })).toBe(
      true,
    );
    expect(needsKeepAlive({ kind: "healthy", expiresAt: new Date(), daysRemaining: 25 })).toBe(
      false,
    );
    // Archived is past keep-alive: it needs a restore, not a bump.
    expect(needsKeepAlive({ kind: "archived" })).toBe(false);
    expect(needsKeepAlive({ kind: "absent" })).toBe(false);
  });

  it("keeps a week of headroom", () => {
    expect(KEEPALIVE_THRESHOLD_DAYS).toBe(7);
  });

  it("jitters the schedule so a fixed cadence cannot fingerprint users", () => {
    // A keep-alive is publicly visible and its timing is observable. Every
    // Pocket user bumping on the same clock would be a signature.
    const delays = new Set(Array.from({ length: 50 }, () => jitteredDelayMs(20)));
    expect(delays.size).toBeGreaterThan(40);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(20 * 86_400_000);
      expect(d).toBeGreaterThanOrEqual(19 * 86_400_000);
    }
  });

  it("uses per-network ledger timing", () => {
    // Calibrating TTL logic on testnet would be wrong by a factor of 17:
    // min_persistent_ttl is 120,960 ledgers there against 2,073,600 on mainnet.
    expect(SECONDS_PER_LEDGER.testnet).not.toBe(SECONDS_PER_LEDGER.mainnet);
  });
});

describe("infrastructure TTL, the systemic single point of failure", () => {
  it("reads the verifier's instance TTL", async () => {
    // The verifier holds every verification key in INSTANCE storage, and the
    // library never extends it. If it archives, every confidential operation
    // on every token pointing at it fails. We deployed it, so we watch it.
    const { readInstanceTtl } = await import("./ttl");
    const s = await readInstanceTtl(server, dep.verifier, "testnet");
    expect(["healthy", "expiring"]).toContain(s.kind);
    if (s.kind !== "archived" && s.kind !== "absent") {
      console.log(`verifier instance TTL: ${s.daysRemaining.toFixed(1)} days`);
    }
  }, 30_000);

  it("reads the token wrapper's instance TTL", async () => {
    const { readInstanceTtl } = await import("./ttl");
    const s = await readInstanceTtl(server, dep.token, "testnet");
    expect(["healthy", "expiring"]).toContain(s.kind);
    if (s.kind !== "archived" && s.kind !== "absent") {
      console.log(`token instance TTL: ${s.daysRemaining.toFixed(1)} days`);
    }
  }, 30_000);

  it("reads the auditor registry's instance TTL", async () => {
    const { readInstanceTtl } = await import("./ttl");
    const s = await readInstanceTtl(server, dep.auditor, "testnet");
    expect(["healthy", "expiring"]).toContain(s.kind);
  }, 30_000);
});
