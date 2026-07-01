// `getEvents`, which is where a received transfer is found or missed.
//
// The same disease as the TTL readers, in a third accessor. `parseRawEvents`
// does `(raw.events ?? []).map(...)`, so a reply carrying NO `events` field at
// all arrives as an empty page and is byte-identical, after the parse, to "the
// window really held nothing for you".
//
// The stakes here are different from a balance, and worth stating precisely.
// `creditInbound` refuses unless the transfers it found reproduce the receiving
// commitment the contract holds, so a lying `getEvents` CANNOT fabricate a
// balance. That check is sound and these tests confirm it. What a lying
// `getEvents` can do is make the wallet assert a confident, wrong EXPLANATION of
// why the pocket is diverged, and send the user to the one remedy that does not
// apply.
//
// Two live shapes the lead measured against the deployment, both of which lie by
// omission rather than by error:
//   - a wide scan returns EMPTY PAGES CARRYING A CURSOR, 38 of them before the
//     first of 195 real events. Treating an empty page as the end reports "you
//     have received nothing" while sitting on a full inbox.
//   - a `startLedger` outside the retention window returns zero events and NO
//     ERROR, so the widest possible request is the one that silently finds
//     nothing.
import { describe, it, expect, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Address, xdr, scValToNative } from "@stellar/stellar-sdk/base";
import "../../src/lib/polyfill";
import { findInbound, creditInbound, openInbound, InboundCreditError } from "../../src/core/inbound";
import { withRequestDeadline } from "../../src/core/chain/http";
import { describeError } from "../../src/core/dispatch";
import { G, H, commit, decodePoint, encodePoint, scalarMul } from "../../src/core/crypto/grumpkin";
import { sharedScalar, encryptAmount, transferBlinding } from "../../src/core/crypto/derive";
import { R, toBytesBE, fromBytesBE } from "../../src/core/crypto/field";
import { FaultServer, DEAD_ORIGIN, rpcOk, rpcError, type Fault } from "./_harness/faults";
import {
  LIVE_TRANSFER_VALUE_B64,
  LIVE_TRANSFER_FIELDS,
} from "./_fixtures/live-transfer-event";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const SENDER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const VK = 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081n;

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serving(opts: Parameters<typeof FaultServer.start>[0]): Promise<rpc.Server> {
  const server = await FaultServer.start(opts);
  open.push(server);
  return withRequestDeadline(new rpc.Server(server.url), 4_000);
}

/**
 * A real transfer addressed to VK, built with the wallet's own crypto.
 *
 * The recipient side needs no sender secret: pick any ephemeral point, derive
 * the shared scalar from it and the viewing key, and encrypt the amount the same
 * way the sender would. That makes the recovery half of these tests an
 * assertion about a genuine credit rather than about a shape.
 */
function inboundEvent(amount: bigint, ephemeralScalar: bigint, sigma: bigint) {
  const RE = scalarMul(ephemeralScalar, G);
  const s = sharedScalar(VK, RE);
  const vTilde = (amount + encryptAmount(0n, s, sigma)) % R;
  const opening = { value: amount, randomness: transferBlinding(s, sigma) };

  const body = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("r_e_point"),
      val: xdr.ScVal.scvBytes(Buffer.from(encodePoint(RE))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("sigma"),
      val: xdr.ScVal.scvBytes(Buffer.from(toBytesBE(sigma))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("v_tilde"),
      val: xdr.ScVal.scvBytes(Buffer.from(toBytesBE(vTilde))),
    }),
  ]);

  return { body: body.toXDR("base64"), opening };
}

const topics = () => [
  xdr.ScVal.scvSymbol("transfer").toXDR("base64"),
  Address.fromString(SENDER).toScVal().toXDR("base64"),
  Address.fromString(ACCOUNT).toScVal().toXDR("base64"),
];

const eventRow = (id: string, ledger: number, valueXdr: string) => ({
  type: "contract",
  ledger,
  ledgerClosedAt: "2026-08-01T00:00:00Z",
  contractId: TOKEN,
  id,
  pagingToken: id,
  inSuccessfulContractCall: true,
  txHash: "aa".repeat(32),
  topic: topics(),
  value: valueXdr,
});

const eventsPage = (rows: unknown[], cursor: string | null): Fault =>
  rpcOk({
    latestLedger: 1_000,
    oldestLedger: 1,
    latestLedgerCloseTime: "1",
    oldestLedgerCloseTime: "1",
    events: rows,
    ...(cursor === null ? {} : { cursor }),
  });

