// Erasing a wallet has to erase who it paid.
//
// The address book lives in the POPUP's localStorage, not in
// `chrome.storage.local`, so the worker's erase sweep could never reach it. A
// wallet could be erased and the next wallet created on the device inherited
// the previous owner's list of recipients, offered from its own send field.
//
// `tests/auth/erase-sweep.test.ts` asserts that nothing carrying the erased
// address survives "anywhere in storage" and reads only `chrome.storage.local`,
// so this file sat outside every check that existed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAddressBook, addToAddressBook, clearAddressBook } from "./addressBook";

const store = new Map<string, string>();
const workingStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const A = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const B = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

beforeEach(() => {
  store.clear();
  // Re-stubbed per test: one case below replaces this with a storage that
  // throws, and leaving that in place would silently disable every test after
  // it rather than failing them.
  vi.stubGlobal("localStorage", workingStorage);
});

describe("the local address book", () => {
  it("persists what it is given, most-recent first", () => {
    addToAddressBook(addToAddressBook([], A), B);
    expect(readAddressBook()).toEqual([B, A]);
  });

  it("dedupes rather than repeating an address", () => {
    const once = addToAddressBook([], A);
    expect(addToAddressBook(once, A)).toEqual([A]);
  });

  it("caps the list so it cannot grow without bound", () => {
    let list: string[] = [];
    for (let i = 0; i < 40; i++) list = addToAddressBook(list, `G${i}`);
    expect(list).toHaveLength(20);
  });

  it("ignores an empty address", () => {
    expect(addToAddressBook([A], "   ")).toEqual([A]);
  });

  it("LEAVES NOTHING BEHIND when cleared", () => {
    // The whole point. Both the returned list and the persisted copy.
    addToAddressBook(addToAddressBook([], A), B);
    clearAddressBook();
    expect(readAddressBook()).toEqual([]);
    expect([...store.values()].join(" ")).not.toContain(A);
    expect([...store.values()].join(" ")).not.toContain(B);
  });

  it("survives a storage that refuses to answer", () => {
    // Some browsers disable localStorage entirely. A wallet that throws on
    // boot because it could not read a convenience list is worse than one
    // without the list.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
      removeItem: () => {
        throw new Error("disabled");
      },
    });
    expect(readAddressBook()).toEqual([]);
    expect(addToAddressBook([], A)).toEqual([A]);
    expect(() => clearAddressBook()).not.toThrow();
  });

  it("ignores a persisted value that is not a list of strings", () => {
    store.set("pocket:savedAddresses", JSON.stringify({ not: "a list" }));
    expect(readAddressBook()).toEqual([]);
    store.set("pocket:savedAddresses", JSON.stringify([A, 7, null]));
    expect(readAddressBook()).toEqual([A]);
  });
});

/**
 * The erase door has to RUN the cleanup, not merely have one.
 *
 * The list lives in the popup's `localStorage`, so the worker's erase sweep
 * cannot reach it: the only thing that clears it is `refresh`'s
 * `!next.initialised` branch. The erase sheet once called `reloadStatus`, which
 * is four lines that do not run that branch, and in the recorded `stuck` window
 * state onboarding runs in the SAME document, so the erased wallet's recipients
 * were offered as chips to the wallet created next.
 *
 * A source read, and deliberately so: reaching this through a render would mean
 * standing up the provider, the rpc channel and a worker, and what regressed is
 * one call. Rendering is also impossible here, the suite runs in node with no
 * jsdom.
 */
describe("the erase door and the popup's own memory", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("erase goes through refresh, which is the only thing that clears the list", () => {
    const sheet = read("./sheets/SettingsSheets.tsx");
    const erase = sheet.slice(sheet.indexOf('call({ type: "reset"'));
    expect(erase.slice(0, 600), "the erase door does not await w.refresh()").toMatch(
      /await w\.refresh\(\)/,
    );
    expect(
      erase.slice(0, 600),
      "erase went back to reloadStatus, which does not clear the address book",
    ).not.toMatch(/await w\.reloadStatus\(\)/);
  });

  it("refresh clears the list when the wallet is gone", () => {
    const provider = read("./WalletProvider.tsx");
    expect(provider).toMatch(/clearAddressBook\(\)/);
    // In the branch that runs when the wallet no longer exists, not somewhere
    // else in the file.
    const branch = provider.slice(provider.indexOf("!next.initialised"));
    expect(branch.slice(0, 2000)).toMatch(/clearAddressBook\(\)/);
  });
});
