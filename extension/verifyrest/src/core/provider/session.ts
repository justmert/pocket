// dApp sessions, bound to an origin.
//
// A session is a standing grant from one origin to see the address and to ASK
// for signatures. It is never a grant to sign: every signature is approved
// individually, because a session that could sign silently is a blank cheque
// written once and cashed forever.
//
// There is no "remember this site" for signing, deliberately. §14.7 forbids
// blind signing, and an approval the user cannot see is blind by definition.
import { KEYS, readLocal, writeLocal, removeLocal } from "../../lib/storage";

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
  return origin;
}

async function all(): Promise<Record<string, DappSession>> {
  return (await readLocal<Record<string, DappSession>>(KEYS.dappSessions)) ?? {};
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
  await writeLocal(KEYS.dappSessions, sessions);
  return session;
}

export async function disconnect(origin: string): Promise<void> {
  const sessions = await all();
  delete sessions[origin];
  await writeLocal(KEYS.dappSessions, sessions);
}

export async function listSessions(): Promise<DappSession[]> {
  return Object.values(await all()).sort((a, b) => b.connectedAt - a.connectedAt);
}

/** Drop every session. Used by lock and by erase, so nothing outlives the wallet. */
export async function clearSessions(): Promise<void> {
  await removeLocal(KEYS.dappSessions);
}
