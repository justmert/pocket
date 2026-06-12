// chrome.storage wrappers.
//
// Everything sensitive goes in `local` and encrypted. Nothing sensitive goes in
// `session`, and the opening store is explicitly NOT a cache: per SDK.md 10.1,
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
} as const;

/** Every key holding openings, across all deployments and accounts. */
export async function openingKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(`${KEYS.openings}.`));
}

export async function readLocal<T>(key: string): Promise<T | undefined> {
  const got = await chrome.storage.local.get(key);
  return got[key] as T | undefined;
}

export async function writeLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeLocal(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}
