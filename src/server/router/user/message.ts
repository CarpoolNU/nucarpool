import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { z } from "zod";
import Pusher from "pusher";
import { serverEnv } from "../../../utils/env/server";
import { message } from "antd";

const pusher = new Pusher({
  appId: serverEnv.PUSHER_APP_ID,
  key: serverEnv.NEXT_PUBLIC_PUSHER_KEY,
  secret: serverEnv.PUSHER_SECRET,
  cluster: serverEnv.NEXT_PUBLIC_PUSHER_CLUSTER,
  useTLS: true,
});

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

  getMessages: protectedRouter
    .input(z.string())
    .query(async ({ ctx, input: conversationId }) => {
      const userId = ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      return ctx.prisma.message.findMany({
        where: { conversationId },
        orderBy: { dateCreated: "asc" },
        include: {
          User: {
            select: { id: true, name: true, preferredName: true, image: true },
          },
        },
      });
    }),

  sendMessage: protectedRouter
    .input(
      z.object({
        requestId: z.string(),
        content: z.string(),
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
      // sender was never told (SCRUM-230).
      //
      // For a caller who is not a party to the request at all this falls back
      // to `fromUserId`. That state should not be reachable, and making it
      // unreachable is the authorization fix tracked in SCRUM-222 — not
      // widened into this correctness fix.
      const recipientId =
        request.fromUserId === userId ? request.toUserId : request.fromUserId;

      // The message is already durable at this point, so a Pusher outage must
      // not fail the mutation and invite the user to send a duplicate. Awaited
      // rather than fire-and-forget so a failure is logged here instead of
      // surfacing as an unhandled rejection.
      try {
        await Promise.all([
          pusher.trigger(`conversation-${input.requestId}`, "sendMessage", {
            newMessage,
          }),
          pusher.trigger(`notification-${recipientId}`, "sendNotification", {
            newMessage,
          }),
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
