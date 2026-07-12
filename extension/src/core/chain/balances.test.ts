import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import { Asset, StrKey, xdr } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import {
  readNative,
  readTrustline,
  AccountNotFoundError,
  LedgerEntryMismatchError,
  displayAmount,
  composeAmount,
} from "./balances";

const MINE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const THEIRS = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const OTHER_ASSET = new Asset("EURC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

const pubkey = (g: string) => xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(g));

function accountEntry(owner: string, balance: string) {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: pubkey(owner),
      balance: xdr.Int64.fromString(balance),
      // SequenceNumber is a typedef for Int64 in the XDR (curr.x).
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.alloc(4),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );
}

function trustlineEntry(owner: string, asset: Asset, balance: string) {
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: pubkey(owner),
      asset: asset.toTrustLineXDRObject(),
      balance: xdr.Int64.fromString(balance),
      limit: xdr.Int64.fromString("9223372036854775807"),
      flags: 1,
      ext: new xdr.TrustLineEntryExt(0),
    }),
  );
}

/**
 * A server answering at the RAW layer, which is where the code now reads.
 *
 * `echoKey` defaults to the key that was requested, which is what a compliant
 * RPC does and what live testnet was confirmed to do byte for byte.
 */
const serverReturning = (
  data: xdr.LedgerEntryData | null,
  opts: { echoKey?: xdr.LedgerKey; entries?: unknown } = {},
): rpc.Server =>
  ({
    _getLedgerEntries: async (key: xdr.LedgerKey) => ({
      latestLedger: 1,
      entries:
        "entries" in opts
          ? opts.entries
          : data === null
            ? []
            : [{ key: (opts.echoKey ?? key).toXDR("base64"), xdr: data.toXDR("base64") }],
    }),
  }) as unknown as rpc.Server;

const someOtherKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: pubkey(THEIRS) }));

