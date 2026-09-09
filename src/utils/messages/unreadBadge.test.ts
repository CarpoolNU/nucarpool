import { unreadBadge } from "./unreadBadge";

/**
 * The unread badge's displayed value (SCRUM-383).
 *
 * The ticket asked for the badge's value as a pure function of "the server
 * count and whatever live state survives", and noted that if the local counter
 * were removed entirely there would be nothing left to extract — "which is
 * itself the better outcome". It was removed, so the interesting cases here
 * are not arithmetic. They are the two the old four-expression version got
 * wrong: preferring a local count over the real one, and rendering a badge for
 * a count nobody knows yet.
 */

describe("unreadBadge", () => {
  it("shows the server count, not a count of recent notifications", () => {
    // The whole ticket, as a value. Five unread plus a sixth arriving used to
    // display `1`, because the local counter went from 0 to 1 and the ternary
    // preferred it. There is no longer anything for the server count to lose
    // to: a notification invalidates the query and this is whatever came back.
    expect(unreadBadge(6)).toEqual({ show: true, count: 6 });
  });

  it("hides at zero", () => {
    expect(unreadBadge(0)).toEqual({ show: false, count: 0 });
  });

  it("hides before the query has settled", () => {
    // `unreadMessagesCount !== 0` is *true* for `undefined`, so the old
    // expression rendered the badge on every fresh mount — an empty white
    // circle, because the value it then interpolated was also `undefined`.
    // "Not known yet" is not "you have mail".
    expect(unreadBadge(undefined)).toEqual({ show: false, count: 0 });
  });

  it("ties visibility to the number actually shown", () => {
    // The invariant the four duplicated expressions could not guarantee: the
    // desktop badge tested `unreadMessagesCount !== 0 || currentunread !== 0`
    // and then displayed a *different* expression. One object, so the two
    // cannot disagree.
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
