import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { z } from "zod";
import { message } from "antd";
import { pusherServer } from "../../pusher";
import {
  conversationChannel,
  notificationChannel,
} from "../../../utils/pusherChannels";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";

export const messageRouter = router({
  getUnreadMessageCount: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;
    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const carpoolSearch = await ctx.prisma.carpoolSearch.findFirst({
      where: { userId },
      select: { role: true },
    });

    if (!carpoolSearch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User carpool search not found",
      });
    }

    return ctx.prisma.message.count({
      where: {
        isRead: false,
        userId: {
          not: userId,
        },
        conversation: {
          request: {
            some: {
              OR: [
                {
                  fromUserId: userId,
                  toUser: {
                    carpoolSearches: {
                      some: {
                        role: { not: carpoolSearch.role },
                        AND: { role: { not: "VIEWER" } },
                      },
                    },
                  },
                },
                {
                  toUserId: userId,
                  fromUser: {
                    carpoolSearches: {
                      some: {
                        role: { not: carpoolSearch.role },
                        AND: { role: { not: "VIEWER" } },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  }),

  // `getMessages` used to sit here (SCRUM-222). It took a bare conversation id
  // and returned every message in it — including each author's name and profile
  // image — after reading the session user and then never using it, so any
  // signed-in caller could read any conversation. It is removed rather than
  // scoped: its only two callers ever, in `Header.tsx` and `MessagePanel.tsx`,
  // both arrived in commits that were reverted (7d423fa and 4c69fb0, reverted
  // by c8a92c9 and 7280573), leaving unreachable surface that carried only
  // risk. Conversations reach the UI through `user.requests.me`, which is
  // already scoped to the caller's own requests.

  sendMessage: protectedRouter
    .input(
      z.object({
        requestId: z.string(),
        // Bounded because `message.content` is `VARCHAR(255)` (SCRUM-231). An
        // unbounded input reached the database and threw there, after the send
        // bar had already cleared the user's text. Trimmed before the length
        // checks so whitespace neither passes `.min(1)` nor consumes the cap,
        // and so the stored value matches what `SendBar` sends.
        content: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      const request = await ctx.prisma.request.findUnique({
        where: { id: input.requestId },
        select: { id: true, fromUserId: true, toUserId: true },
      });

      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No request with id '${input.requestId}'`,
        });
      }

      // Only the two people on the request may write to its conversation
      // (SCRUM-222). Without this, any signed-in user who obtained a request id
      // could inject a message into a stranger's thread — attributed to them in
      // the UI, broadcast on the conversation channel, and delivered by email.
      if (request.fromUserId !== userId && request.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this conversation.",
        });
      }

      // Find or create the conversation. This used to be two exclusive
      // branches where only the "already exists" one wrote the message, so a
      // first message on a request with no conversation row was created,
      // linked, and then silently discarded with a success response
      // (SCRUM-230). The message is now written on both paths.
      let conversation = await ctx.prisma.conversation.findUnique({
        where: { requestId: input.requestId },
      });

      if (!conversation) {
        conversation = await ctx.prisma.conversation.create({
          data: { requestId: input.requestId },
        });

        await ctx.prisma.request.update({
          where: { id: input.requestId },
          data: { conversationId: conversation.id },
        });
      }

      const newMessage = await ctx.prisma.message.create({
        data: {
          conversationId: conversation.id,
          content: input.content,
          userId: userId,
        },
      });

      // Notify whichever party did not send this message. The old code always
      // addressed `request.toUserId`, so a reply from the request's recipient
      // was delivered to their own notification channel and the original
      // sender was never told (SCRUM-230). The participant check above makes
      // this total: the caller is one of the two, so the other one is the
      // recipient.
      const recipientId =
        request.fromUserId === userId ? request.toUserId : request.fromUserId;

      // The message is already durable at this point, so a Pusher outage must
      // not fail the mutation and invite the user to send a duplicate. Awaited
      // rather than fire-and-forget so a failure is logged here instead of
      // surfacing as an unhandled rejection.
      try {
        await Promise.all([
          pusherServer.trigger(
            conversationChannel(input.requestId),
            "sendMessage",
            { newMessage },
          ),
          pusherServer.trigger(
            notificationChannel(recipientId),
            "sendNotification",
            { newMessage },
          ),
        ]);
      } catch (error) {
        console.error(
          `Real-time delivery failed for message ${newMessage.id}; the message was saved.`,
          error,
        );
      }

      return newMessage;
    }),

  markMessagesAsRead: protectedRouter
    .input(
      z.object({
        messageIds: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      return ctx.prisma.message.updateMany({
        where: {
          id: { in: input.messageIds },
          conversation: {
            request: {
              some: {
                OR: [{ fromUserId: userId }, { toUserId: userId }],
              },
            },
          },
        },
        data: {
          isRead: true,
        },
      });
    }),
});
