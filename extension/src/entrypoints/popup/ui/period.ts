// Which heading a moment falls under in a list of activity.
//
// Pure and on its own, because the popup has no DOM test environment and a
// grouping rule that can file an entry under the wrong day should be checkable
// with a fixed clock rather than only by looking at the screen.

/**
 * The heading a run of entries falls under: relative near the present, then the
 * month and year, so a long history reads as a calendar rather than a wall.
 *
 * All the arithmetic is CALENDAR arithmetic, deliberately. Subtracting fixed
 * milliseconds is wrong twice a year in any zone that observes daylight saving,
 * where a day is 23 or 25 hours: `startOfToday - 86_400_000` lands an hour
 * inside the wrong date, so an entry made yesterday morning files under "This
 * week" and one made this morning can file under "Yesterday".
 */
export function periodLabel(at: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime();

  /** Local midnight `offset` days from today, over real calendar days. */
  const midnight = (offset: number): number => {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  if (at >= startOfToday) return "Today";
  if (at >= midnight(-1)) return "Yesterday";
  if (at >= midnight(-7)) return "This week";

  // The first of this month AT MIDNIGHT. This was `new Date(now).setDate(1)`,
  // which changes the day and keeps the current time of day, so on the 7th at
  // 14:00 the boundary sat at the 1st at 14:00. Anything earlier on the 1st fell
  // past this test into the branch below and was labelled with the month's own
  // name, so the list drew "This month" immediately above a heading reading
  // "August 2026" while both described August.
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  if (at >= firstOfMonth) return "This month";

  return new Date(at).toLocaleDateString([], { month: "long", year: "numeric" });
}
