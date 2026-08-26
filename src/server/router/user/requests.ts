import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";

import { RequestStatus } from "@prisma/client";
import { convertCarpoolSearchToPublicWithExactHome } from "../../../utils/publicUser";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";

// use this router to manage invitations
export const requestsRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const user = await ctx.prisma.user.findUnique({
      where: { id: userId },
      include: {
        sentRequests: {
          include: {
            toUser: true,
            conversation: {
              include: {
                messages: {
                  orderBy: { dateCreated: "asc" },
                  include: { User: true },
                },
              },
            },
          },
        },
        receivedRequests: {
          include: {
            fromUser: true,
            conversation: {
              include: {
                messages: {
                  orderBy: { dateCreated: "asc" },
                  include: { User: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No profile with id '${userId}'`,
      });
    }

    // get current user CarpoolSearch
    const currentUserSearch = await ctx.prisma.carpoolSearch.findFirst({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            bio: true,
            preferredName: true,
            pronouns: true,
          },
        },
        homeLocation: true,
        companyLocation: true,
      },
    });

    if (!currentUserSearch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No carpool search found for user ${userId}`,
      });
    }

    // get CarpoolSearches for all users in sent requests
    const sentUserIds = user.sentRequests.map((req) => req.toUserId);
    const sentCarpoolSearches = await ctx.prisma.carpoolSearch.findMany({
      where: {
        userId: { in: sentUserIds },
        status: { not: "INACTIVE" },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            bio: true,
            preferredName: true,
            pronouns: true,
          },
        },
        homeLocation: true,
        companyLocation: true,
      },
    });

    // get CarpoolSearches for all users in received requests
    const receivedUserIds = user.receivedRequests.map((req) => req.fromUserId);
    const receivedCarpoolSearches = await ctx.prisma.carpoolSearch.findMany({
      where: {
        userId: { in: receivedUserIds },
        status: { not: "INACTIVE" },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            bio: true,
            preferredName: true,
            pronouns: true,
          },
        },
        homeLocation: true,
        companyLocation: true,
      },
    });

    const sent = user.sentRequests.map((req) => {
      const toUserSearch = sentCarpoolSearches.find(
        (s) => s.userId === req.toUserId,
      );
      return {
        ...req,
        fromUser: convertCarpoolSearchToPublicWithExactHome(currentUserSearch),
        toUser: toUserSearch
          ? convertCarpoolSearchToPublicWithExactHome(toUserSearch)
          : null,
      };
    });

    const received = user.receivedRequests.map((req) => {
      const fromUserSearch = receivedCarpoolSearches.find(
        (s) => s.userId === req.fromUserId,
      );
      return {
        ...req,
        fromUser: fromUserSearch
          ? convertCarpoolSearchToPublicWithExactHome(fromUserSearch)
          : null,
        toUser: convertCarpoolSearchToPublicWithExactHome(currentUserSearch),
      };
    });

    const sentGoodRole = sent.filter(
      (req) =>
        req.toUser &&
        req.toUser.role !== currentUserSearch.role &&
        req.toUser.role !== "VIEWER",
    );
    const recGoodRole = received.filter(
      (req) =>
        req.fromUser &&
        req.fromUser.role !== currentUserSearch.role &&
        req.fromUser.role !== "VIEWER",
    );
    return { sent: sentGoodRole, received: recGoodRole };
  }),

  create: protectedRouter
    .input(
      z
        .object({
          // The sender is deliberately absent from this input (SCRUM-221). It
          // used to be a client-supplied `fromId` that became the request's
          // `fromUser`, so any signed-in caller could send a request that
          // appeared to come from someone else. The sender now comes from the
          // session and cannot be influenced by the client; `.strict()` makes a
          // re-added `fromId` a BAD_REQUEST rather than a silently ignored field.
          toId: z.string(),
          // This becomes the conversation's first `Message`, so it is bound by
          // `message.content`'s `VARCHAR(255)` like any other (SCRUM-231).
          // Deliberately not `.min(1)`: ConnectModal's textarea starts empty
          // and its Send button never required text, so sending a bare request
          // is an existing flow rather than an oversight to close here.
          message: z.string().trim().max(MESSAGE_MAX_LENGTH),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }
      // A request to yourself is not something the UI can produce — ConnectModal
      // opens from someone else's card — but `toId` is client input on a
      // mutation any signed-in caller can reach (SCRUM-278). The duplicate
      // guard below cannot catch it: for a self-request both halves of its OR
      // are the same pair, so the first one always passes and the row is
      // created, along with a Conversation and an initial Message.
      if (input.toId === userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot send a carpool request to yourself.",
        });
      }

      // Two people already carpooling together have nothing to request of each
      // other, and a request between them would be a second way to describe a
      // relationship the group already records (SCRUM-228).
      const searches = await ctx.prisma.carpoolSearch.findMany({
        where: { userId: { in: [userId, input.toId] } },
        select: { userId: true, carpoolId: true },
      });
      const callerGroup = searches.find((s) => s.userId === userId)?.carpoolId;
      const targetGroup = searches.find(
        (s) => s.userId === input.toId,
      )?.carpoolId;

      if (callerGroup && callerGroup === targetGroup) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You are already in a carpool group with this user.",
        });
      }

      const existingRequest = await ctx.prisma.request.findFirst({
        where: {
          OR: [
            {
              fromUserId: userId,
              toUserId: input.toId,
            },
            {
              fromUserId: input.toId,
              toUserId: userId,
            },
          ],
        },
      });

      // Still awaiting an answer, in either direction — the original guard.
      if (existingRequest?.status === RequestStatus.PENDING) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Existing request between '${input.toId} and ${userId}'`,
        });
      }

      // An accepted request the pair have since left behind. Reopening it,
      // rather than adding a second row, is what lets two people who once
      // carpooled together do so again (SCRUM-228). It also keeps the pair to
      // one Request row for good: `extendPublicUser` picks the request for a
      // user with `.find()`, so a second row would make which conversation the
      // UI shows arbitrary.
      //
      // The direction is rewritten because whoever is asking now is the sender
      // now, regardless of who asked the first time. The conversation is not
      // touched: it hangs off the request id, which does not change, so the
      // pair keep the thread they already had.
      if (existingRequest) {
        return await ctx.prisma.$transaction(async (tx) => {
          const reopened = await tx.request.update({
            where: { id: existingRequest.id },
            data: {
              status: RequestStatus.PENDING,
              fromUserId: userId,
              toUserId: input.toId,
            },
          });

          // An empty message is a real flow — ConnectModal's Send button never
          // required text — but on a conversation that already exists, an empty
          // row would just be noise in the thread. On a first request it is
          // still written, because the conversation needs a first message.
          if (input.message && reopened.conversationId) {
            await tx.message.create({
              data: {
                conversationId: reopened.conversationId,
                content: input.message,
                userId,
              },
            });
          }

          return reopened;
        });
      }

      // A request, its conversation, the link between them and the first
      // message are one unit. These used to be four independent awaits, which
      // could leave a request with no conversation, or a conversation never
      // linked back to its request — and `relationMode = "prisma"` rejects
      // neither, so the half-built thread persisted (SCRUM-233).
      //
      // The link is stored twice, in both directions: `Conversation.requestId`
      // and `Request.conversationId`. Nothing in the schema keeps those two in
      // agreement, which is why writing a conversation still takes two
      // statements rather than one nested create.
      //
      // What this protects on the read side: `user.requests.me` above includes
      // `conversation.messages` through the request, so a thread that exists on
      // one side of the link only is invisible from the other.
      const request = await ctx.prisma.$transaction(async (tx) => {
        const created = await tx.request.create({
          data: {
            message: "",
            fromUser: {
              connect: { id: userId },
            },
            toUser: {
              connect: { id: input.toId },
            },
          },
        });

        // The conversation and its first message go in together. No lookup
        // first: the request was created a statement ago with a fresh cuid, so
        // nothing could reference it and the old
        // `conversation.findUnique({ where: { requestId } })` could only ever
        // return null — a check whose false branch was unreachable.
        const conversation = await tx.conversation.create({
          data: {
            requestId: created.id,
            messages: {
              create: {
                content: input.message,
                userId: userId,
              },
            },
          },
        });

        // Returned rather than discarded so the value carries the conversation.
        return await tx.request.update({
          where: { id: created.id },
          data: { conversationId: conversation.id },
        });
      });

      // Returned so the caller has an id to announce (SCRUM-270). This used to
      // return nothing, which is why ConnectModal had to notify by `toId` and
      // the email procedure had to accept a bare user id.
      return request;
    }),

  delete: protectedRouter
    .input(
      z.object({
        invitationId: z.string(),
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

      const invitation = await ctx.prisma.request.findUnique({
        where: { id: input.invitationId },
      });

      if (!invitation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No invitation with id '${input.invitationId}'`,
        });
      }

      // Both parties may clear a request: the sender withdraws it, the
      // recipient declines it (`handleRejectRequest` in requestHandlers.ts).
      // Before SCRUM-221 there was no check at all, so any signed-in user could
      // delete strangers' pending requests out of their Requests tab.
      if (invitation.fromUserId !== userId && invitation.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this request.",
        });
      }

      await ctx.prisma.request.delete({
        where: {
          id: input.invitationId,
        },
      });
    }),
});
