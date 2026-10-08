import { useEffect, useRef } from "react";
import { trpc } from "../trpc";
import { notificationChannel } from "../pusherChannels";
import { acquirePusherClient, releasePusherClient } from "../pusherClient";

/**
 * Keeps the unread-message count fresh: invalidating it when a notification
 * arrives, and again when the transport reconnects, for the notifications that
 * fired while it was down.
 *
 * Invalidates `getUnreadMessageCount`, the same mechanism
 * [`MessageContent`](../../components/Messages/MessageContent.tsx) uses after
 * marking a thread read — so both directions go through one path and the
 * badge cannot drift from the database.
 *
 * **Not filtered by which tab is open.** The notification channel is per
 * *user*, not per conversation, so a message in another thread is real unread
 * mail and should be counted regardless of what the sidebar shows. The count
 * is whatever the server says, and a thread the user actually opens is marked
 * read by `MessageContent`, which brings it back down. Nothing needs to read
 * the sidebar state, so nothing does.
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
   * alone. That dependency list is load-bearing: anything less stable would
   * tear down and re-run the effect on every re-render that changes it,
   * opening a fresh WebSocket each time — and Pusher meters peak concurrent
   * connections, so that costs money as well as sockets.
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

    /**
     * Reconciliation for the events that never arrived.
     *
     * `sendNotification` is the only thing that moves the count, so a
     * notification that fires while the transport is down is not late - it is
     * gone. `Header` never unmounts while the user stays on `/`, and the query
     * takes `refetchOnMount: false`, so nothing else would ever ask again: one
     * missed event leaves the badge wrong for the rest of the session. That is
     * what makes this query different from the thread, which recovers on its
     * own the next time the user opens it.
     *
     * The badge also refetches on window focus, and that covers the common
     * case of a locked phone. This covers the one focus cannot see: a socket
     * dropped while the tab stayed in the foreground - a Wi-Fi-to-cellular
     * handoff, or Pusher closing the connection from its end. Neither fires
     * `visibilitychange`, and neither fires the `offline`/`online` pair that
     * `refetchOnReconnect` would otherwise catch.
     *
     * **Seeded from `connection.state` rather than from a bare "skip the first
     * event" flag**, which would be wrong twice over. The client is shared, so
     * `MessageContent` may have connected it before this hook ever ran; and
     * StrictMode remounts this effect against a socket that is already up. In
     * both cases no initial `connected` is coming, so a bare flag would swallow
     * the next *genuine* reconnect instead. Reading the state answers the
     * question this actually needs answered: has it been connected before now?
     */
    let seenConnected = pusher.connection.state === "connected";

    const reconcileOnReconnect = () => {
      if (!seenConnected) {
        seenConnected = true;
        return;
      }
      invalidateUnreadCount.current?.();
    };

    pusher.connection.bind("connected", reconcileOnReconnect);

    return () => {
      messageChannel.unbind("sendNotification");
      messageChannel.unbind("pusher:subscription_error");
      // Before the release below, which may be the last one and disconnect the
      // client out from under this handler.
      pusher.connection.unbind("connected", reconcileOnReconnect);
      pusher.unsubscribe(channelName);
      releasePusherClient();
    };
  }, [userId]);
}
