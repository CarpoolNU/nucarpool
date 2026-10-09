import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { z } from "zod";
import { pusherServer } from "../../pusher";
import { findOrCreateConversation } from "../../db/conversationLink";
import {
  conversationChannel,
  notificationChannel,
} from "../../../utils/pusherChannels";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { assertNotBlocked, blockedCounterpartIds } from "../../db/blocks";

/**
 * Messages per page in the open thread.
 *
 * Bigger than a screenful on purpose: the first page should almost always be
 * the whole of what a reader wants, so "load older" is the exception rather
 * than a step everyone takes. It also has to comfortably cover the unread tail
 * — see the note on `conversation` below.
 */
export const CONVERSATION_PAGE_SIZE = 30;

/**
 * How many pages' worth of ids one `markMessagesAsRead` call may carry.
 *
 * The cap is a multiple of the page size rather than the page size itself,
 * because `MessageContent` does not send one page's ids — it sends the unread
 * ids of *every page loaded so far*. Its thread is a `useInfiniteQuery`, the
 * mark-read effect filters the accumulated `allMessages`, and the mutation's
 * `onSuccess` invalidates the unread count and `requests.me` but **not**
 * `messages.conversation`. So the fetched pages keep `isRead: false` in cache,
 * and each press of "load older" resends a strictly longer array: 30, then 60,
 * then 90.
 *
 * Capping at `CONVERSATION_PAGE_SIZE` would therefore reject the second page of
 * any thread whose backlog is genuinely unread, and the client would swallow it
 * — `onError` only logs — leaving messages unread with nothing on screen to say
 * why. Twenty pages is far past what a reader will page back through while
 * anything remains unread, and still a bound.
 */
export const MAX_MARK_READ_PAGES = 20;

/** Ids accepted by one `markMessagesAsRead` call. */
export const MAX_MARK_READ_IDS = CONVERSATION_PAGE_SIZE * MAX_MARK_READ_PAGES;

/**
 * Longest id that call will consider.
 *
 * Bounding each element matters as much as bounding their number: 600 strings
 * of unbounded length is still an unbounded statement. 191 is Prisma's default
 * width for an unannotated `String` on MySQL, which is what `Message.id` is —
 * and it holds a cuid, nowhere near that. `getPresignedDownloadUrlInput` in
 * `user.ts` sets the same ceiling for the same reason.
 */
export const MESSAGE_ID_MAX_LENGTH = 191;

