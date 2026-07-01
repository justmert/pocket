// Genuine ledger XDR, built with the SDK rather than pasted as a blob.
//
// A failure test is only half a test. The other half is proving the client still
// works when the dependency comes back, and that needs a response the real
// parser accepts byte for byte. These builders produce exactly that, so a
// recovery assertion can compare against a number the test chose.
import { Asset, StrKey, xdr } from "@stellar/stellar-sdk/base";

/** The `getLedgerEntries` entry shape, before the SDK parses it. */
export interface RawEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq?: number;
}

export function accountKey(accountId: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
    }),
  );
}

export function trustlineKey(accountId: string, asset: Asset): xdr.LedgerKey {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
      asset: asset.toTrustLineXDRObject(),
    }),
  );
}

export function accountEntry(
  accountId: string,
  balanceStroops: bigint,
  opts: { subEntries?: number; seq?: string } = {},
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
      balance: xdr.Int64.fromString(balanceStroops.toString()),
      seqNum: xdr.SequenceNumber.fromString(opts.seq ?? "100"),
      numSubEntries: opts.subEntries ?? 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );
}

export function trustlineEntry(
  accountId: string,
  asset: Asset,
  balanceStroops: bigint,
  opts: { limit?: bigint; authorized?: boolean } = {},
): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
      asset: asset.toTrustLineXDRObject(),
      balance: xdr.Int64.fromString(balanceStroops.toString()),
      limit: xdr.Int64.fromString((opts.limit ?? 9_223_372_036_854_775_807n).toString()),
      flags: opts.authorized === false ? 0 : 1,
      ext: new xdr.TrustLineEntryExt(0),
    }),
  );
}

/** One entry, keyed and echoed exactly as a healthy RPC does. */
export function entryFor(
  key: xdr.LedgerKey,
  val: xdr.LedgerEntryData,
  opts: { liveUntilLedgerSeq?: number; lastModifiedLedgerSeq?: number } = {},
): RawEntry {
  return {
    key: key.toXDR("base64"),
    xdr: val.toXDR("base64"),
    lastModifiedLedgerSeq: opts.lastModifiedLedgerSeq ?? 1,
    ...(opts.liveUntilLedgerSeq !== undefined
      ? { liveUntilLedgerSeq: opts.liveUntilLedgerSeq }
      : {}),
  };
}

/** The healthy `getLedgerEntries` result body. */
export function entriesResult(entries: RawEntry[], latestLedger = 1_000): unknown {
  return { entries, latestLedger };
}

/** A funded account, answered correctly. What recovery should produce. */
export function fundedAccountResult(
  accountId: string,
  balanceStroops: bigint,
  opts: { subEntries?: number; latestLedger?: number } = {},
): unknown {
  const key = accountKey(accountId);
  return entriesResult(
    [entryFor(key, accountEntry(accountId, balanceStroops, { subEntries: opts.subEntries }))],
    opts.latestLedger,
  );
}
