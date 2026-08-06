// What the screen may say when nothing matches, and when it may say it.
//
// The pager stops at MAX_AUTO_PAGES with older pages still unread, and an empty
// list has nothing to scroll, so `onScroll` can never restart it. The sentence
// was chosen on `cursor == null` alone, which is still non-null at that point,
// so "Still reading older history" stayed on screen indefinitely while nothing
// was reading. The screen's own standard, stated a few lines below it: "'No
// activity yet' is a claim about the ACCOUNT. It may only be made when the
// history was actually read."
import { describe, it, expect } from "vitest";
import { emptyMatchSentence } from "./History";

const base = { q: "", filtersActive: true, readAll: false, pagingGaveUp: false };

describe("the empty-match sentence", () => {
  it("makes a claim about the account only when the whole history was read", () => {
    expect(emptyMatchSentence({ ...base, readAll: true })).toBe("Nothing matches those filters.");
    expect(emptyMatchSentence({ ...base, q: "abc", filtersActive: false, readAll: true })).toBe(
      "Nothing in your activity matches “abc”.",
    );
  });

  it("says it is still reading only while it is still reading", () => {
    expect(emptyMatchSentence(base)).toContain("Still reading older history");
    expect(emptyMatchSentence({ ...base, q: "abc", filtersActive: false })).toContain(
      "Still reading older history",
    );
  });

  it("stops saying so once the pager has given up", () => {
    const filtered = emptyMatchSentence({ ...base, pagingGaveUp: true });
    expect(filtered, "the screen claimed to be reading after it stopped").not.toContain(
      "Still reading",
    );
    expect(filtered).toContain("has not been read");
    const searched = emptyMatchSentence({
      ...base,
      q: "abc",
      filtersActive: false,
      pagingGaveUp: true,
    });
    expect(searched).not.toContain("Still reading");
    expect(searched).toContain("“abc”");
    expect(searched).toContain("has not been read");
  });

  it("does not report a search that matched nothing as filters hiding things", () => {
    // A search is not a filter. Every sentence here was once written for the
    // second disjunct of `q || filtersActive`.
    for (const flags of [{}, { pagingGaveUp: true }, { readAll: true }]) {
      const said = emptyMatchSentence({ ...base, q: "abc", filtersActive: false, ...flags });
      expect(said, said).not.toContain("filters");
      expect(said).toContain("abc");
    }
  });

  it("calls it filters when a filter is on, even with a search box in play", () => {
    // Both at once: the filters are the stronger claim and the one the Clear
    // button beside the sentence resets.
    const said = emptyMatchSentence({ ...base, q: "abc", filtersActive: true });
    expect(said).toContain("filters");
  });
});
