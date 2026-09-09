/**
 * What the unread-message badge shows, and whether it shows at all.
 *
 * `Header` held a second unread count beside the server's and *preferred* it:
 *
 * ```ts
 * {currentunreadMessagesCount !== 0 ? currentunreadMessagesCount : unreadMessagesCount}
 * ```
 *
 * A local counter incremented on each Pusher `sendNotification` therefore
 * replaced the real number rather than adding to it, so a user with five
 * unread messages who received a sixth saw the badge change from `5` to `1`
 * (SCRUM-383). The local counter is gone: the server count is the only source,
 * and a notification invalidates it — see
 * [`useUnreadNotifications`](./useUnreadNotifications.ts).
 *
 * That leaves nothing to reconcile, so this function is small. It exists for
 * the other half of the bug, which is duplication: the count and the decision
 * to render it were written out **four** times — the desktop badge's
 * visibility test and its value, then the mobile badge's — as separate
 * expressions that could disagree. Returning both from one place makes
 * "shown when and only when the number is non-zero" true by construction
 * rather than by four authors agreeing.
 */

export type UnreadBadge = {
  /** Whether to render the badge at all. */
  show: boolean;
  /** The number to render. Meaningful only when `show` is true. */
  count: number;
};

/**
 * @param serverCount `user.messages.getUnreadMessageCount`'s data, which is
 *   `undefined` until the query first settles. The old expression tested
 *   `unreadMessagesCount !== 0`, which is *true* for `undefined` — so the badge
 *   rendered an empty circle on every fresh mount, before any count was known.
 *   Treated as zero here, because "not yet known" is not "you have mail".
 */
export function unreadBadge(serverCount: number | undefined): UnreadBadge {
  const count = serverCount ?? 0;

  return { show: count > 0, count };
}
