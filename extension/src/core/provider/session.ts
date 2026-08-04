// dApp sessions, bound to an origin.
//
// A session is a standing grant from one origin to see the address and to ASK
// for signatures. It is never a grant to sign: every signature is approved
// individually, because a session that could sign silently is a blank cheque
// written once and cashed forever.
//
// There is no "remember this site" for signing, deliberately. §14.7 forbids
// blind signing, and an approval the user cannot see is blind by definition.
import { KEYS, removeLocal } from "../../lib/storage";

/** How long a connection grant lasts without being renewed. */
export const SESSION_TTL_MS = 24 * 60 * 60_000;

export interface DappSession {
  /** The full origin, scheme included. `https://a.com` and `http://a.com` differ. */
  origin: string;
  /** Milliseconds since epoch. */
  connectedAt: number;
  /** The address the user consented to reveal, so a later account switch is visible. */
  address: string;
}

export class OriginRefusedError extends Error {
  override readonly name = "OriginRefusedError";
}

/**
 * The origin of a message sender, or a refusal.
 *
 * Chrome gives the frame's real origin in `sender.origin`, which the page
 * cannot forge: it is filled in by the browser, not by the content script. A
 * message with no origin is not from a page we can name, so it is refused
 * rather than defaulted.
 */
export function senderOrigin(sender: chrome.runtime.MessageSender): string {
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  if (!origin || origin === "null") {
    throw new OriginRefusedError("Pocket could not determine which site is asking, so it refused.");
  }
  // A site is an http(s) page and nothing else. Without this, `chrome-extension://`
  // is an origin like any other, and the wallet's own popup could hold a dApp
  // session against itself: a grant the user was never asked for, on the one
  // origin whose messages skip every origin check.
  if (!/^https?:\/\//.test(origin)) {
    throw new OriginRefusedError("Pocket could not determine which site is asking, so it refused.");
  }
  return origin;
}

/**
 * True only for the extension's own pages: popup, options, offscreen.
 *
 * `sender.id === chrome.runtime.id` does NOT mean this. A content script runs
 * inside a hostile page's process and carries the extension's id, so that check
 * alone lets anything our relay forwards reach the wallet router. The relay
 * forwards only `sep43` today, and that is a property of one file rather than of
 * the boundary. This is the boundary: an extension page is one whose URL is
 * under the extension's own origin, which a content script's never is.
 */
export function isExtensionPage(sender: chrome.runtime.MessageSender, base: string): boolean {
  if (!sender.url) return false;
  return sender.url.startsWith(base);
}

/**
 * The grants live in `chrome.storage.session`, which dies with the BROWSER.
 *
 * They were in `chrome.storage.local`, which does not. `lock()` clears them and
 * a browser close is a lock in every way that matters -- the seed is gone, the
 * worker is gone, the wallet comes back needing a password -- but nothing calls
 * `lock()` on the way out, so the grant simply survived. Measured: grant a
 * connection, close the browser, and `storage.local` still holds it with its
 * original `connectedAt`, so the 24-hour clock keeps running across restarts
 * and a site reconnects silently to a wallet the user has since locked.
 *
 * The wallet's own README says a connection "is dropped when the wallet locks",
 * and this is what makes that true rather than nearly true. RAM-backed, wiped
 * when the browser closes, and it survives ordinary MV3 worker eviction, which
 * is the distinction that matters: a grant should outlive the worker and not
 * the browser.
 */
function area(): chrome.storage.StorageArea | undefined {
  return chrome?.storage?.session;
}

async function all(): Promise<Record<string, DappSession>> {
  const store = area();
  if (!store) return {};
  try {
    const got = (await store.get(KEYS.dappSessions))[KEYS.dappSessions];
    return (got as Record<string, DappSession> | undefined) ?? {};
  } catch {
    // A store that will not answer holds no grant this code can honour, and
    // "no session" is the refusing direction.
    return {};
  }
}

async function put(sessions: Record<string, DappSession>): Promise<void> {
  const store = area();
  if (!store) return;
  await store.set({ [KEYS.dappSessions]: sessions });
}

/** The live session for an origin, if it has one that has not expired. */
export async function sessionFor(origin: string): Promise<DappSession | null> {
  const s = (await all())[origin];
  if (!s) return null;
  if (Date.now() - s.connectedAt > SESSION_TTL_MS) {
    await disconnect(origin);
    return null;
  }
  return s;
}

export async function connect(origin: string, address: string): Promise<DappSession> {
  const sessions = await all();
  const session: DappSession = { origin, connectedAt: Date.now(), address };
  sessions[origin] = session;
  await put(sessions);
  return session;
}

export async function disconnect(origin: string): Promise<void> {
  const sessions = await all();
  delete sessions[origin];
  await put(sessions);
}

export async function listSessions(): Promise<DappSession[]> {
  return Object.values(await all()).sort((a, b) => b.connectedAt - a.connectedAt);
}

/** Drop every session. Used by lock and by erase, so nothing outlives the wallet. */
export async function clearSessions(): Promise<void> {
  try {
    await area()?.remove(KEYS.dappSessions);
  } catch {
    /* nothing to remove, or the area went away with the browser. */
  }
  // ...and the LOCAL key an earlier build wrote. A wallet updated in place
  // would otherwise carry a grant that predates this change, in the one store
  // that survives a browser close, with nothing left that reads it to expire
  // it. Erase and lock both call this, so it is swept on the first of either.
  await removeLocal(KEYS.dappSessions);
}
