import { unreadBadge } from "./unreadBadge";

/**
 * The unread badge's displayed value, as a pure function of the server count
 * alone — there is no local counter to reconcile. The interesting cases here
 * are not arithmetic: they are the ones a naive expression gets wrong —
 * preferring a stale local count over the real one, and rendering a badge for
 * a count nobody knows yet.
 */

describe("unreadBadge", () => {
  it("shows the server count, not a count of recent notifications", () => {
    // There is nothing for the server count to lose to: a notification
    // invalidates the query, and the badge shows whatever count comes back.
    expect(unreadBadge(6)).toEqual({ show: true, count: 6 });
  });

  it("hides at zero", () => {
    expect(unreadBadge(0)).toEqual({ show: false, count: 0 });
  });

  it("hides before the query has settled", () => {
    // `undefined` reads as zero: "not known yet" is not "you have mail", and
    // a naive `!== 0` test would be true for `undefined` too, showing an
    // empty badge on every fresh mount before any count was known.
    expect(unreadBadge(undefined)).toEqual({ show: false, count: 0 });
  });

  it("ties visibility to the number actually shown", () => {
    // One object holds both `show` and `count`, so the visibility decision
    // and the displayed number cannot disagree with each other.
    for (const serverCount of [undefined, 0, 1, 5, 99]) {
      const badge = unreadBadge(serverCount);

      expect(badge.show).toBe(badge.count > 0);
    }
  });

  it("never displays a negative or absent number as a badge", () => {
    // `getUnreadMessageCount` returns a Prisma count and cannot go negative,
    // so this is a guard on the type rather than on the query: `show` must not
    // be driven by "is not zero".
    expect(unreadBadge(-1).show).toBe(false);
  });
});
