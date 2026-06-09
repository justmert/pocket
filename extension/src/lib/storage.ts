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
} as const;

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