/**
 * The message columns the thread renders, matching the projection
 * `user.requests.me` uses.
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
    // party to, and nothing else.
    //
    // There is deliberately no filter here on the counterpart's role, or on it
    // being VIEWER, matching `user.requests.me`'s filter on the list itself:
    // the badge and the list have to agree, and a role change on either side
    // is not a reason to stop delivering messages the two people are still
    // exchanging. Hiding the thread while still counting its unread messages
    // would claim unread mail the user cannot reach; hiding the count too
    // would silently drop replies. Neither is acceptable, so this query
    // applies no role filter at all.
    //
    // Nor does it read the caller's own `CarpoolSearch`: a missing one would
    // throw NOT_FOUND, surfacing in the header as a failed query rather than a
    // count, and nothing about it is needed to answer "how many unread
    // messages are mine".
    //
    // **The nesting below is measured, not merely tolerated.** It
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
    // Not filtering on the counterpart's role is what matters for this
    // query's plan: adding that predicate back would reintroduce two
    // `DEPENDENT SUBQUERY` blocks, re-evaluated per outer row rather than
    // once. Before changing this query, re-run
    // `scripts/measure-unread-count.ts` and read `src/server/db/README.md` —
    // the numbers and the thresholds are recorded there rather than restated
    // here.
    //
    // Messages written by anyone with a block against the caller, in either
    // direction, are not counted, because `requests.me` hides the
    // thread they sit in. A conversation has exactly two parties, so leaving
    // out the counterpart's messages leaves out the conversation. `notIn` is
    // a negation like `not`, so the plan described above still holds.
    const blockedIds = await blockedCounterpartIds(ctx.prisma, userId);

    return ctx.prisma.message.count({
      where: {
        isRead: false,
        userId: {
          notIn: [userId, ...blockedIds],
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

  /**
   * One conversation's messages, newest page first, for the open thread.
   *
   * **Why this exists.** A single query cannot serve both consumers:
   * `user.requests.me` wants only the newest message per card for the
   * Requests tab, while the open thread wants everything. A `take` on that
   * shared payload would silently remove scrollback from the only consumer
   * needing it, so this procedure gives the thread its own source and keeps
   * that payload bounded — see the note on `me` in `requests.ts`.
   *
   * **Why it is keyed on `requestId`.** A bare `conversationId` would let a
   * caller name any thread directly, with nothing to check it against. A
   * request id is no more secret, so the id is not the protection — the
   * lookup is. The request row carries `fromUserId` and `toUserId`, so
   * participation is checked against stored data before a single message is
   * read. Nothing here trusts the caller.
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

      // The key check: before any message is read, so a refused caller
      // receives no content at all — not a filtered list, and not a count
      // they could probe with.
      if (request.fromUserId !== userId && request.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this conversation.",
        });
      }

      // A thread between a blocked pair is hidden, not deleted, so it is
      // refused here for either party with the same generic answer
      // and comes back intact on unblock.
      await assertNotBlocked(ctx.prisma, request.fromUserId, request.toUserId);

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
        // Bounded because `message.content` is `VARCHAR(255)`. An unbounded
        // input would reach the database and throw there, after the send bar
        // has already cleared the user's text. Trimmed before the length
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

      // Only the two people on the request may write to its conversation.
      // Without this, any signed-in user who obtained a request id
      // could inject a message into a stranger's thread — attributed to them in
      // the UI, broadcast on the conversation channel, and delivered by email.
      if (request.fromUserId !== userId && request.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this conversation.",
        });
      }

      // Before the write and so before either Pusher event: a refused
      // message is neither stored nor delivered.
      await assertNotBlocked(ctx.prisma, request.fromUserId, request.toUserId);

      // Find or create the conversation, then write the message on both
      // paths — a conversation with no prior row still gets the message, not
      // just a created-and-linked conversation with nothing in it.
      //
      // The find-or-create itself lives in `findOrCreateConversation`, shared
      // with `requests.create`'s reopen branch, which needs the same
      // two-statement link repair. One shared implementation of that repair
      // is worth having instead of two hand-written copies that could drift
      // apart.
      //
      // All three writes commit together. Repairing the missing conversation
      // takes two statements — the link is stored on both `Conversation` and
      // `Request` — so untransactioned this could link a conversation and then
      // fail to write the message the user had already typed, or create the
      // conversation without linking it back. Pusher stays outside
      // the transaction below: it is a side effect that cannot be rolled back,
      // and it must not run until the message is durable.
      const newMessage = await ctx.prisma.$transaction(async (tx) => {
        const conversation = await findOrCreateConversation(
          tx,
          input.requestId,
        );

        return await tx.message.create({
          data: {
            conversationId: conversation.id,
            content: input.content,
            userId: userId,
            // `sendMessageNotification` sends at most one email per message
            // it finds marked here. The opening message
            // `requests.create` writes is left unmarked: the request email
            // announces that one.
            notificationPending: true,
          },
        });
      });

      // Notify whichever party did not send this message. Always addressing
      // `request.toUserId` would deliver a reply from the request's recipient
      // to their own notification channel and never tell the original sender.
      // The participant check above makes this total: the caller is one of
      // the two, so the other one is the recipient.
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

  /**
   * Marks the caller's unread messages read, scoped to conversations they are
   * a party to.
   *
   * Without a ceiling, this would be the one list-shaped input in this router
   * that a caller could size freely — the array goes straight into
   * `id: { in: ... }`, so how large an `IN` list MySQL parses and plans would
   * be the caller's choice. The ownership predicate below eliminates the rows
   * either way, so nothing could be marked read that the caller does not own;
   * the cost would be in planning a statement that could not match, and in
   * the packet size PlanetScale would have to accept.
   *
   * `.strict()` for the same reason the other hardened inputs have it: a
   * mistyped or re-added key should be a `BAD_REQUEST`, not silently dropped.
   *
   * "Unread" means unread by the recipient, so the caller's own messages are
   * excluded here rather than left to `MessageContent` alone to filter out;
   * otherwise a direct call could mark a sender's own messages read before
   * the other person had seen them.
   */
  markMessagesAsRead: protectedRouter
    .input(
      z
        .object({
          messageIds: z
            .array(z.string().min(1).max(MESSAGE_ID_MAX_LENGTH))
            .max(MAX_MARK_READ_IDS),
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

      return ctx.prisma.message.updateMany({
        where: {
          id: { in: input.messageIds },
          userId: { not: userId },
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