describe("an empty page is not the end of the stream", () => {
  it("keeps paginating past empty pages that carry a cursor", async () => {
    // Measured against the live deployment: 38 consecutive empty pages before
    // the first of 195 real events. Stopping at the first one reports "you have
    // received nothing" while sitting on a full inbox, with no error anywhere.
    const { body, opening } = inboundEvent(500n, 7n, 42n);
    const pages: Fault[] = [];
    for (let i = 0; i < 38; i++) pages.push(eventsPage([], `c${i}`));
    pages.push(eventsPage([eventRow("e1", 900, body)], null));

    const server = await FaultServer.start({ script: pages, fallback: eventsPage([], null) });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const found = await findInbound(client, TOKEN, ACCOUNT, VK, 1);
    expect(found).toHaveLength(1);
    expect(found[0]?.opening.value).toBe(opening.value);
    expect(found[0]?.opening.randomness).toBe(opening.randomness);
  });

  it("stops when the cursor stops moving, rather than asking forever", async () => {
    const server = await serving({ fallback: eventsPage([], "same-cursor") });
    await expect(findInbound(server, TOKEN, ACCOUNT, VK, 1)).resolves.toEqual([]);
  });

  it("terminates against a server that hands out a fresh cursor forever", async () => {
    // An RPC that never stops paginating is not exotic: a page cursor derived
    // from a clock, a proxy rewriting bodies, or a hostile endpoint all produce
    // it. Each REQUEST is bounded by the 30s deadline, but the LOOP is what the
    // user waits on, and `chrome.runtime.sendMessage` has no timeout of its own,
    // so an unbounded loop is a private-pocket screen that spins until MV3 kills
    // the worker and the popup says the wallet did not respond.
    let n = 0;
    const server = await serving({ fallback: () => eventsPage([], `cursor-${n++}`) });

    const settled = await Promise.race([
      findInbound(server, TOKEN, ACCOUNT, VK, 1).then(
        () => "returned",
        () => "refused",
      ),
      new Promise<string>((ok) => setTimeout(() => ok("never settled"), 20_000)),
    ]);
    expect(settled).not.toBe("never settled");
  }, 40_000);
});

describe("a page that did not answer is not an empty page", () => {
  // The calibration signature, in a third accessor. `(raw.events ?? [])` cannot
  // tell "the field is missing" from "the list is empty", and the caller turns
  // an empty result into a specific claim about the ledger's contents.
  const unanswered: [string, Fault][] = [
    [
      "a result with no events field at all",
      rpcOk({ latestLedger: 1_000, oldestLedger: 1, latestLedgerCloseTime: "1", oldestLedgerCloseTime: "1" }),
    ],
    [
      "events: null",
      rpcOk({
        latestLedger: 1_000,
        oldestLedger: 1,
        latestLedgerCloseTime: "1",
        oldestLedgerCloseTime: "1",
        events: null,
      }),
    ],
  ];

  for (const [name, fault] of unanswered) {
    it(`does not report "nothing received" from ${name}`, async () => {
      const server = await serving({ fallback: fault });
      const said = await findInbound(server, TOKEN, ACCOUNT, VK, 1).then(
        (found) =>
          found.length === 0
            ? "reported nothing received, from a page that answered nothing"
            : "found events",
        () => "refused",
      );
      expect(said).toBe("refused");
    });

    it(`refuses ${name} in words we authored, not by crashing`, async () => {
      // Refusing by accident is not the same as refusing. Reading `events` off
      // a page that has none throws `TypeError: page.events is not iterable`,
      // which satisfies "did not report nothing received" while being a
      // stack-shaped string nobody wrote for a user. It matters here rather
      // than being pedantic: `creditInboundTransfers` catches this and
      // interpolates `e.message` RAW into the diverged screen, so the JS
      // internal message is what the user actually reads.
      const server = await serving({ fallback: fault });
      const err = await findInbound(server, TOKEN, ACCOUNT, VK, 1).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeTruthy();
      expect(err?.name).not.toBe("TypeError");
      expect(err?.message ?? "").not.toMatch(/is not iterable|undefined|Cannot read/i);
    });
  }

  const transport: [string, Fault][] = [
    ["a 429", { kind: "rateLimited" }],
    ["a 500", { kind: "text", status: 500, body: "upstream failure" }],
    ["HTML on a 200", { kind: "text", status: 200, contentType: "text/html", body: "<html/>" }],
    ["an empty 200 body", { kind: "text", status: 200, contentType: "application/json", body: "" }],
    ["a JSON-RPC error object", rpcError("SECRET-RPC-STRING")],
    ["result: null", rpcOk(null)],
    ["a truncated body", { kind: "truncated", body: '{"jsonrpc":"2.0","id":1,"resu' }],
    ["a connection reset", { kind: "reset" }],
  ];

  for (const [name, fault] of transport) {
    it(`refuses ${name} rather than reporting nothing received`, async () => {
      const server = await serving({ fallback: fault });
      await expect(findInbound(server, TOKEN, ACCOUNT, VK, 1)).rejects.toThrow();
    });
  }

  it("refuses a dead port", async () => {
    const server = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 3_000);
    await expect(findInbound(server, TOKEN, ACCOUNT, VK, 1)).rejects.toThrow();
  });

  it("never puts the RPC's own words on screen", async () => {
    const server = await serving({ fallback: rpcError("SECRET-RPC-STRING") });
    const said = await findInbound(server, TOKEN, ACCOUNT, VK, 1).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-RPC-STRING");
  });
});

