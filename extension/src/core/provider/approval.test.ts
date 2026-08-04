// The dApp signing approval queue.
//
// This existed for hours with nothing calling it: the screen was built, the
// queue was built, and `signTransaction` still refused outright. T5b found it
// by noticing three methods nothing referenced. So these tests exist as much
// to keep the path REACHABLE as to check its behaviour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../lib/polyfill";

const store = new Map<string, unknown>();
const sessionStore = new Map<string, unknown>();
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
    // The dApp grants live in the SESSION area now: RAM-backed, wiped when the
    // browser closes, which is what makes "a connection is dropped when the
    // wallet locks" true rather than nearly true. Its own map, so a test can
    // tell the two areas apart.
    session: {
      get: async (k: string | null) =>
        k === null
          ? Object.fromEntries(sessionStore)
          : sessionStore.has(k)
            ? { [k]: sessionStore.get(k) }
            : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) sessionStore.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) sessionStore.delete(key);
      },
    },
  },
  // No popup to open in a unit test. The queue must not depend on one.
  action: {},
});

const { WalletController } = await import("../controller");
const { describeTransaction } = await import("./describe-tx");

/** A real envelope from this account, so the source check passes. */
async function envelope(source: string, kind: "payment" | "setOptions" = "payment") {
  const { TransactionBuilder, Account, Operation, Asset, BASE_FEE, Networks } = await import(
    "@stellar/stellar-sdk/base"
  );
  const b = new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  b.addOperation(
    kind === "payment"
      ? Operation.payment({
          destination: "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN",
          asset: Asset.native(),
          amount: "1",
        })
      : Operation.setOptions({ homeDomain: "evil.example" }),
  );
  return b.setTimeout(180).build().toXDR();
}

async function connected() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  await c.connectDapp("https://app.example");
  return { c, address };
}

/**
 * Wait for the worker to have parked the request, rather than guessing how long
 * that takes.
 *
 * This was `await new Promise((r) => setTimeout(r, 20))`, which is not a
 * synchronisation primitive: it is a bet that the parking path finishes inside
 * 20ms. On a loaded machine it does not, and the test then reports the queue as
 * broken when it is merely slow. Caught while running the suite alongside a
 * build; it passed five times in a row on its own.
 */
