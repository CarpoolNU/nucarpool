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
  useTLS: true
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

    const user = await ctx.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
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
                    role: { not: user.role },
                    AND: { role: { not: "VIEWER" } },
                  },
                },
                {
                  toUserId: userId,
                  fromUser: {
                    role: { not: user.role },
                    AND: { role: { not: "VIEWER" } },
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      let conversation = await ctx.prisma.conversation.findUnique({
        where: { requestId: input.requestId },
      });

      // notify the frontend in real time 
      if (conversation) {

        console.log("Conversation:", conversation);
        console.log("Conversation ID:", conversation?.id);

        const newMessage = await ctx.prisma.message.create({
          data: {
            conversationId: conversation.id,
            content: input.content,
            userId: userId,
          },
        });

        console.log("backend message", newMessage)
        
        pusher.trigger("conversation", "sendMessage", {
          requestId: input.requestId,
          newMessage: newMessage,
        });
      }

      if (!conversation) {
        conversation = await ctx.prisma.conversation.create({
          data: { requestId: input.requestId },
        });

        await ctx.prisma.request.update({
          where: { id: input.requestId },
          data: { conversationId: conversation.id },
        });
      }
    }),

  markMessagesAsRead: protectedRouter
    .input(
      z.object({
        messageIds: z.array(z.string()),
      })
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
