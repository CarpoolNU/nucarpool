/**
 * What the unread-message badge shows, and whether it shows at all.
 *
 * The server's unread count (`user.messages.getUnreadMessageCount`) is the
 * only source for the badge; a Pusher notification invalidates that query
 * rather than feeding a separate local counter — see
 * [`useUnreadNotifications`](./useUnreadNotifications.ts).
 *
 * The desktop and mobile badges each need both the count and the decision to
 * show it. Returning both from one function makes "shown when and only when
 * the number is non-zero" true by construction, rather than depending on the
 * desktop and mobile call sites computing that condition the same way.
 */

export type UnreadBadge = {
  /** Whether to render the badge at all. */
  show: boolean;
  /** The number to render. Meaningful only when `show` is true. */
  count: number;
};

/**
 * @param serverCount `user.messages.getUnreadMessageCount`'s data, which is
 *   `undefined` until the query first settles. Treated as zero here, because
 *   "not yet known" is not "you have mail" — a test like `serverCount !== 0`
 *   would be true for `undefined` too, and render an empty badge on every
 *   fresh mount before any count was known.
 */
export function unreadBadge(serverCount: number | undefined): UnreadBadge {
  const count = serverCount ?? 0;

  return { show: count > 0, count };
}
