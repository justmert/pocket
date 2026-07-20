// Grouping headings, against fixed clocks.
import { describe, it, expect } from "vitest";
import { DATE_LOCALE, periodLabel } from "./period";

/** A local-time moment, so the assertions read in the zone the user is in. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("periodLabel", () => {
  const now = at(2026, 8, 7, 14, 30); // Friday 7 August, 14:30 local

  it("names the near past relatively", () => {
    expect(periodLabel(at(2026, 8, 7, 9), now)).toBe("Today");
    expect(periodLabel(at(2026, 8, 7, 0, 0), now)).toBe("Today");
    expect(periodLabel(at(2026, 8, 6, 23, 59), now)).toBe("Yesterday");
    expect(periodLabel(at(2026, 8, 6, 0, 0), now)).toBe("Yesterday");
    expect(periodLabel(at(2026, 8, 3), now)).toBe("This week");
  });

  it("keeps the whole first of the month out of the month-name branch", () => {
    // `now` is the 20th here, deliberately: on the 7th the 1st is still inside
    // the seven-day window and "This week" wins, so the month boundary is never
    // consulted and the defect cannot show.
    //
    // The defect: the boundary was `new Date(now).setDate(1)`, which changes the
    // day and KEEPS THE CURRENT TIME OF DAY, so on the 20th at 14:30 it sat at
    // the 1st at 14:30. Anything earlier on the 1st fell past it into the
    // month-name branch, and the list drew "This month" directly above a
    // heading reading "August 2026", both describing August.
    const later = at(2026, 8, 20, 14, 30);
    expect(periodLabel(at(2026, 8, 1, 0, 0), later)).toBe("This month");
    expect(periodLabel(at(2026, 8, 1, 9, 0), later)).toBe("This month");
    expect(periodLabel(at(2026, 8, 1, 14, 29), later)).toBe("This month");
    expect(periodLabel(at(2026, 8, 1, 23, 59), later)).toBe("This month");
  });

  it("never puts two headings on the same month", () => {
    // Whatever the labels are, no moment inside this month may be labelled with
    // this month's own name, or the list contradicts itself.
    const later = at(2026, 8, 20, 14, 30);
    const thisMonth = new Date(later).toLocaleDateString(DATE_LOCALE, { month: "long", year: "numeric" });
    for (let day = 1; day <= 20; day++) {
      for (const hour of [0, 6, 14, 23]) {
        const t = at(2026, 8, day, hour);
        if (t > later) continue;
        expect(periodLabel(t, later), `${day} Aug ${hour}:00`).not.toBe(thisMonth);
      }
    }
  });

  it("falls back to the month name for anything older", () => {
    const later = at(2026, 8, 20, 14, 30);
    expect(periodLabel(at(2026, 7, 31, 23, 59), later)).toBe(
      new Date(at(2026, 7, 31)).toLocaleDateString(DATE_LOCALE, { month: "long", year: "numeric" }),
    );
  });

  it("uses calendar days, so a daylight-saving boundary cannot shift a heading", () => {
    // A day is 23 or 25 hours across a DST change, so fixed-millisecond
    // arithmetic lands inside the wrong date. Europe/Istanbul does not observe
    // DST, so this is asserted structurally: midnight today is always exactly
    // the start of the day, whatever its length.
    const dstNow = at(2026, 3, 30, 10, 0);
    expect(periodLabel(at(2026, 3, 30, 0, 0), dstNow)).toBe("Today");
    expect(periodLabel(at(2026, 3, 29, 23, 59), dstNow)).toBe("Yesterday");
    expect(periodLabel(at(2026, 3, 29, 0, 0), dstNow)).toBe("Yesterday");
  });
});
