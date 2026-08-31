/**
 * Pusher channel naming.
 *
 * Both channels carry private message content, so both are Pusher *private*
 * channels. The `private-` prefix is not decoration: it is what makes Pusher
 * refuse a subscription until our auth endpoint signs it. Before this, the
 * channels were plain and named after ids that other users can already see
 * (`user.requests.me` hands out request ids; every `PublicUser` carries a user
 * id), and `NEXT_PUBLIC_PUSHER_KEY` is in the browser bundle — so anyone could
 * subscribe to a stranger's channel and read their messages in real time.
 *
 * These builders are the single source of the names, shared by the triggers in
 * the message router, the subscriptions in the components, and the authorizer.
 * A name built one way and parsed another is exactly how this kind of check
 * gets bypassed, so both directions live here.
 */

export const conversationChannel = (requestId: string) =>
  `private-conversation-${requestId}`;

export const notificationChannel = (userId: string) =>
  `private-notification-${userId}`;

export type ParsedChannel =
  | { kind: "conversation"; requestId: string }
  | { kind: "notification"; userId: string }
  | { kind: "unknown" };

/** Inverse of the builders above. Anything else is `unknown`, and denied. */
export const parseChannel = (channelName: string): ParsedChannel => {
  const conversation = /^private-conversation-(.+)$/.exec(channelName);
  if (conversation?.[1]) {
    return { kind: "conversation", requestId: conversation[1] };
  }

  const notification = /^private-notification-(.+)$/.exec(channelName);
  if (notification?.[1]) {
    return { kind: "notification", userId: notification[1] };
  }

  return { kind: "unknown" };
};
