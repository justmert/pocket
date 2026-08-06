// What the screen may say when nothing matches, and when it may say it.
//
// The pager stops at MAX_AUTO_PAGES with older pages still unread, and an empty
// list has nothing to scroll, so `onScroll` can never restart it. The sentence
// was chosen on `cursor == null` alone, which is still non-null at that point,
// so the "yet" of the still-reading branch stayed on screen indefinitely while
// nothing was reading. The screen's own standard, stated a few lines below it:
// "'No activity yet' is a claim about the ACCOUNT. It may only be made when the
// history was actually read."
import { describe, it, expect } from "vitest";
import { emptyMatchSentence } from "./History";

const base = { readAll: false, pagingGaveUp: false };

describe("the empty-match sentence", () => {
  it("makes a claim about the account only when the whole history was read", () => {
    expect(emptyMatchSentence({ ...base, readAll: true })).toBe("No matches.");
  });

  it("says it is still reading only while it is still reading", () => {
    expect(emptyMatchSentence(base)).toBe("No matches yet.");
  });

  it("stops saying so once the pager has given up", () => {
    const said = emptyMatchSentence({ ...base, pagingGaveUp: true });
    expect(said, "the screen claimed to be reading after it stopped").not.toContain("yet");
    expect(said).toBe("No matches in what has loaded.");
  });
});
