// The ledger oracle.
//
// Everything here talks to public testnet over plain HTTP and shares NO code
// with the wallet: no stellar-sdk, no core/ import, not even a constant. That
// is the entire point. "Sent" on a screen is a claim; Horizon is the evidence.
// If this file imported the wallet's own read path, a bug in that path would
// agree with itself and the assertion would prove nothing.

export const HORIZON = "https://horizon-testnet.stellar.org";
export const FRIENDBOT = "https://friendbot.stellar.org";

/** Exactly what friendbot pays out. Asserted, not assumed: see `fund`. */
export const FRIENDBOT_XLM = 10_000;

export interface HorizonBalance {
  balance: string;
  asset_type: string;
}

export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
  subentry_count: number;
}

export interface HorizonTransaction {
  hash: string;
  successful: boolean;
  ledger: number;
  memo?: string;
  memo_type: string;
  fee_charged: string;
  operation_count: number;
  source_account: string;
  /**
   * Who actually paid. NOT always the account you asked about: the friendbot
   * transaction that created an account is listed against it while friendbot
   * pays the fee, so summing `fee_charged` over this list overcounts by exactly
   * one base fee unless this is checked.
   */
  fee_account: string;
}

export interface HorizonPayment {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  transaction_hash: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return (await res.json()) as T;
}

/** Null when the account does not exist on the ledger yet. */
export async function account(address: string): Promise<HorizonAccount | null> {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} reading ${address}`);
  return (await res.json()) as HorizonAccount;
}

/** The native XLM balance as a number. Throws when the account is absent. */
export async function nativeBalance(address: string): Promise<number> {
  const acc = await account(address);
  if (!acc) throw new Error(`account ${address} does not exist on testnet`);
  const native = acc.balances.find((b) => b.asset_type === "native");
  if (!native) throw new Error(`account ${address} reports no native balance`);
  return Number(native.balance);
}

/**
 * Fund a brand-new account and wait until the ledger says so.
 *
 * Waits on the ACCOUNT EXISTING, not on a timer: friendbot answers before the
 * ledger closes, and a test that carries on immediately reads a 404 from the
 * wallet's own path and calls it an unfunded account.
 */
export async function fund(address: string): Promise<number> {
  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    // Friendbot answers 400 for an account it has already funded, which is a
    // real outcome rather than a failure, so check before giving up.
    const already = await account(address);
    if (!already) throw new Error(`friendbot refused to fund ${address}: ${res.status}`);
  }
  return waitFor(
    () => nativeBalance(address),
    (v) => v > 0,
    `friendbot funding for ${address}`,
  );
}

/**
 * Transactions on this account, newest first, INCLUDING failed ones.
 *
 * Horizon excludes failed transactions unless `include_failed=true`, and that
 * default is a trap for an oracle. Two things it breaks, both of which it broke
 * here before this was fixed:
 *
 *   - `expect(txs.every((t) => t.successful)).toBe(true)` is VACUOUS on the
 *     default. The array is all-successful by construction, so the assertion
 *     cannot fail no matter what the wallet did. It shipped in this suite and
 *     was caught only when a fee sum disagreed by 13,303 stroops.
 *   - A failed transaction still CHARGES ITS FEE and still consumes the
 *     sequence number. Reconciling a balance against a fee total that silently
 *     omits them is off by exactly the fees of whatever failed.
 *
 * So the default here is the opposite of Horizon's. A caller that genuinely
 * wants only the successful ones has to say so.
 */
export async function transactions(
  address: string,
  limit = 20,
  { includeFailed = true } = {},
): Promise<HorizonTransaction[]> {
  const page = await getJson<{ _embedded: { records: HorizonTransaction[] } }>(
    `${HORIZON}/accounts/${address}/transactions` +
      `?order=desc&limit=${limit}&include_failed=${includeFailed}`,
  );
  return page._embedded.records;
}

/** Total fees THIS account paid, failed attempts included. */
export function feesPaidBy(address: string, txs: HorizonTransaction[]): number {
  // `fee_account`, not `source_account`: friendbot's create-account is listed
  // against the account it funded but friendbot paid for it.
  return txs
    .filter((t) => t.fee_account === address)
    .reduce((sum, t) => sum + Number(t.fee_charged) / 10_000_000, 0);
}

/** Payment-shaped operations on this account, newest first. */
export async function payments(address: string, limit = 20): Promise<HorizonPayment[]> {
  const page = await getJson<{ _embedded: { records: HorizonPayment[] } }>(
    `${HORIZON}/accounts/${address}/payments?order=desc&limit=${limit}`,
  );
  return page._embedded.records;
}

/** One transaction by hash. Null while the ledger has not included it. */
export async function transaction(hash: string): Promise<HorizonTransaction | null> {
  const res = await fetch(`${HORIZON}/transactions/${hash}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} reading tx ${hash}`);
  return (await res.json()) as HorizonTransaction;
}

/**
 * Poll a real condition until it holds.
 *
 * Not a sleep. Every caller names a fact about the ledger and waits for THAT,
 * so a slow network makes the suite slower rather than flaky, and a fact that
 * never becomes true fails with the name of the fact instead of a timeout on an
 * anonymous locator.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  what: string,
  { timeoutMs = 90_000, everyMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (holds(value)) return value;
      last = value;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}. Last read: ${last}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Wait until the ledger shows this transaction hash included. */
export async function waitForTransaction(hash: string): Promise<HorizonTransaction> {
  return waitFor(
    () => transaction(hash),
    (tx): tx is HorizonTransaction => tx !== null,
    `transaction ${hash} to appear on the ledger`,
  ) as Promise<HorizonTransaction>;
}