describe("the recipient filter is applied on every page, not just the first", () => {
  it("asks about this account's transfers on the cursor branch too", async () => {
    // Without the filter on the paginated call, every later page pulls every
    // event the contract ever emitted, and the all-or-nothing credit check ends
    // up reasoning about a different event set than the first page did.
    const server = await FaultServer.start({
      script: [eventsPage([], "c1"), eventsPage([], "c2")],
      fallback: eventsPage([], null),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
    await findInbound(client, TOKEN, ACCOUNT, VK, 1);

    const asked = server.requests.filter((r) => r.method === "getEvents");
    expect(asked.length).toBeGreaterThan(1);
    const me = Address.fromString(ACCOUNT).toScVal().toXDR("base64");
    for (const r of asked) {
      expect(r.body).toContain(me);
      expect(r.body).toContain(TOKEN);
    }
  });
});

describe("the decoder is pinned against the contract, not against our encoder", () => {
  // The `bigint` decode bug was found by printing a live event, not by a failing
  // test, and the reason no test caught it is worth stating: every fixture that
  // exercised this path was built with the same encoder the fix expects. Those
  // tests agree with the fix by construction. They cannot disagree with it, so
  // they cannot pin it.
  //
  // `_fixtures/live-transfer-event.ts` is a real event body off the deployed
  // contract. It cannot drift from the contract because it came from it.

  const live = () => scValToNative(xdr.ScVal.fromXDR(LIVE_TRANSFER_VALUE_B64, "base64")) as
    Record<string, unknown>;

  it("publishes exactly the eight fields, at the widths we decode", () => {
    const body = live();
    expect(Object.keys(body).sort()).toEqual(Object.keys(LIVE_TRANSFER_FIELDS).sort());
    for (const [name, width] of Object.entries(LIVE_TRANSFER_FIELDS)) {
      const v = body[name];
      expect(v, `${name} is absent`).toBeDefined();
      expect(v instanceof Uint8Array, `${name} decoded as ${typeof v}, not bytes`).toBe(true);
      expect((v as Uint8Array).length, `${name} width`).toBe(width);
    }
  });

  it("publishes BYTES, never bigints, which is the bug this pins", () => {
    // Stated as its own assertion because it is the exact mistake: a
    // `typeof x === "bigint"` check silently rejects every real event and the
    // inbound search reports an empty inbox with no error anywhere.
    const body = live();
    for (const name of ["r_e_point", "v_tilde", "sigma"]) {
      expect(typeof body[name], `${name} is a bigint on the wire`).not.toBe("bigint");
    }
  });

  it("decodes and credits a transfer carrying the contract's own point and salt", async () => {
    // The strongest form available without the recipient's key: the ephemeral
    // point and the salt are the REAL bytes from ledger 3900337, in the real
    // encoding, and only `v_tilde` is recomputed so the transfer is addressed
    // to a key this test holds. If the decoder expects bigints, this finds
    // nothing.
    const body = live();
    const RE = decodePoint(body.r_e_point as Uint8Array);
    const sigma = fromBytesBE(body.sigma as Uint8Array);
    const amount = 4_200n;
    const s = sharedScalar(VK, RE);
    const vTilde = (amount + encryptAmount(0n, s, sigma)) % R;

    const entry = (name: string, val: xdr.ScVal) =>
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
    const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
    const rebuilt = xdr.ScVal.scvMap([
      entry("r_e_point", bytes(body.r_e_point as Uint8Array)),
      entry("sigma", bytes(body.sigma as Uint8Array)),
      entry("v_tilde", bytes(toBytesBE(vTilde))),
    ]);

    const server = await serving({
      fallback: eventsPage([eventRow("live", 3_900_337, rebuilt.toXDR("base64"))], null),
    });
    const found = await findInbound(server, TOKEN, ACCOUNT, VK, 1);
    expect(found, "the real point and salt were not decoded").toHaveLength(1);
    expect(found[0]?.opening.value).toBe(amount);
    expect(found[0]?.opening.randomness).toBe(transferBlinding(s, sigma));
  });
});

describe("a credit is refused unless the chain agrees, whatever the RPC served", () => {
  it("credits a real transfer that reproduces the contract's commitment", async () => {
    const { opening } = inboundEvent(500n, 7n, 42n);
    const before = { value: 0n, randomness: 0n };
    const after = {
      value: before.value + opening.value,
      randomness: before.randomness + opening.randomness,
    };
    const onChain = commit(after.value, after.randomness);
    const credited = creditInbound(before, [{ id: "e1", ledger: 9, opening }], onChain);
    expect(credited.value).toBe(500n);
  });

  it("refuses a partial set, rather than crediting a balance that cannot be spent", async () => {
    // The backstop that makes a lying getEvents unable to fabricate a balance.
    // Crediting a subset leaves funds that look present and fail at submit time.
    const a = inboundEvent(500n, 7n, 42n).opening;
    const b = inboundEvent(300n, 11n, 43n).opening;
    const before = { value: 0n, randomness: 0n };
    const onChain = commit(a.value + b.value, a.randomness + b.randomness);
    expect(() => creditInbound(before, [{ id: "e1", ledger: 9, opening: a }], onChain)).toThrow(
      InboundCreditError,
    );
  });

  it("says what happened and what it means, in words we authored", () => {
    const onChain = commit(1n, 2n);
    const said = (() => {
      try {
        creditInbound({ value: 0n, randomness: 0n }, [], onChain);
        return "resolved";
      } catch (e) {
        return describeError(e);
      }
    })();
    expect(said).toMatch(/will not credit them/i);
    expect(said).toMatch(/funds are safe on chain/i);
    expect(said).not.toBe("Something went wrong. Try again, and check your connection.");
  });

  it("does not open a transfer that was addressed to somebody else", () => {
    // Every transfer on the deployment reaches us and only some are ours.
    // Returning null for the rest is correct and must not read as a failure.
    // The SAME ciphertext, opened with two viewing keys. An arbitrary v_tilde
    // would not test anything: it fails to decrypt to 500 whatever the key is,
    // so the assertion could not tell a key-checked decryption from one that
    // ignored the key entirely. Mutation V5 found exactly that.
    const RE = scalarMul(3n, G);
    const vTilde = (500n + encryptAmount(0n, sharedScalar(VK, RE), 42n)) % R;
    const ours = openInbound(VK, RE, vTilde, 42n);
    const notOurs = openInbound(VK + 1n, RE, vTilde, 42n);
    expect(ours?.value).toBe(500n);
    expect(notOurs === null || notOurs.value !== 500n).toBe(true);
  });

  it("refuses a non-canonical re-encoding of a real transfer", () => {
    // The sponge reduces every absorbed input mod r, so sigma and sigma + r
    // derive the identical mask. Accepting both would give one on-chain
    // transfer unboundedly many re-encodings that all decrypt to the same
    // credit.
    const RE = scalarMul(7n, G);
    const s = sharedScalar(VK, RE);
    const vTilde = (500n + encryptAmount(0n, s, 42n)) % R;
    expect(openInbound(VK, RE, vTilde, 42n + R)).toBeNull();
    expect(openInbound(VK, RE, vTilde + R, 42n)).toBeNull();
  });

  it("refuses the identity as an ephemeral point", () => {
    expect(openInbound(VK, { x: 0n, y: 0n }, 1n, 1n)).toBeNull();
  });
});

describe("recovery: the transfer is found once the RPC answers", () => {
  it("returns nothing while degraded, then the real transfer once it heals", async () => {
    const { body, opening } = inboundEvent(750n, 13n, 99n);
    const server = await FaultServer.start({ fallback: { kind: "rateLimited" } });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    await expect(findInbound(client, TOKEN, ACCOUNT, VK, 1)).rejects.toThrow();

    server.heal({ fallback: eventsPage([eventRow("e1", 900, body)], null) });
    const found = await findInbound(client, TOKEN, ACCOUNT, VK, 1);
    expect(found).toHaveLength(1);
    expect(found[0]?.opening.value).toBe(750n);

    // And the credit it produces reproduces what the contract would hold.
    const onChain = commit(opening.value, opening.randomness);
    expect(creditInbound({ value: 0n, randomness: 0n }, found, onChain).value).toBe(750n);
  });
});

/** Unused import guard: H is re-exported for readers checking the commitment basis. */
void H;
