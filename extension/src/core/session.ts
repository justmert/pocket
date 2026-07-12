// Unlocked-session state.
//
// The plaintext SEED lives in service-worker memory only and is never written
// anywhere. To survive MV3's routine worker eviction without forcing the
// password again, the one secret needed to re-open the vault, the DEK, is
// mirrored into `chrome.storage.session`: RAM-backed, wiped when the browser
// closes, never on disk, and readable only by our own trusted extension
// contexts. This is the model MetaMask ships (its "encryption key" in session
// storage, the encrypted vault on disk, re-unlock on restart); see
// MetaMask/metamask-extension#17950.
//
// The mirror is gated by a deadline (`lockAt`). Two enforcers converge on it:
//   - `readPersistedUnlock` refuses and purges an expired record, so it is
//     authoritative on every worker start regardless of alarm timing; and
//   - the `chrome.alarms` auto-lock in background.ts fires while a worker is
//     alive.
// A real lock (button, idle timeout, erase, browser close) clears the mirror;
// a mere eviction does not, which is what lets a restart within the window come
// back unlocked. An alarm rather than a setTimeout because a setTimeout does not
// survive a worker restart.
import type { Bytes } from "./vault/envelope";

/** The one place the DEK mirror is keyed, in `chrome.storage.session`. */
const SESSION_KEY = "pocket.session";

export interface UnlockedSession {
  /** Data-encryption key, unwrapped from the vault header. Mirrored to RAM. */
  dek: Bytes;
  /** BIP-39 seed. Held only to derive; never written anywhere, not even the mirror. */
  seed: Bytes;
  address: string;
  unlockedAt: number;
  /** Epoch ms at which the idle lock is due. Slides forward on activity. */
  lockAt: number;
}

/** What the RAM mirror actually holds: the DEK and the deadline, nothing else. */
interface PersistedUnlock {
  /** base64 of the DEK. The seed is deliberately absent. */
  dek: string;
  lockAt: number;
}

let current: UnlockedSession | null = null;

/** The RAM-only session area, or undefined in a bare (non-browser) harness. */
function sessionArea(): chrome.storage.StorageArea | undefined {
  return chrome?.storage?.session;
}

function toB64(bytes: Bytes): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromB64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out as Bytes;
}

/**
 * Write the DEK and deadline into the RAM mirror.
 *
 * Best-effort: if the session area is unavailable the wallet still works, it
 * just degrades to locking on eviction (the pre-mirror behaviour) rather than
 * failing. Fire-and-forget from `setSession`; callers that need the write to
 * have landed (a test asserting the mirror is populated) can await it.
 */
async function persist(): Promise<void> {
  const s = current;
  const area = sessionArea();
  if (!s || !area) return;
  const record: PersistedUnlock = { dek: toB64(s.dek), lockAt: s.lockAt };
  try {
    await area.set({ [SESSION_KEY]: record });
  } catch {
    /* RAM store unavailable; degrade to memory-only. */
  }
}

export function setSession(s: UnlockedSession): void {
  current = s;
  void persist();
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

/** The deadline the idle lock is due at, or null when locked. */
export function sessionDeadline(): number | null {
  return current?.lockAt ?? null;
}

/**
 * Slide the idle deadline forward and re-persist it, on real user activity.
 *
 * Keeps the RAM mirror's deadline in step with the `chrome.alarms` auto-lock,
 * so a restart mid-session enforces the same remaining window whichever
 * enforcer gets there first.
 */
export function touchDeadline(lockAt: number): void {
  if (!current) return;
  current.lockAt = lockAt;
  void persist();
}

/**
 * Drop key material from MEMORY. Zeroes the buffers before releasing them: it
 * does not defeat a memory dump taken mid-session, but it shortens the window in
 * which a key sits in a reachable heap object after lock.
 *
 * This is eviction, not a lock: it leaves the RAM mirror in place, so a worker
 * that comes back within the window can restore. A real lock also calls
 * `clearPersistedSession`.
 */
export function clearSession(): void {
  if (current) {
    current.dek.fill(0);
    current.seed.fill(0);
  }
  current = null;
}

/**
 * Purge the RAM mirror, so no future worker can restore this session without
 * the password. Called by every real lock: the button, the idle alarm, and
 * erase. Best-effort and idempotent.
 */
export async function clearPersistedSession(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(SESSION_KEY);
  } catch {
    /* nothing to remove, or the area went away with the browser. */
  }
}

/**
 * The mirrored DEK and deadline, for the controller to re-open the vault after a
 * worker restart. Returns null, and purges the record, when the deadline has
 * passed: an expired session must never be restored, whatever the alarm did.
 */
export async function readPersistedUnlock(
  now: number,
): Promise<{ dek: Bytes; lockAt: number } | null> {
  const area = sessionArea();
  if (!area) return null;
  let record: PersistedUnlock | undefined;
  try {
    record = (await area.get(SESSION_KEY))[SESSION_KEY] as PersistedUnlock | undefined;
  } catch {
    return null;
  }
  if (!record || typeof record.dek !== "string" || typeof record.lockAt !== "number") return null;
  if (now >= record.lockAt) {
    await clearPersistedSession();
    return null;
  }
  return { dek: fromB64(record.dek), lockAt: record.lockAt };
}
