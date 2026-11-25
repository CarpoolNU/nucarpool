/**
 * A coarse relative time, for post and comment bylines.
 *
 * **Deliberately coarse.** A thread's byline answers "is this current?", not
 * "exactly when?", and a precise timestamp on a pseudonymous post is a privacy
 * cost with no reader benefit: posting times are a behavioural fingerprint, and
 * minute-level precision across a handful of posts narrows who a handle could
 * belong to far more than "3 days ago" does.
 *
 * Falls back to a plain date past a week, where "52 weeks ago" stops being
 * easier to read than the date itself.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const timeAgo = (value: Date, now: Date = new Date()): string => {
  const elapsed = now.getTime() - value.getTime();

  // Clock skew between a server-rendered `now` and the browser's can make a
  // just-created post look very slightly future-dated. "Just now" is the
  // honest answer for anything that has not measurably aged.
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }

  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};
