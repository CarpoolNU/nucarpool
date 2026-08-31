import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { z } from "zod";
import { pusherServer } from "../../pusher";
import {
  conversationChannel,
  notificationChannel,
} from "../../../utils/pusherChannels";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";

/**
 * Messages per page in the open thread (SCRUM-317).
 *
 * Bigger than a screenful on purpose: the first page should almost always be
 * the whole of what a reader wants, so "load older" is the exception rather
 * than a step everyone takes. It also has to comfortably cover the unread tail
 * — see the note on `conversation` below.
 */
export const CONVERSATION_PAGE_SIZE = 30;

/**
 * The message columns the thread renders, matching the projection
 * `user.requests.me` uses (SCRUM-301).
 *
 * Deliberately no author relation. The author is always one of the two people
 * already in the payload, and `sendMessage` broadcasts a bare `message.create`
 * over Pusher — so anything reading `message.User` would be blank for every
 * message that arrived in real time anyway.
 */
const conversationMessageColumns = {
  id: true,
  conversationId: true,
  content: true,
  userId: true,
  isRead: true,
  dateCreated: true,
} as const;

export const messageRouter = router({
  getUnreadMessageCount: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;
    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    // The badge counts unread messages in every conversation the caller is a
    // party to, and nothing else (SCRUM-296).
    //
    // It used to require the counterpart's role to differ from the caller's and
    // not be VIEWER, mirroring the filter `user.requests.me` applied to the
    // list itself. Both are gone: the badge and the list have to agree, and a
    // role change on either side is not a reason to stop delivering messages
    // the two people are still exchanging. Counting them while the thread was
    // hidden was the worse half of that - the header claimed unread mail the
    // user could not reach - but suppressing them silently dropped replies.
    //
    // The caller's own `CarpoolSearch` was read only for that comparison, and
    // its absence threw NOT_FOUND, which surfaced in the header as a failed
    // query rather than a count. Neither is needed to answer "how many unread
    // messages are mine".
    //
    // **The nesting below is measured, not merely tolerated (SCRUM-306).** It
    // compiles to two levels of `IN` subquery over `message` — the fastest
    // growing table here — filtered on `isRead`, which carries no index, and
    // that reads like a problem waiting to happen. It is not one: MySQL drives
    // the whole plan from the caller's own `request` rows via
    // `request_fromUserId_idx` / `request_toUserId_idx` and reaches `message` by
    // primary key, so the cost scales with how much mail *this caller* has
    // rather than with the size of the table.
    //
    // No index was added, and an index on `isRead` specifically cannot help: the
    // final access is already `eq_ref` on `PRIMARY`, and a boolean has two
    // distinct values, which is not selectivity. Nor can `(userId, isRead)` —
    // `userId: { not: ... }` is a negation and no B-tree range-scans one. If
    // this ever does need an index the shape is
    // `message(conversationId, isRead, userId)`.
    //
    // Removing the role predicate in SCRUM-296 is what actually mattered: it
    // deleted two `DEPENDENT SUBQUERY` blocks from the plan, which are
    // re-evaluated per outer row rather than once. Before changing this query,
    // re-run `scripts/measure-unread-count.ts` and read
    // `src/server/db/README.md` — the numbers and the thresholds are recorded
    // there rather than restated here.
    return ctx.prisma.message.count({
      where: {
        isRead: false,
        userId: {
          not: userId,
        },
        conversation: {
          request: {
            some: {
              OR: [{ fromUserId: userId }, { toUserId: userId }],
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
  //
  // `conversation` below is its deliberate replacement (SCRUM-317), and differs
  // in the way that mattered: it is keyed on a **request id**, not a
  // conversation id, so authorization is derived from the row rather than
  // trusted from the input. It is the same shape as `sendMessage`'s check.

  /**
   * One conversation's messages, newest page first, for the open thread
   * (SCRUM-317).
   *
   * **Why this exists.** `user.requests.me` used to return the complete history
   * of every conversation the caller was party to, on every mount, because one
   * query fed two consumers: the Requests tab, which wants only the newest
   * message per card, and the open thread, which wants everything. A `take` on
   * the shared payload would have silently removed scrollback from the only
   * consumer needing it. This procedure gives the thread its own source so that
   * payload can be bounded — see the note on `me` in `requests.ts`.
   *
   * **Why it is keyed on `requestId`.** The procedure this replaces took a bare
   * `conversationId` and returned whatever it named, which let any signed-in
   * caller read any thread (SCRUM-222). A request id is no more secret, so the
   * id is not the protection — the lookup is. The request row carries
   * `fromUserId` and `toUserId`, so participation is checked against stored
   * data before a single message is read. Nothing here trusts the caller.
   *
   * Messages are scoped through `conversation.requestId`, which is `@unique`,
   * rather than through `Request.conversationId`. Both links exist and both are
   * written, but the one on `Conversation` is the authoritative side, so this
   * cannot be fooled by a `Request` row whose scalar was never populated.
   *
   * **Pagination.** Newest-first, so the first page is what a reader wants to
   * see, and `nextCursor` walks backwards into history. `messages` comes back
   * oldest-first because that is render order. Ordered by `(dateCreated, id)`
   * descending: `dateCreated` alone is not a total order — the seed writes
   * several messages inside one transaction and a fast sender can too — and a
   * cursor over a non-total order silently skips or repeats rows.
   *
   * A conversation that does not exist yet is an empty first page rather than a
   * `NOT_FOUND`: a request with no messages is an ordinary state, and
   * `sendMessage` creates the conversation on the first send.
   */
  conversation: protectedRouter
    .input(
      z.object({
        requestId: z.string(),
        /**
         * Id of the oldest message the client already holds. The next page
         * continues strictly before it. `nullish` rather than `optional`
         * because tRPC's `useInfiniteQuery` sends `null` for the first page.
         */
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(100).default(CONVERSATION_PAGE_SIZE),
      }),
    )
    .query(async ({ ctx, input }) => {
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

      // The whole point of the rewrite. Checked before any message is read, so
      // a refused caller receives no content at all — not a filtered list, and
      // not a count they could probe with.
      if (request.fromUserId !== userId && request.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this conversation.",
        });
      }

      // One extra row, to learn whether another page exists without a second
      // round trip or a `count` over the whole thread.
      const rows = await ctx.prisma.message.findMany({
        where: { conversation: { requestId: input.requestId } },
        select: conversationMessageColumns,
        orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor
          ? { cursor: { id: input.cursor }, skip: 1 }
          : undefined),
      });

      const hasOlder = rows.length > input.limit;
      const page = hasOlder ? rows.slice(0, input.limit) : rows;

      return {
        messages: [...page].reverse(),
        // The oldest row on this page. Null when the thread is exhausted, which
        // is what stops `useInfiniteQuery` offering "load older".
        nextCursor: hasOlder ? (page[page.length - 1]?.id ?? null) : null,
      };
    }),

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
      //
      // All three writes commit together. Repairing the missing conversation
      // takes two statements — the link is stored on both `Conversation` and
      // `Request` — so untransactioned this could link a conversation and then
      // fail to write the message the user had already typed, or create the
      // conversation without linking it back (SCRUM-233). Pusher stays outside
      // the transaction below: it is a side effect that cannot be rolled back,
      // and it must not run until the message is durable.
      const newMessage = await ctx.prisma.$transaction(async (tx) => {
        let conversation = await tx.conversation.findUnique({
          where: { requestId: input.requestId },
        });

        if (!conversation) {
          conversation = await tx.conversation.create({
            data: { requestId: input.requestId },
          });

          await tx.request.update({
            where: { id: input.requestId },
            data: { conversationId: conversation.id },
          });
        }

        return await tx.message.create({
          data: {
            conversationId: conversation.id,
            content: input.content,
            userId: userId,
          },
        });
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
