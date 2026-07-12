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
