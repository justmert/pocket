// chrome.storage wrappers.
//
// Everything sensitive on DISK goes in `local` and encrypted. The one secret
// that touches `session` is the DEK, mirrored there by core/session.ts so the
// wallet survives worker eviction without re-prompting; `session` is RAM-only
// and wiped on browser close, so nothing sensitive is ever written to disk in
// the clear. The opening store is explicitly NOT a cache: per SDK.md 10.1,
// discarding it loses the receiving-side openings permanently, so it must never
// be evicted or rebuilt on demand.
export const KEYS = {
  vaultHeader: "pocket.vault",
  state: "pocket.state",
  settings: "pocket.settings",
  /** A submitted transaction whose outcome we have not yet observed. */
  inFlight: "pocket.inflight",
  /**
   * Confidential balance openings, keyed per (deployment, account). NOT a
   * cache: discarding these loses the receiving-side openings permanently, so
   * they must never be evicted.
   */
  openings: "pocket.openings",
  /**
   * This wallet's account address, in the clear.
   *
   * Public by nature: it is on the ledger the moment the account is funded, so
   * storing it plainly reveals nothing. It exists so a user who has forgotten
   * their password can still be checked against the wallet they are trying to
   * erase, which is the only way to authorise that erase without the password.
   */
  publicAddress: "pocket.address",
  /**
   * dApp connection grants, keyed by origin. Not secret: a session says a site
   * may see the address and may ASK to sign, never that it may sign.
   */
  dappSessions: "pocket.dapps",
  /**
   * The auditor id this account registered its OWN key under, per deployment.
   *
   * Allocated by the registry and returned, never chosen, so it has to be
   * recorded. Losing it does not lose funds, but it orphans a registered key
   * and the next attempt allocates another, so a retry must reuse this.
   */
  auditorId: "pocket.auditorid",
} as const;

/**
 * The key holding one account's openings in one deployment.
 *
 * The format lives here and nowhere else. A caller that builds this string
 * itself can drift from `openingKeys` below, and the two failure modes are
 * both silent: a read that misses returns "no record of your balances", and
 * an erase that misses leaves a blob no future DEK can open. Openings are not
 * a cache, so either one is unrecoverable.
 */
export function openingKey(token: string, address: string): string {
  return `${KEYS.openings}.${token}.${address}`;
}

/** Every key holding openings, across all deployments and accounts. */
export async function openingKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`${KEYS.openings}.`));
}

/**
 * Every recorded auditor id, across all deployments, tokens and accounts.
 *
 * Enumerated rather than named, for the same reason `openingKeys` is: the key
 * carries a deployment, a token and an ADDRESS, so there is no fixed list of
 * them to remove, and a caller reconstructing the pattern itself would drift
 * from the one place that writes it.
 *
 * Unlike openings, these are not always rubbish to be swept. Whether they
 * should survive an erase depends entirely on whether the same account is
 * coming back; `erase` decides that, and this only says where they are.
 */
export async function auditorIdKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`${KEYS.auditorId}.`));
}

export async function readLocal<T>(key: string): Promise<T | undefined> {
  const got = await chrome.storage.local.get(key);
  return got[key] as T | undefined;
}

export async function writeLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * Remove one key or many.
 *
 * The array form exists so a multi-key erase is ONE call rather than a
 * sequence of them. Chrome documents the `string[]` signature; it does NOT
 * document the operation as atomic, so treat this as "one window instead of
 * seven", not as a transaction.
 */
export async function removeLocal(key: string | string[]): Promise<void> {
  await chrome.storage.local.remove(key);
}
