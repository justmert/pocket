// The dApp signing approval queue.
//
// This existed for hours with nothing calling it: the screen was built, the
// queue was built, and `signTransaction` still refused outright. T5b found it
// by noticing three methods nothing referenced. So these tests exist as much
// to keep the path REACHABLE as to check its behaviour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../lib/polyfill";

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

describe("a site cannot get a signature without a person answering", () => {
  beforeEach(() => store.clear());

  it("parks the request rather than signing, and the popup can see it", async () => {
    const { c, address } = await connected();
    const xdr = await envelope(address);

    const pending = c.sep43("https://app.example", "signTransaction", [xdr]);
    // The worker has NOT signed. It is waiting, and the popup has something
    // to render.
    await new Promise((r) => setTimeout(r, 20));
    const req = c.pendingDappRequest();
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
    await new Promise((r) => setTimeout(r, 20));
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
    // The user must be told what this class of operation can do, not shown
    // "setOptions" and left to know what that means.
    expect(summary.effects.join(" ")).toMatch(/ACCOUNT SECURITY SETTINGS/);
    expect(summary.warning).toMatch(/who controls the account/i);
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