async function parked(c: { pendingDappRequest: () => unknown }, within = 5_000) {
  const deadline = Date.now() + within;
  for (;;) {
    const req = c.pendingDappRequest();
    if (req) return req;
    if (Date.now() > deadline) throw new Error(`no request was parked within ${within}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("a site cannot get a signature without a person answering", () => {
  beforeEach(() => {
    store.clear();
    sessionStore.clear();
  });

  it("parks the request rather than signing, and the popup can see it", async () => {
    const { c, address } = await connected();
    const xdr = await envelope(address);

    const pending = c.sep43("https://app.example", "signTransaction", [xdr]);
    // The worker has NOT signed. It is waiting, and the popup has something
    // to render.
    const req = (await parked(c)) as ReturnType<typeof c.pendingDappRequest>;
    expect(req, "the popup must be able to see the request").not.toBeNull();
    expect(req!.origin).toBe("https://app.example");
    expect(req!.summary.decoded).toBe(true);
    // The SDK normalises an amount to 7 decimals, so the effect line reads
    // "1.0000000". Asserting the loose form would have been asserting my
    // expectation rather than what the user is shown.
    expect(req!.summary.effects.join(" ")).toMatch(/Send 1\.0000000 XLM/);

    c.resolveDappRequest(req!.id, true);
    const res = (await pending) as { signedTxXdr?: string; signerAddress?: string };
    expect(res.signedTxXdr).toBeTruthy();
    expect(res.signerAddress).toBe(address);
  });

  it("a refusal is a refusal, and nothing is signed", async () => {
    const { c, address } = await connected();
    const pending = c.sep43("https://app.example", "signTransaction", [await envelope(address)]);
    await parked(c);
    const req = c.pendingDappRequest()!;
    c.resolveDappRequest(req.id, false);

    const res = (await pending) as { error?: { message: string }; signedTxXdr?: string };
    expect(res.signedTxXdr).toBeUndefined();
    expect(res.error?.message).toMatch(/declined/i);
  });

  it("REFUSES an envelope sourced from a different account", async () => {
    const { c } = await connected();
    // Signing this would hand our signature to a transaction we never looked
    // at, on an account that is not ours.
    const foreign = await envelope("GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN");
    const res = (await c.sep43("https://app.example", "signTransaction", [foreign])) as {
      error?: { message: string };
    };
    expect(res.error?.message).toMatch(/different account/i);
    // And it never reached the queue, so no popup was raised for it.
    expect(c.pendingDappRequest()).toBeNull();
  });

  it("REFUSES bytes it cannot describe, rather than showing a hash to trust", async () => {
    const { c } = await connected();
    const res = (await c.sep43("https://app.example", "signTransaction", ["not-xdr"])) as {
      error?: { message: string };
    };
    expect(res.error).toBeDefined();
    expect(c.pendingDappRequest()).toBeNull();
  });

  it("names an account-security change instead of listing it as an operation", async () => {
    const { address } = await connected();
    const summary = describeTransaction(
      await envelope(address, "setOptions"),
      "Test SDF Network ; September 2015",
    );
    // The user must be told what this operation actually DOES, not shown
    // "setOptions" and left to know what that means, and not shown a constant
    // sentence either: naming the class was the old behaviour and a takeover
    // read identically to this rename. The envelope above sets a home domain,
    // so the effects have to say so and name the domain.
    expect(summary.effects.join(" ")).toMatch(/home domain to evil\.example/);
    expect(summary.warning).toMatch(/who controls the account/i);
  });

  it("refuses a contract call rather than describing it as 'Invoke a smart contract'", async () => {
    // The last blind-signing door. `invokeHostFunction` was on the describable
    // list and its entire sentence was "Invoke a smart contract": no contract
    // id, no function, no arguments, no value, and it was not in ALARMING so
    // nothing warned either. Approve was live under it. It is the ONE operation
    // that can do anything at all, so it was the worst possible one to describe
    // by its type name, which is the exact pattern the describable list was
    // introduced to close for `createClaimableBalance`.
    const { c, address } = await connected();
    const { TransactionBuilder, Account, Operation, Address, nativeToScVal, BASE_FEE, Networks } =
      await import("@stellar/stellar-sdk/base");
    const xdr = new TransactionBuilder(new Account(address, "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        // A token transfer of everything, which is what this looked like as
        // one unadorned line reading "1. Invoke a smart contract".
        Operation.invokeContractFunction({
          contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          function: "transfer",
          args: [
            new Address(address).toScVal(),
            new Address("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6").toScVal(),
            nativeToScVal(9_500_0000000n, { type: "i128" }),
          ],
        }),
      )
      .setTimeout(180)
      .build()
      .toXDR();

    const summary = describeTransaction(xdr, "Test SDF Network ; September 2015");
    expect(summary.decoded).toBe(false);
    expect(summary.effects).toEqual([]);
    // And the refusal says whose limitation it is. The generic sentence reads
    // as "this envelope is broken", which would send a site re-encoding a
    // perfectly good transaction.
    expect(summary.warning).toMatch(/calls a smart contract/i);
    expect(summary.warning).toMatch(/arguments/i);

    // End to end: it never reaches the approval queue, so no screen can offer
    // an Approve button over it.
    const res = (await c.sep43("https://app.example", "signTransaction", [xdr])) as {
      error?: { message: string };
    };
    expect(res.error).toBeDefined();
    expect(c.pendingDappRequest()).toBeNull();
  });

  it("still refuses signAuthEntry and signMessage, which have no screen", async () => {
    const { c } = await connected();
    for (const m of ["signAuthEntry", "signMessage"]) {
      const res = (await c.sep43("https://app.example", m, ["x"])) as {
        error?: { message: string };
      };
      expect(res.error, `${m} must refuse`).toBeDefined();
      expect(c.pendingDappRequest()).toBeNull();
    }
  });
});

/**
 * Revoking a connection has to stop what is already in flight.
 *
 * A site's signature request parks in a queue and waits for a person. Revoking
 * the connection left it sitting there, and answering it later signed for a
 * site the user had just disconnected: measured, `dappSessions` empty, a NEW
 * call from that origin refused, and the disconnected site nonetheless received
 * `{ signed: true, signer: G... }`. A button that means "from now on" while
 * looking like it means "stop" is worse than no button.
 */
describe("revoking a connection", () => {
  beforeEach(() => {
    store.clear();
    sessionStore.clear();
  });

  it("answers a request that site already parked", async () => {
    const { c, address } = await connected();
    const xdr = await envelope(address);

    const pending = c.sep43("https://app.example", "signTransaction", [xdr]);
    await parked(c);

    await c.disconnectDapp("https://app.example");

    const answer = (await pending) as { error?: { message: string } };
    expect(
      answer.error,
      "the request was left parked after the site was disconnected",
    ).toBeDefined();
  });

  it("leaves nothing in the queue for that origin", async () => {
    const { c, address } = await connected();
    const xdr = await envelope(address);
    void c.sep43("https://app.example", "signTransaction", [xdr]);
    await parked(c);

    await c.disconnectDapp("https://app.example");

    expect(c.pendingDappRequest(), "a revoked site's request survived in the queue").toBeNull();
  });

  it("signs nothing for it", async () => {
    const { c, address } = await connected();
    const xdr = await envelope(address);
    const pending = c.sep43("https://app.example", "signTransaction", [xdr]);
    await parked(c);

    await c.disconnectDapp("https://app.example");
    const answer = (await pending) as { signedTxXdr?: string };
    expect(answer.signedTxXdr, "a disconnected site got a signature").toBeUndefined();
  });

  it("does not disturb another site's parked request", async () => {
    // Revocation is per origin. Taking a second site's request down with it
    // would be its own denial of service.
    const { c, address } = await connected();
    await c.connectDapp("https://other.example");
    const xdr = await envelope(address);
    void c.sep43("https://other.example", "signTransaction", [xdr]);
    await parked(c);

    await c.disconnectDapp("https://app.example");
    expect(c.pendingDappRequest()?.origin).toBe("https://other.example");
  });
});
