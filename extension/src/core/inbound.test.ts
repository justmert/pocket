// Crediting a received transfer, and refusing to credit one we cannot verify.
import { describe, it, expect } from "vitest";
import {
  openInbound,
  creditInbound,
  findInbound,
  resumeFrom,
  cursorAfter,
  InboundCreditError,
} from "./inbound";
import { commit, scalarMul, add, H } from "./crypto/grumpkin";
import { xdr, Address, nativeToScVal } from "@stellar/stellar-sdk/base";
import "../lib/polyfill";
import { sharedScalar, transferBlinding, encryptAmount, ephemeralScalar } from "./crypto/derive";
import { R, Q } from "./crypto/field";
import { MAX_AMOUNT } from "./witness/guards";

// A sender builds a transfer exactly as buildTransferWitness does, so what is
// under test is the RECIPIENT reproducing it from the event alone.
function send(vkRecipient: bigint, amount: bigint, sigma: bigint) {
  const pvk = scalarMul(vkRecipient, H);
  const rE = ephemeralScalar(0x1234n, sigma);
  const RE = scalarMul(rE, H);
  const s = sharedScalar(rE, pvk);
  return {
    RE,
    vTilde: encryptAmount(amount, s, sigma),
    sigma,
    opening: { value: amount, randomness: transferBlinding(s, sigma) },
  };
}

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const VK = 0x2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5n;

describe("opening a transfer addressed to us", () => {
  it("recovers the amount and blinding from the event alone", () => {
    const t = send(VK, 250_000n, 0x9f9f9fn);
    const got = openInbound(VK, t.RE, t.vTilde, t.sigma);
    expect(got).not.toBeNull();
    expect(got!.value).toBe(250_000n);
    expect(got!.randomness).toBe(t.opening.randomness);
  });

  it("returns null for a transfer addressed to somebody else", () => {
    // The common case: every transfer on the deployment reaches us.
    const t = send(VK, 250_000n, 0x9f9f9fn);
    const other = openInbound(VK + 1n, t.RE, t.vTilde, t.sigma);
    // Either it does not decrypt at all, or it decrypts to a near-uniform
    // field element that the range bound rejects.
    expect(other === null || other.value >= MAX_AMOUNT).toBe(true);
  });

  it("refuses a non-canonical sigma, which re-encodes one transfer many ways", () => {
    const t = send(VK, 250_000n, 0x9f9f9fn);
    expect(openInbound(VK, t.RE, t.vTilde, t.sigma + R)).toBeNull();
    expect(openInbound(VK, t.RE, t.vTilde + R, t.sigma)).toBeNull();
  });

  it("refuses the identity as an ephemeral point", () => {
    const t = send(VK, 1n, 0x11n);
    expect(openInbound(VK, { x: 0n, y: 0n }, t.vTilde, t.sigma)).toBeNull();
  });
});

describe("crediting against the chain's own accumulator", () => {
  const zero = { value: 0n, randomness: 0n };

  it("credits one transfer when the sum reproduces the commitment", () => {
    const t = send(VK, 500n, 0xa1n);
    const onChain = commit(t.opening.value, t.opening.randomness);
    const got = creditInbound(zero, [{ id: "1", ledger: 1, opening: t.opening }], onChain);
    expect(got.value).toBe(500n);
  });

  it("credits several, in any order, because addition commutes", () => {
    const a = send(VK, 500n, 0xa1n);
    const b = send(VK, 250n, 0xb2n);
    const onChain = add(
      commit(a.opening.value, a.opening.randomness),
      commit(b.opening.value, b.opening.randomness),
    );
    const items = [
      { id: "1", ledger: 1, opening: a.opening },
      { id: "2", ledger: 2, opening: b.opening },
    ];
    expect(creditInbound(zero, items, onChain).value).toBe(750n);
    expect(creditInbound(zero, [...items].reverse(), onChain).value).toBe(750n);
  });

  it("REFUSES a partial set rather than crediting a balance that cannot be spent", () => {
    // The failure this all-or-nothing rule exists for: crediting a subset
    // leaves a balance that looks right and fails at proving time.
    const a = send(VK, 500n, 0xa1n);
    const b = send(VK, 250n, 0xb2n);
    const onChain = add(
      commit(a.opening.value, a.opening.randomness),
      commit(b.opening.value, b.opening.randomness),
    );
    expect(() =>
      creditInbound(zero, [{ id: "1", ledger: 1, opening: a.opening }], onChain),
    ).toThrow(InboundCreditError);
  });

  it("REFUSES a replayed event, because the sum overshoots the chain", () => {
    const a = send(VK, 500n, 0xa1n);
    const onChain = commit(a.opening.value, a.opening.randomness);
    const twice = [
      { id: "1", ledger: 1, opening: a.opening },
      { id: "1-again", ledger: 1, opening: a.opening },
    ];
    expect(() => creditInbound(zero, twice, onChain)).toThrow(InboundCreditError);
  });

  it("accumulates the blinding mod q, never mod r", () => {
    // Trap 1. A blinding reduced by r opens nowhere and the funds are gone.
    const a = { value: 1n, randomness: Q - 1n };
    const b = { value: 1n, randomness: 5n };
    const onChain = add(commit(1n, Q - 1n), commit(1n, 5n));
    const got = creditInbound(
      { value: 0n, randomness: 0n },
      [
        { id: "1", ledger: 1, opening: a },
        { id: "2", ledger: 2, opening: b },
      ],
      onChain,
    );
    expect(got.value).toBe(2n);
    expect(commit(got.value, got.randomness)).toEqual(onChain);
  });
});

