import { useEffect, useRef } from "react";
import { trpc } from "../trpc";
import { notificationChannel } from "../pusherChannels";
import { acquirePusherClient, releasePusherClient } from "../pusherClient";

/**
 * Keeps the unread-message count fresh while a notification arrives.
 *
 * This subscription lived inside `Header`, and what it did on an incoming
 * `sendNotification` was increment a local counter that the badge then
 * displayed *instead of* the server's count (SCRUM-383). It now invalidates
 * `getUnreadMessageCount`, which is the mechanism
 * [`MessageContent`](../../components/Messages/MessageContent.tsx) already uses
 * after marking a thread read — so both directions go through one path and the
 * badge cannot drift from the database.
 *
 * **Why the increment had to go, beyond the wrong number.** It was performed
 * from inside an updater handed to a *different* component's `setSidebar`,
 * using the setter as a way to read state:
 *
 * ```ts
 * setSidebarRef.current?.((prev) => {
 *   if (prev !== "requests") {
 *     setCurrentunreadMessagesCount((count) => count + 1);
 *   }
 *   return prev;
 * });
 * ```
 *
 * Updaters must be pure — React is free to call them more than once, and
 * `next.config.js` sets `reactStrictMode: true`, which double-invokes them in
 * development. So the badge counted two per message locally. Invalidation is
 * idempotent, so replaying it is harmless.
 *
 * **The `prev !== "requests"` condition is deliberately not carried over.** It
 * suppressed the bump while the user was looking at the Requests tab, but the
 * notification channel is per *user*, not per conversation: a message in some
 * other thread while that tab is open is real unread mail and should be
 * counted. Under invalidation the question answers itself — the count is
 * whatever the server says, and a thread the user actually opens is marked read
 * by `MessageContent`, which brings it back down. Nothing needs to read the
 * sidebar, so nothing does.
 *
 * **Lifting it out of `Header` is what makes any of this testable.** `Header`
 * cannot be rendered without a router, a tRPC client, a portal and a
 * `GroupPage`; the same reason `viewRoutePlan.ts` and `mobileNavPlan.ts` exist.
 *
 * @param userId the signed-in user, or `undefined` before the session
 *   resolves. No subscription is opened until it is known.
 */
export function useUnreadNotifications(userId: string | undefined): void {
  const utils = trpc.useUtils();

  /**
   * Held in a ref so the subscription effect below can depend on `userId`
   * alone. That dependency list is load-bearing: `Header` used to depend on
   * `props.data`, an object literal its parent rebuilds on every filter change,
   * query settle, map event and hover, so the effect tore down and re-ran
   * continuously and opened a fresh WebSocket each time. Pusher meters peak
   * concurrent connections, so it cost money as well as sockets.
   *
   * `trpc.useUtils()` is in fact memoized on the tRPC context, so depending on
   * `utils` directly would probably be stable too — but **the nested accessor
   * is not**: `utils.user.messages.getUnreadMessageCount` is a fresh proxy
   * object on every property access, so putting *that* in a dependency array
   * silently defeats it. A ref makes the reconnect impossible to reintroduce
   * either way.
   */
  const invalidateUnreadCount = useRef<() => void>(undefined);

  useEffect(() => {
    invalidateUnreadCount.current = () => {
      void utils.user.messages.getUnreadMessageCount.invalidate();
    };
  }, [utils]);

  useEffect(() => {
    if (!userId) return;

    // Shared client, created on first acquire and disconnected when the last
    // holder releases it. Private channel: Pusher will not join it
    // until /api/pusher/auth signs the subscription for this session.
    const pusher = acquirePusherClient();

    const channelName = notificationChannel(userId);
    const messageChannel = pusher.subscribe(channelName);

    // Authorization is a new failure mode; without this it would fail silently
    // and look like the unread badge had simply stopped working.
    messageChannel.bind("pusher:subscription_error", (status: unknown) => {
      console.error(`Could not subscribe to ${channelName}`, status);
    });

    messageChannel.bind("sendNotification", () => {
      invalidateUnreadCount.current?.();
    });

    return () => {
      messageChannel.unbind("sendNotification");
      messageChannel.unbind("pusher:subscription_error");
      pusher.unsubscribe(channelName);
      releasePusherClient();
    };
  }, [userId]);
}
