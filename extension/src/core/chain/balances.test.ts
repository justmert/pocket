import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import { Asset, StrKey, xdr } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import {
  readNative,
  readTrustline,
  AccountNotFoundError,
  LedgerEntryMismatchError,
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

const serverReturning = (...entries: xdr.LedgerEntryData[]): rpc.Server =>
  ({
    getLedgerEntries: async () => ({
      entries: entries.map((val) => ({ val })),
      latestLedger: 1,
    }),
  }) as unknown as rpc.Server;

describe("the ledger's answer must be about the question", () => {
  // A wallet renders whatever this returns as the user's own money. Nothing in
  // the SDK checks a returned entry against the key that was requested, so a
  // hostile RPC, a caching proxy, or a mismatched batch response can put
  // somebody else's balance on the screen. Observed before this check: a
  // stranger's 12345.6789 XLM came back with no complaint at all.
  it("refuses an AccountEntry belonging to a different account", async () => {
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

  it("still reports a genuinely absent account as absent, not as a mismatch", async () => {
    // The one case allowed to render zero. Conflating it with a mismatch would
    // turn an ordinary unfunded wallet into an error screen.
    await expect(readNative(serverReturning(), MINE)).rejects.toBeInstanceOf(AccountNotFoundError);
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

  it("reports no trustline as null rather than as zero", async () => {
    expect(await readTrustline(serverReturning(), MINE, USDC)).toBeNull();
  });
});