describe("the search window comes from the RPC, not from arithmetic", () => {
  // UNPINNED before this. Reverting `health.oldestLedger` to a computed
  // `latestLedger - 120_960` turned nothing red, and this is the bug that cost
  // two live runs to find: a startLedger one ledger outside retention returns
  // ZERO EVENTS WITH NO ERROR, so the widest possible request is the one that
  // silently finds nothing.
  it("asks from the ledger the RPC says it still holds", async () => {
    const seen: { startLedger?: number }[] = [];
    const server = {
      getHealth: async () => ({ latestLedger: 1_000_000, oldestLedger: 879_041 }),
      _getEvents: async (args: { startLedger?: number }) => {
        seen.push(args);
        return { latestLedger: 1_000_000, events: [], cursor: null };
      },
    } as unknown as Parameters<typeof findInbound>[0];

    // Asked from further back than the RPC holds; it must clamp to the floor.
    await findInbound(server, "CTOKEN", ACCOUNT, VK, 1);

    // The floor the RPC REPORTED, not one derived from its latest ledger.
    // Arithmetic gets this wrong whenever retention is not exactly the
    // documented constant, and the reply to a too-early request is silence.
    expect(seen[0]?.startLedger).toBe(879_041);
    expect(seen[0]?.startLedger).toBeGreaterThanOrEqual(879_041);
  });

  it("never asks from before the reported floor, whatever it is handed", async () => {
    const seen: { startLedger?: number }[] = [];
    const server = {
      getHealth: async () => ({ latestLedger: 1_000_000, oldestLedger: 950_000 }),
      _getEvents: async (args: { startLedger?: number }) => {
        seen.push(args);
        return { latestLedger: 1_000_000, events: [], cursor: null };
      },
    } as unknown as Parameters<typeof findInbound>[0];

    // A caller asking from further back than the RPC holds. Passing it through
    // is what produces the silent empty answer.
    await findInbound(server, "CTOKEN", ACCOUNT, VK, 1);
    expect(seen[0]?.startLedger).toBeGreaterThanOrEqual(950_000);
  });
});

