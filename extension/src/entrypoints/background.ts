// Service worker. Owns the encrypted vault and every network call; the popup is
// a thin UI that talks to it over runtime messages. Keys never leave this
// worker and are dropped whenever it restarts.
import "../lib/polyfill"; // must run before any stellar-sdk import

export default defineBackground(() => {
  // wired up in the next commits
});