describe("absent must be said explicitly, never inferred", () => {
  // The SDK's parsed getLedgerEntries does `(raw.entries ?? []).map(...)`, so a
  // response with NO entries field arrives as an empty array, indistinguishable
  // from "this account does not exist". controller.balances() renders zero for
  // exactly that condition, so a malformed reply became a confident 0.0000000
  // on a funded wallet. Found by inducing it, not by reading the code.
  it("refuses a response carrying no entries field at all", async () => {
    await expect(
      readNative(serverReturning(null, { entries: undefined }), MINE),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("refuses a response whose entries field is null", async () => {
    await expect(readNative(serverReturning(null, { entries: null }), MINE)).rejects.toBeInstanceOf(
      LedgerEntryMismatchError,
    );
  });

  it("refuses a response whose entries field is not a list", async () => {
    await expect(
      readNative(serverReturning(null, { entries: { 0: "nope" } }), MINE),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("accepts an explicit empty list as genuinely absent", async () => {
    // Confirmed against live testnet: a never-funded account replies with
    // exactly `entries: []`. This is the one path allowed to render zero.
    await expect(readNative(serverReturning(null), MINE)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });

  it("reports an absent trustline as null rather than as zero", async () => {
    expect(await readTrustline(serverReturning(null), MINE, USDC)).toBeNull();
  });
});

describe("the ledger's answer must be about the question", () => {
  // A wallet renders whatever this returns as the user's own money. Nothing in
  // the SDK checks a returned entry against the key that was requested, so a
  // hostile RPC, a caching proxy, or a mismatched batch response can put
  // somebody else's balance on the screen. Observed before this check: a
  // stranger's 12345.6789 XLM came back with no complaint at all.
  it("refuses an entry echoed under a different ledger key", async () => {
    await expect(
      readNative(
        serverReturning(accountEntry(THEIRS, "123456789000"), { echoKey: someOtherKey }),
        MINE,
      ),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("refuses an AccountEntry for a different account even when the key echo is right", async () => {
    // Belt and braces: an RPC that echoes the requested key beside the wrong
    // body still does not get a number on screen.
    await expect(
      readNative(serverReturning(accountEntry(THEIRS, "123456789000")), MINE),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("accepts the account it actually asked about", async () => {
    const got = await readNative(serverReturning(accountEntry(MINE, "123456789000")), MINE);
    expect(got.raw).toBe(123456789000n);
  });

  it("refuses an entry of the wrong ledger type", async () => {
    await expect(
      readNative(serverReturning(trustlineEntry(MINE, USDC, "5")), MINE),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("refuses a trustline held by a different account", async () => {
    await expect(
      readTrustline(serverReturning(trustlineEntry(THEIRS, USDC, "5")), MINE, USDC),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("refuses a trustline for a different asset", async () => {
    await expect(
      readTrustline(serverReturning(trustlineEntry(MINE, OTHER_ASSET, "5")), MINE, USDC),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });

  it("accepts the trustline it actually asked about", async () => {
    const got = await readTrustline(
      serverReturning(trustlineEntry(MINE, USDC, "50000000")),
      MINE,
      USDC,
    );
    expect(got?.raw).toBe(50000000n);
    expect(got?.authorized).toBe(true);
  });

  it("refuses an entry whose xdr body is missing", async () => {
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: pubkey(MINE) }));
    await expect(
      readNative(serverReturning(null, { entries: [{ key: key.toXDR("base64") }] }), MINE),
    ).rejects.toBeInstanceOf(LedgerEntryMismatchError);
  });
});

describe("displayAmount", () => {
  it("shortens like capDecimals for anything it can express", () => {
    expect(displayAmount("12.5000000")).toBe("12.5");
    expect(displayAmount("1.0000500")).toBe("1");
    expect(displayAmount("1000.1234567")).toBe("1000.1234");
    expect(displayAmount("40")).toBe("40");
  });

  it("never states that a nonzero amount is zero", () => {
    // The defect: Stellar carries seven decimals and the row shows four, so a
    // real receipt of 0.00001 XLM rendered as "0 XLM" and the row asserted that
    // nothing moved. Reproduced against the real function.
    expect(displayAmount("0.0000100")).toBe("<0.0001");
    expect(displayAmount("0.0000001")).toBe("<0.0001");
    expect(displayAmount("0.0000999")).toBe("<0.0001");
  });

  it("still says zero when the amount really is zero", () => {
    expect(displayAmount("0")).toBe("0");
    expect(displayAmount("0.0000000")).toBe("0");
  });

  it("keeps the boundary value itself, which four places can express", () => {
    expect(displayAmount("0.0001000")).toBe("0.0001");
  });

  it("honours a different precision", () => {
    expect(displayAmount("0.0000001", 7)).toBe("0.0000001");
    expect(displayAmount("0.001", 2)).toBe("<0.01");
  });
});

describe("composeAmount", () => {
  it("shortens to the display cap when it can", () => {
    expect(composeAmount("99.9999999", 4)).toBe("99.9999");
    expect(composeAmount("40.0000000", 4)).toBe("40");
  });

  it("never fills the field with zero for a balance that is not zero", () => {
    // "Use max" on a balance whose whole value lives below the fourth place
    // truncated to "0" and left Continue live, so the control whose job is
    // "send everything" answered "send nothing".
    expect(composeAmount("0.0000900", 4)).toBe("0.0000900");
    expect(composeAmount("0.0000001", 4)).toBe("0.0000001");
  });

  it("still truncates rather than rounding, so max is never above spendable", () => {
    // The property that matters: whatever comes back is <= what went in.
    for (const v of ["1.99999", "0.00019", "12.34567", "0.0000900"]) {
      expect(Number(composeAmount(v, 4))).toBeLessThanOrEqual(Number(v));
    }
  });

  it("leaves a real zero alone", () => {
    expect(composeAmount("0", 4)).toBe("0");
    expect(composeAmount("0.0000000", 4)).toBe("0");
  });
});