// The scan cursor: what it means, and what goes wrong when it is one out.
//
// This is the arithmetic behind an S0. `creditInbound` above is all-or-nothing
// against the accumulator the contract holds, so a cursor that re-reads an
// already-credited event does NOT produce a double credit and does not produce
// a merely stale balance. It produces a pocket that refuses to reconcile, with
// the money on chain, on every retry, forever. The final test here runs that
// scenario rather than asserting on the numbers alone.
describe("the scan cursor", () => {
  it("resumes AFTER the last accounted ledger, because startLedger is inclusive", () => {
    expect(resumeFrom(1000)).toBe(1001);
  });

  it("asks from as far back as retention allows when nothing is accounted for", () => {
    // Not 1 because 1 is interesting: `findInbound` clamps up to the RPC's
    // reported floor, so 1 is how you say "whatever you still hold".
    expect(resumeFrom(0)).toBe(1);
  });

  it("stores the newest ledger it credited from, not the tip it was told about", () => {
    // The tip is read BEFORE a scan that pages the whole retained window, so a
    // transfer landing mid-scan is credited by the scan and skipped by a
    // tip-anchored cursor.
    const found = [
      { id: "a", ledger: 1200, opening: { value: 1n, randomness: 1n } },
      { id: "b", ledger: 1500, opening: { value: 1n, randomness: 1n } },
      { id: "c", ledger: 1300, opening: { value: 1n, randomness: 1n } },
    ];
    expect(cursorAfter(1000, found)).toBe(1500);
  });

  it("never moves backwards", () => {
    // A cursor that can regress is a cursor that can re-read.
    expect(
      cursorAfter(2000, [{ id: "a", ledger: 1500, opening: { value: 1n, randomness: 1n } }]),
    ).toBe(2000);
    expect(cursorAfter(2000, [])).toBe(2000);
  });

  it("does not wedge the pocket when a transfer lands in the cursor's own ledger", () => {
    // The scenario, end to end, with real commitments.
    //
    // Round 1: one transfer at ledger 900, which is also the chain tip the old
    // code recorded. Round 2: a second transfer at 950. The question is whether
    // round 2's scan re-reads the round 1 event.
    const t1 = send(VK, 300n, 0x11n);
    const t2 = send(VK, 700n, 0x22n);
    const zero = { value: 0n, randomness: 0n };

    // Round 1. The chain now holds exactly t1.
    const afterFirst = creditInbound(
      zero,
      [{ id: "e1", ledger: 900, opening: t1.opening }],
      commit(t1.opening.value, t1.opening.randomness),
    );
    const cursor = cursorAfter(0, [{ id: "e1", ledger: 900, opening: t1.opening }]);
    expect(cursor).toBe(900);

    // Round 2. The scan resumes at 901, so ledger 900 is not re-read and the
    // only candidate is t2.
    expect(resumeFrom(cursor)).toBe(901);
    const onChain = add(
      commit(t1.opening.value, t1.opening.randomness),
      commit(t2.opening.value, t2.opening.randomness),
    );
    const afterSecond = creditInbound(
      afterFirst,
      [{ id: "e2", ledger: 950, opening: t2.opening }],
      onChain,
    );
    expect(afterSecond.value).toBe(1000n);

    // And this is what the old cursor did: resuming AT 900 re-finds e1, which
    // is already inside `afterFirst`. Not a double credit, a permanent refusal.
    expect(() =>
      creditInbound(
        afterFirst,
        [
          { id: "e1", ledger: 900, opening: t1.opening },
          { id: "e2", ledger: 950, opening: t2.opening },
        ],
        onChain,
      ),
    ).toThrow(InboundCreditError);
  });
});

