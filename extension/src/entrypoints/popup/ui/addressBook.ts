// The local address book: who this device has paid.
//
// A module rather than three inline `localStorage` calls, because the third one
// was missing. It lives in the POPUP's localStorage, not in
// `chrome.storage.local`, so the worker's erase sweep could never reach it: a
// wallet could be erased and the next wallet created on the device inherited
// the previous owner's list of recipients, offered from its own send field.
//
// The addresses themselves are public on the ledger, which is why they are
// stored in the clear. WHO THIS DEVICE PAID is not public, and that is what the
// list is. `tests/auth/erase-sweep.test.ts` asserts that nothing carrying the
// erased address survives "anywhere in storage", and reads only
// `chrome.storage.local`, so this file was outside every check that existed.

const KEY = "pocket:savedAddresses";

/** Most-recent first, capped so it cannot grow without bound. */
const CAP = 20;

export function readAddressBook(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** Add one, most-recent first and deduped. Returns the new list. */
export function addToAddressBook(current: string[], address: string): string[] {
  const addr = address.trim();
  if (!addr) return current;
  const next = [addr, ...current.filter((a) => a !== addr)].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage disabled: the list stays in memory for this session. */
  }
  return next;
}

/**
 * Forget everyone. Called when the wallet is erased.
 *
 * Erasing has to mean erasing: a wallet that is gone must not leave the list of
 * who it paid behind for whoever sets up the next one on this device.
 */
export function clearAddressBook(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage disabled: there was nothing persisted to remove. */
  }
}
