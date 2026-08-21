import type { PrismaClient } from "@prisma/client";
import { parseChannel } from "../utils/pusherChannels";

type PrismaLike = Pick<PrismaClient, "request">;

/**
 * May `userId` subscribe to `channelName`? (SCRUM-224)
 *
 * Deliberately a plain function rather than logic inside the API route, so the
 * decision can be tested directly — this is the whole of the realtime access
 * control, and an HTTP harness would obscure it.
 *
 * Deny by default: anything that is not a channel shape we recognise returns
 * false, so adding a new channel without adding a rule fails closed.
 */
export const canSubscribe = async (
  prisma: PrismaLike,
  userId: string,
  channelName: string,
): Promise<boolean> => {
  const channel = parseChannel(channelName);

  switch (channel.kind) {
    case "notification":
      // A user's own notification feed, and nobody else's.
      return channel.userId === userId;

    case "conversation": {
      // Only the two parties on the request behind this conversation. Mirrors
      // the check `sendMessage` applies on the write side (SCRUM-222) — the
      // API and the realtime layer are two doors to the same data.
      const request = await prisma.request.findUnique({
        where: { id: channel.requestId },
        select: { fromUserId: true, toUserId: true },
      });

      if (!request) return false;
      return request.fromUserId === userId || request.toUserId === userId;
    }

    case "unknown":
    default:
      return false;
  }
};
