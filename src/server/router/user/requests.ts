import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";

import { Prisma, RequestStatus } from "@prisma/client";
import {
  convertCarpoolSearchToPublicWithExactHome,
  convertRequestCounterpart,
} from "../../publicUser";
import {
  conversationsToDeleteWith,
  findOrCreateConversation,
} from "../../db/conversationLink";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";

/**
 * The message columns a conversation is actually read through.
 *
 * This was `include: { User: true }`, which attached the author's whole `User`
 * row to every message - `email`, `bio`, `permission`, and `image`, a
 * `@db.MediumText`. Nothing ever read it. Five fields are all any consumer
 * touches - `id`, `content`, `userId`, `isRead` and `dateCreated`, between
 * `latestMessage.ts`, `MessageContent` and `MessagePanel` - and the author is
 * always one of the two people already present in the payload, so a 200-message
 * thread carried the same two user rows 200 times.
 *
 * The live path already proved the join redundant. `messages.sendMessage`
 * returns a bare `message.create` with no `include` and broadcasts that over
 * Pusher, and `MessageContent` pushes it into the same array this query fills -
 * so anything rendering `message.User` would already be blank for every
 * message received in real time.
 *
 * `isRead` and `id` are load-bearing rather than cosmetic: `MessageContent`
 * drives `markMessagesAsRead` off exactly those two. `conversationId` is the
 * sixth field below and the one exception: nothing reads it off a fetched
 * message, but `Message` in `utils/types.ts` declares it required, so it is kept
 * for one string rather than letting the wire shape drift from the type.
 *
 * **Bounded to one message.** This used to return the whole history
 * of every conversation, because the open thread read it too and bounding it
 * would have been silent truncation. The thread now loads from
 * `user.messages.conversation`, which is paginated and participant-scoped, so
 * this can return what the card list actually needs: the newest message per
 * conversation, for the preview text and the unread dot.
 *
 * `desc` + `take: 1` rather than `asc`, so the one row kept is the newest.
 * `getLatestMessageForRequest` still sorts what it is given and takes `[0]`, so
 * it is correct either way - but it can only pick the newest message if the
 * newest message is the one present.
 */
const conversationMessages = {
  orderBy: { dateCreated: "desc" },
  take: 1,
  select: {
    id: true,
    conversationId: true,
    content: true,
    userId: true,
    isRead: true,
    dateCreated: true,
  },
} satisfies Prisma.Conversation$messagesArgs;

