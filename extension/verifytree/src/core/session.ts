// Unlocked-session state.
//
// Plaintext keys live in service-worker memory only and are never persisted.
// MV3 kills an idle worker at any time, which is a feature here: worker death
// is an automatic lock. The idle timer is an alarm rather than a setTimeout
// because a setTimeout does not survive a worker restart, so a wallet relying
// on one would stay unlocked across a restart it did not notice.
import type { Bytes } from "./vault/envelope";

export interface UnlockedSession {
  /** Data-encryption key, unwrapped from the vault header. */
  dek: Bytes;
  /** BIP-39 seed. Held only to derive; never written anywhere. */
  seed: Bytes;
  address: string;
  unlockedAt: number;
}

let current: UnlockedSession | null = null;

export function setSession(s: UnlockedSession): void {
  current = s;
}

export function getSession(): UnlockedSession | null {
  return current;
}

export function requireSession(): UnlockedSession {
  if (!current) throw new Error("wallet is locked");
  return current;
}

export function isUnlocked(): boolean {
  return current !== null;
}

/**
 * Drop key material. Zeroes the buffers before releasing them: it does not
 * defeat a memory dump taken mid-session, but it shortens the window in which a
 * key sits in a reachable heap object after lock.
 */
export function clearSession(): void {
  if (current) {
    current.dek.fill(0);
    current.seed.fill(0);
  }
  current = null;
}