// A deposit is a credit nobody needs your permission to make.
//
// `deposit(from, to, amount)` calls `from.require_auth()` and nothing else
// (`mod.rs:291-296`), so anyone can aim one at your receiving commitment, and
// `storage::deposit` credits `amount * G` with blinding ZERO (`storage.rs:512`).
// The scan looked for `transfer` only, so those credits were invisible: the
// pocket read as diverged and the wallet blamed history older than the RPC's
// week-long window, which was not the cause and sent the user after a rebuild
// no shipped build can run.
describe("deposits addressed to us", () => {
  const SENDER = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

  const depositRow = (id: string, ledger: number, from: string, amount: bigint) => ({
    ledger,
    id,
    topic: [
      xdr.ScVal.scvSymbol("deposit").toXDR("base64"),
      Address.fromString(from).toScVal().toXDR("base64"),
      Address.fromString(ACCOUNT).toScVal().toXDR("base64"),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("amount", { type: "symbol" }),
        val: nativeToScVal(amount, { type: "i128" }),
      }),
    ]).toXDR("base64"),
  });

  /** The topic filters the last scan actually sent to the RPC. */
  let asked: string[][] = [];

  const scan = async (rows: unknown[]) => {
    asked = [];
    const server = {
      getHealth: async () => ({ latestLedger: 1_000, oldestLedger: 1 }),
      _getEvents: async (args: { filters?: { topics?: string[][] }[] }) => {
        for (const f of args.filters ?? []) asked.push(...(f.topics ?? []));
        return { latestLedger: 1_000, events: rows, cursor: null };
      },
    } as unknown as Parameters<typeof findInbound>[0];
    return findInbound(server, "CTOKEN", ACCOUNT, VK, 1);
  };

  /** The event name a topic filter matches on, decoded back out. */
  const names = () =>
    asked.map((t) => scValToNativeName(t[0])).filter((n): n is string => n !== null);

  it("ASKS the RPC for deposits, not only transfers", async () => {
    // The half that decoding tests cannot see. Without this filter the RPC
    // never returns a deposit event at all, so every assertion below would
    // pass over a scan that finds nothing in production.
    await scan([]);
    expect(names()).toContain("deposit");
    expect(names()).toContain("transfer");
  });

  it("keeps the recipient match on the filter, so the RPC does the filtering", async () => {
    // On BOTH names. A filter without it pulls every event the contract ever
    // emitted through this loop.
    await scan([]);
    const me = Address.fromString(ACCOUNT).toScVal().toXDR("base64");
    expect(asked).toHaveLength(2);
    for (const t of asked) expect(t[2]).toBe(me);
  });

  it("finds one from a stranger, with the public amount and a zero blinding", async () => {
    const found = await scan([depositRow("e1", 500, SENDER, 7_000_000n)]);
    expect(found).toHaveLength(1);
    expect(found[0]?.opening).toEqual({ value: 7_000_000n, randomness: 0n });
    expect(found[0]?.ledger).toBe(500);
  });

  it("credits it against the accumulator the contract actually holds", async () => {
    // End to end through the same all-or-nothing check every candidate faces.
    const found = await scan([depositRow("e1", 500, SENDER, 7_000_000n)]);
    const credited = creditInbound({ value: 0n, randomness: 0n }, found, commit(7_000_000n, 0n));
    expect(credited).toEqual({ value: 7_000_000n, randomness: 0n });
  });

  it("SKIPS our own shield, which the staged credit already applied", async () => {
    // Counting it twice overshoots the accumulator, and the check refuses
    // rather than miscounting, so this would wedge the pocket rather than
    // inflate it. `from` is exact: a deposit we authorised is one we sent.
    const found = await scan([depositRow("e1", 500, ACCOUNT, 7_000_000n)]);
    expect(found).toHaveLength(0);
  });

  it("still finds transfers, which is what it looked for before", async () => {
    const t = send(VK, 300n, 0x11n);
    const body = xdr.ScVal.scvMap(
      [
        ["r_e_point", nativeToScVal(Buffer.from(encodePointBytes(t.RE)), { type: "bytes" })],
        ["sigma", nativeToScVal(Buffer.from(be32(t.sigma)), { type: "bytes" })],
        ["v_tilde", nativeToScVal(Buffer.from(be32(t.vTilde)), { type: "bytes" })],
      ]
        .sort((a, b) => (a[0] as string).localeCompare(b[0] as string))
        .map(
          ([k, v]) =>
            new xdr.ScMapEntry({
              key: nativeToScVal(k as string, { type: "symbol" }),
              val: v as xdr.ScVal,
            }),
        ),
    );
    const found = await scan([
      {
        ledger: 600,
        id: "e2",
        topic: [
          xdr.ScVal.scvSymbol("transfer").toXDR("base64"),
          Address.fromString(SENDER).toScVal().toXDR("base64"),
          Address.fromString(ACCOUNT).toScVal().toXDR("base64"),
        ],
        value: body.toXDR("base64"),
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.opening).toEqual(t.opening);
  });
});

function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function encodePointBytes(p: { x: bigint; y: bigint }): Uint8Array {
  const out = new Uint8Array(64);
  out.set(be32(p.x), 0);
  out.set(be32(p.y), 32);
  return out;
}

/** The symbol in a base64 topic-filter slot, or null if it is a wildcard. */
function scValToNativeName(t: string | undefined): string | null {
  if (typeof t !== "string" || t === "*") return null;
  try {
    return xdr.ScVal.fromXDR(t, "base64").sym().toString();
  } catch {
    return null;
  }
}