// use this router to manage invitations
export const requestsRouter = router({
  /**
   * Every request either side of the caller, with the newest message of each
   * pair's conversation.
   *
   * **Message history is now bounded.** It was not, and the reason
   * is worth keeping: one query fed two consumers with different needs — the
   * Requests tab, which wants only the newest message per card
   * (`getLatestMessageForRequest`), and the open thread, which renders the whole
   * history. A `take` while both read this would have silently removed
   * scrollback from the one consumer that needed it.
   *
   * The thread now reads `user.messages.conversation` instead, which is
   * paginated and — unlike `messages.getMessages`, removed for
   * taking a bare conversation id — authorizes against the request row. With
   * the two consumers separated, this one can return the single row the cards
   * use, which is what `take: 1` above does.
   *
   * Narrowing the projection had already made each message cheap, dropping a whole `User` row
   * per message. That was the larger factor by far; this removes what was left
   * of the linear growth. `scripts/measure-requests-payload.ts` measures both.
   */
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
            conversation: { include: { messages: conversationMessages } },
          },
        },
        receivedRequests: {
          include: {
            conversation: { include: { messages: conversationMessages } },
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

    // The caller's own row stays exact on both sides below. It is their own
    // home coordinate and their own address, which they already have; the two
    // converters exist to decide what is disclosed about *somebody else*.
    //
    // The counterpart is the one that has to be earned, and until SCRUM-368 it
    // was not: both projections were unconditionally the exact-home converter,
    // so a request the caller had created themselves a moment earlier released
    // the other person's precise home coordinate and Northeastern address.
    // `requests.create` takes a bare `toId` and asks nobody, so that made the
    // whole matchable user base readable by anyone willing to send one request
    // per id out of `mapbox.geoJsonUserList`. `convertRequestCounterpart` owns
    // the rule and says why `ACCEPTED` is the line.
    //
    // Note what did *not* change: every request either party has is still
    // returned. SCRUM-296 and SCRUM-316 both closed dead ends caused by
    // requests disappearing from this list, so the fix narrows disclosure
    // rather than visibility.
    const sent = user.sentRequests.map((req) => {
      const toUserSearch = sentCarpoolSearches.find(
        (s) => s.userId === req.toUserId,
      );
      return {
        ...req,
        fromUser: convertCarpoolSearchToPublicWithExactHome(currentUserSearch),
        toUser: toUserSearch
          ? convertRequestCounterpart(toUserSearch, req.status)
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
          ? convertRequestCounterpart(fromUserSearch, req.status)
          : null,
        toUser: convertCarpoolSearchToPublicWithExactHome(currentUserSearch),
      };
    });

    // Role compatibility governs discovery, not a relationship that already
    // exists.
    //
    // These two filters used to also drop any request whose counterpart's role
    // matched the caller's, or was VIEWER - the predicate f9a5b1a introduced
    // for recommendations, where it belongs. Applied to existing requests it
    // disagreed with `create`'s duplicate guard below, which has no role
    // condition: as soon as either party changed role, the request disappeared
    // from the Requests tab while still answering every retry with
    // `CONFLICT - Existing request between ...`. Nothing else surfaces the
    // request id, and `delete` needs one, so there was no way to withdraw it
    // and no way out but for the other person to switch back.
    //
    // Roles change legitimately between co-op cycles, so a pair who can no
    // longer carpool is an ordinary state. `roleMismatchExplanation` is what
    // the UI shows on those requests, and accepting one is refused by
    // `groups.create`/`groups.edit` rather than by hiding it here.
    //
    // The null check that remains is not about roles: a counterpart whose
    // search is INACTIVE is absent from the two queries above, so there is no
    // `PublicUser` to build a card from.
    return {
      sent: sent.filter((req) => req.toUser !== null),
      received: received.filter((req) => req.fromUser !== null),
    };
  }),

  create: protectedRouter
    .input(
      z
        .object({
          // The sender is deliberately absent from this input. It
          // used to be a client-supplied `fromId` that became the request's
          // `fromUser`, so any signed-in caller could send a request that
          // appeared to come from someone else. The sender now comes from the
          // session and cannot be influenced by the client; `.strict()` makes a
          // re-added `fromId` a BAD_REQUEST rather than a silently ignored field.
          toId: z.string(),
          // This becomes the conversation's first `Message`, so it is bound by
          // `message.content`'s `VARCHAR(255)` like any other.
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
      // mutation any signed-in caller can reach. The duplicate
      // guard below cannot catch it: for a self-request both halves of its OR
      // are the same pair, so the first one always passes and the row is
      // created, along with a Conversation and an initial Message.
      if (input.toId === userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot send a carpool request to yourself.",
        });
      }

      // A request is only useful if both people can be notified, and this is
      // now the only place that is knowable: `email` has been removed from the
      // payloads the client builds this call from, because they shipped every
      // active user's address to every signed-in viewer. ConnectModal used to
      // hold this check alone, which also meant a caller reaching the procedure
      // directly skipped it entirely.
      const contacts = await ctx.prisma.user.findMany({
        where: { id: { in: [userId, input.toId] } },
        select: { id: true, email: true },
      });

      const senderEmail = contacts.find((c) => c.id === userId)?.email;
      const recipientEmail = contacts.find((c) => c.id === input.toId)?.email;

      if (!senderEmail || !recipientEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A carpool request needs an email address for both people. " +
            "Please check your profile.",
        });
      }

      // Two people already carpooling together have nothing to request of each
      // other, and a request between them would be a second way to describe a
      // relationship the group already records.
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

      // The lookup and whichever branch it selects commit together.
      //
      // The read used to sit outside any transaction, and the branch it chose
      // then opened one — so the decision was taken against a snapshot that
      // could already be stale by the time it was acted on. A double-clicked
      // Send sent two calls; both found no row, both took the create branch,
      // and the pair ended up with two Request rows, two Conversations, two
      // first Messages and two notification emails. Withdrawing then deleted
      // one row by id and left the other, so the next attempt was refused with
      // CONFLICT for a request neither party could see — a dead end reachable
      // by an ordinary double-click.
      //
      // **This narrows the window; it does not close it.** MySQL will not lock
      // rows a non-locking SELECT did not find, so two transactions can still
      // both see nothing and both insert. The guarantee is procedural, not
      // enforced: `ConnectModal` disables Send while the mutation is in flight,
      // which is what removes the realistic path, and there is deliberately no
      // unique constraint — see "One request per pair" in
      // `src/server/db/README.md` for why, and for what would have to change to
      // make it structural.
      const request = await ctx.prisma.$transaction(async (tx) => {
        const existingRequest = await tx.request.findFirst({
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
        // carpooled together do so again. It also keeps the pair to
        // one Request row for good: `extendPublicUser` picks the request for a
        // user with `.find()`, so a second row would make which conversation
        // the UI shows arbitrary.
        //
        // The direction is rewritten because whoever is asking now is the
        // sender now, regardless of who asked the first time. The conversation
        // is not touched: it hangs off the request id, which does not change,
        // so the pair keep the thread they already had.
        if (existingRequest) {
          const reopened = await tx.request.update({
            where: { id: existingRequest.id },
            data: {
              status: RequestStatus.PENDING,
              fromUserId: userId,
              toUserId: input.toId,
            },
          });

          // Two decisions that used to share one `if`, for two unrelated
          // reasons.
          //
          // *Whether* to write a message is the empty-message question. An
          // empty message is a real flow — ConnectModal's Send button never
          // required text — and on a reopened request an empty row would just
          // be noise in a thread that already has history. On a first request
          // it is still written, because the conversation needs a first
          // message. That behaviour is unchanged.
          //
          // *Where* to write it is a different question, and the compound
          // guard answered it wrongly: it also required
          // `reopened.conversationId`, so a request with no conversation had
          // the user's text silently dropped while the mutation still
          // resolved. The client raised its success toast and
          // `sendRequestNotification` emailed the recipient a preview of a
          // message that was never stored — so the recipient opened an empty
          // thread holding an email that quoted it. That is not a defensive
          // check against an impossible state: every request predating
          // migration `20240910182030_conversationmodel` has a null link, 462
          // of 477 rows on production-derived staging.
          //
          // `findOrCreateConversation` repairs the link instead, and is shared
          // with `sendMessage`, which had the identical bug and fixed it
          // first. See that helper for why it keys on `Conversation.requestId`
          // rather than on the request row's own column.
          if (input.message) {
            const conversation = await findOrCreateConversation(
              tx,
              reopened.id,
            );

            await tx.message.create({
              data: {
                conversationId: conversation.id,
                content: input.message,
                userId,
              },
            });

            // `reopened` was read before the link could have been repaired, so
            // returning it unchanged would report `null` for a conversation
            // that now exists. The create branch below is careful about the
            // same thing, for the same reason.
            return { ...reopened, conversationId: conversation.id };
          }

          return reopened;
        }

        // A request, its conversation, the link between them and the first
        // message are one unit. These used to be four independent awaits,
        // which could leave a request with no conversation, or a conversation
        // never linked back to its request — and `relationMode = "prisma"`
        // rejects neither, so the half-built thread persisted.
        //
        // The link is stored twice, in both directions:
        // `Conversation.requestId` and `Request.conversationId`. Nothing in the
        // schema keeps those two in agreement, which is why writing a
        // conversation still takes two statements rather than one nested
        // create.
        //
        // What this protects on the read side: `user.requests.me` above
        // includes `conversation.messages` through the request, so a thread
        // that exists on one side of the link only is invisible from the other.
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

      // Returned so the caller has an id to announce. This used to
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
      // There used to be no check at all, so any signed-in user could
      // delete strangers' pending requests out of their Requests tab.
      if (invitation.fromUserId !== userId && invitation.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this request.",
        });
      }

      // The conversation goes with the request, in one transaction.
      //
      // The cascade in the schema points the other way: `Request` holds the
      // foreign key, so `onDelete: Cascade` runs Conversation → Request. There
      // was nothing running Request → Conversation, so every decline,
      // withdrawal and "Leave Conversation" left a `conversation` row and all
      // its `message` rows behind, with `Conversation.requestId` dangling at a
      // row that no longer existed. 620 of them in production, holding 1,258
      // real messages between them.
      //
      // Deleting rather than preserving, decided on SCRUM-295: the thread is
      // already unreachable the instant the request row goes.
      // `getConversationMessages` looks the request up first and throws
      // NOT_FOUND without it, and the unread count joins through
      // `conversation.request.some(...)`, which matches nothing. So nothing
      // retrievable is lost — what is lost is private message content with no
      // route to it, no deletion path, and a permanent upward drift in the
      // admin dashboard's conversation count.
      //
      // This is *not* in tension with the reopen branch above keeping "the
      // thread they already had". That branch acts on an ACCEPTED request row
      // that still exists; this one has just removed the row, so there is
      // nothing left to reopen and no history a later request could inherit.
      //
      // Fixed here rather than by correcting the relation direction in
      // `schema.prisma`: that is a PlanetScale deploy request for an invariant
      // two statements enforce, and `relationMode = "prisma"` means MySQL would
      // not hold it either way.
      await ctx.prisma.$transaction(async (tx) => {
        // Request first. The other order would trip the declared
        // Conversation → Request cascade, which deletes the request as a side
        // effect and makes this `delete` throw NOT_FOUND.
        await tx.request.delete({ where: { id: input.invitationId } });

        // Resolved rather than filtered in place, so the messages can be
        // deleted by id. Most requests have no conversation at all — 462 of
        // 477 on staging predate the `Conversation` model — which is why this
        // is a `findMany` and a `deleteMany` rather than a `delete` that would
        // throw on matching nothing.
        const doomed = await tx.conversation.findMany({
          where: { OR: conversationsToDeleteWith(invitation) },
          select: { id: true },
        });

        if (doomed.length === 0) {
          return;
        }

        const ids = doomed.map((conversation) => conversation.id);

        // The messages are deleted explicitly rather than left to the
        // `onDelete: Cascade` declared on `Message.conversation`.
        //
        // Prisma does emulate that cascade under `relationMode = "prisma"`, so
        // this is belt and braces — but the failure mode if it ever did not is
        // `message` rows pointing at a conversation that no longer exists,
        // which is a worse version of the orphan this whole ticket is about.
        // No test in this repository can tell the difference: the suite runs on
        // a mock, so a test asserting the cascade only asserts that the mock
        // implements it. Two explicit statements need no such assumption.
        await tx.message.deleteMany({ where: { conversationId: { in: ids } } });
        await tx.conversation.deleteMany({ where: { id: { in: ids } } });
      });
    }),
});
