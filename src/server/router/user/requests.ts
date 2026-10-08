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
import { assertNotBlocked, blockedCounterpartIds } from "../../db/blocks";

/**
 * Why `delete` refuses a pair who are currently carpooling together.
 *
 * Named because the refusal is raised from two places that must not drift: the
 * ordinary guard, which reads the request and the two `carpoolSearch` rows
 * before the transaction, and the count check on the conditional `DELETE`
 * inside it, which is the same question asked again atomically for the pair
 * whose group formed in between. Two spellings of one refusal would read to a
 * caller as two different problems.
 */
const CARPOOLING_PAIR_DELETE_MESSAGE =
  "You are carpooling with this user, so this conversation cannot be " +
  "deleted. Leave the carpool from the Group page first.";

/**
 * The message columns a conversation is actually read through.
 *
 * Attaching the author's whole `User` row to every message (`email`, `bio`,
 * `permission`, and `image`, a `@db.MediumText`) would go unread. Five fields
 * are all any consumer touches - `id`, `content`, `userId`, `isRead` and
 * `dateCreated`, between `latestMessage.ts`, `MessageContent` and
 * `MessagePanel` - and the author is always one of the two people already
 * present in the payload, so a 200-message thread would carry the same two
 * user rows 200 times for nothing.
 *
 * The live path already proves the join would be redundant. `messages.sendMessage`
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
 * **Bounded to one message**, because the open thread loads from
 * `user.messages.conversation` instead, which is paginated and
 * participant-scoped. With the thread served separately, this can return what
 * the card list actually needs: the newest message per conversation, for the
 * preview text and the unread dot.
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
   * **Message history is bounded to one row per conversation.** The Requests
   * tab, which renders this, only wants the newest message per card
   * (`getLatestMessageForRequest`); the open thread, which needs the whole
   * history, reads `user.messages.conversation` instead, which is paginated
   * and authorizes against the request row. With the two consumers served
   * separately, this one can return just the single row the cards use, which
   * is what `take: 1` above does.
   *
   * The narrow projection above (dropping a whole `User` row per message) is
   * the larger cost saving by far; bounding to one row removes what would
   * otherwise still be linear growth. `scripts/measure-requests-payload.ts`
   * measures both.
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
      where: { userId: { in: sentUserIds } },
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
      where: { userId: { in: receivedUserIds } },
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
    // The counterpart's disclosure has to be earned: using the exact-home
    // converter unconditionally for the counterpart would release the other
    // person's precise home coordinate and Northeastern address the moment the
    // caller created a request. `requests.create` takes a bare `toId` and asks
    // nobody, so that would make the whole matchable user base readable by
    // anyone willing to send one request per id out of
    // `mapbox.geoJsonUserList`. `convertRequestCounterpart` owns the rule and
    // says why `ACCEPTED` is the line.
    //
    // Every request either party has is still returned here — only the
    // disclosure is narrowed, not the visibility of the request list itself.
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
    // A role-mismatch filter here — dropping a request whose counterpart's role
    // matches the caller's, or is VIEWER — belongs only in recommendations, not
    // here. Applied to existing requests it would disagree with `create`'s
    // duplicate guard below, which has no role condition: as soon as either
    // party changed role, the request would disappear from the Requests tab
    // while still answering every retry with
    // `CONFLICT - Existing request between ...`. Nothing else surfaces the
    // request id, and `delete` needs one, so there would be no way to withdraw
    // it and no way out but for the other person to switch back.
    //
    // Roles change legitimately between co-op cycles, so a pair who can no
    // longer carpool is an ordinary state. `roleMismatchExplanation` is what
    // the UI shows on those requests, and accepting one is refused by
    // `groups.create`/`groups.edit` rather than by hiding it here.
    //
    // Nor is it about status. A `status: { not: "INACTIVE" }` filter on the two
    // queries above would reproduce the identical dead end one filter away:
    // pausing a search is something any user can do from their own profile at
    // any time, and the moment either party did, the request would vanish from
    // both Requests tabs while `create`'s duplicate guard — which reads only
    // `Request.status` — goes on refusing every retry with `CONFLICT`. Neither
    // party could withdraw it, decline it or replace it until the other
    // reactivated.
    //
    // `requestUnavailableExplanation` is what the card shows on those
    // requests, and `validateRequestAcceptance` plus the status checks in
    // `groups.create`/`groups.edit` are what stop one being accepted — the
    // same division of labour settled on for roles.
    //
    // What the null check covers now is a genuine absence: a counterpart with
    // no `CarpoolSearch` at all, who never finished onboarding. There is no
    // `PublicUser` to build a card from, and no hidden row behind it.
    //
    // A request with someone the caller has a block with, in either direction,
    // is hidden as well. Hidden, not deleted: the row, its
    // conversation and its messages all survive, so unblocking brings the
    // card back as it was.
    const blockedIds = new Set(await blockedCounterpartIds(ctx.prisma, userId));

    return {
      sent: sent.filter(
        (req) => req.toUser !== null && !blockedIds.has(req.toUserId),
      ),
      received: received.filter(
        (req) => req.fromUser !== null && !blockedIds.has(req.fromUserId),
      ),
    };
  }),

  create: protectedRouter
    .input(
      z
        .object({
          // The sender is deliberately absent from this input: a
          // client-supplied `fromId` becoming the request's `fromUser` would
          // let any signed-in caller send a request that appears to come from
          // someone else. The sender comes from the session and cannot be
          // influenced by the client; `.strict()` makes a re-added `fromId` a
          // BAD_REQUEST rather than a silently ignored field.
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
      // the only place that can know it: `email` is deliberately absent from
      // the payloads the client builds this call from, because including it
      // there would ship every active user's address to every signed-in
      // viewer. Holding this check only in ConnectModal would let a caller
      // reaching the procedure directly skip it entirely.
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

      // The lookup and whichever branch it selects commit together: reading
      // outside the transaction and opening one only inside the branch chosen
      // would mean the decision is taken against a snapshot that can go stale
      // before it is acted on. Two double-clicked Send calls could both find no
      // row, both take the create branch, and leave the pair with two Request
      // rows, two Conversations, two first Messages and two notification
      // emails. Withdrawing would then delete one row by id and leave the
      // other, so the next attempt is refused with CONFLICT for a request
      // neither party can see — a dead end reachable by an ordinary
      // double-click.
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
        // Before anything else in here, so a refused request writes nothing.
        // Read inside the transaction rather than before it, for the same
        // narrowing of the race the lookup below gets. A hidden request
        // between a blocked pair is the reason this cannot be left to the
        // duplicate guard: it would answer CONFLICT, or reopen the row.
        await assertNotBlocked(tx, userId, input.toId);

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

        // Still awaiting an answer, in either direction.
        if (existingRequest?.status === RequestStatus.PENDING) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Existing request between '${input.toId} and ${userId}'`,
          });
        }

        // Both branches below write this to two places: the request's
        // `notificationPendingSince`, which marks the email as owed, and the
        // opening message's `dateCreated`. That shared value is how
        // `sendRequestNotification` finds the text to quote. It looks up the
        // requester's message with exactly this timestamp, so it quotes what
        // was stored and never what the client sends. A reopen with no text
        // writes no message, so its email quotes nothing.
        const requestedAt = new Date();

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
        //
        // The request is owed an email again, tracked via
        // `notificationPendingSince` rather than `dateCreated`. Reading recency
        // off `dateCreated`, which this update leaves alone, would make a
        // reopened request never read as "recent" and its email would be
        // silently skipped. `dateCreated` stays the date of first contact on
        // purpose: the admin request series and every sort by it read it that
        // way.
        if (existingRequest) {
          const reopened = await tx.request.update({
            where: { id: existingRequest.id },
            data: {
              status: RequestStatus.PENDING,
              fromUserId: userId,
              toUserId: input.toId,
              notificationPendingSince: requestedAt,
            },
          });

          // Two separate decisions, for two unrelated reasons.
          //
          // *Whether* to write a message is the empty-message question. An
          // empty message is a real flow — ConnectModal's Send button never
          // required text — and on a reopened request an empty row would just
          // be noise in a thread that already has history. On a first request
          // it is still written, because the conversation needs a first
          // message.
          //
          // *Where* to write it is a different question, and it must not also
          // gate on `reopened.conversationId`: a request with no conversation
          // would then have the user's text silently dropped while the
          // mutation still resolves. The client would raise its success toast
          // and `sendRequestNotification` would email the recipient a preview
          // of a message that was never stored — so the recipient opens an
          // empty thread holding an email that quoted it. This is not a
          // defensive check against an impossible state: every request
          // predating migration `20240910182030_conversationmodel` has a null
          // link, 462 of 477 rows on production-derived staging.
          //
          // `findOrCreateConversation` repairs the link instead, and is shared
          // with `sendMessage`. See that helper for why it keys on
          // `Conversation.requestId` rather than on the request row's own
          // column.
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
                dateCreated: requestedAt,
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
        // message are one unit: four independent awaits here could leave a
        // request with no conversation, or a conversation never linked back to
        // its request — and `relationMode = "prisma"` rejects neither, so a
        // half-built thread would persist.
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
            notificationPendingSince: requestedAt,
            fromUser: {
              connect: { id: userId },
            },
            toUser: {
              connect: { id: input.toId },
            },
          },
        });

        // The conversation and its first message go in together, with no
        // lookup first: the request was created a statement ago with a fresh
        // cuid, so nothing could reference it yet, and a
        // `conversation.findUnique({ where: { requestId } })` here could only
        // ever return null.
        const conversation = await tx.conversation.create({
          data: {
            requestId: created.id,
            messages: {
              create: {
                content: input.message,
                userId: userId,
                dateCreated: requestedAt,
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

      // Returned so the caller has an id to announce, rather than needing to
      // notify by `toId` alone.
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
      // Without this check, any signed-in user could delete strangers'
      // pending requests out of their Requests tab.
      if (invitation.fromUserId !== userId && invitation.toUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a participant in this request.",
        });
      }

      // A blocked pair may not delete their thread either. `requests.me`
      // already hides this row for both parties the moment a block exists,
      // so refusing the delete strands nobody's
      // exit - the "exits stay open" case `blocks.ts` documents is a pair who
      // can still see their conversation, and this one already cannot. What
      // it does protect is the report that hasn't been filed yet: without
      // this, the blocked party could hard-delete the conversation - and
      // every message in it - before the blocker gets to `reports.create`,
      // which then fails with "This conversation no longer exists" and the
      // report captures no snapshot at all.
      await assertNotBlocked(ctx.prisma, invitation.fromUserId, [
        invitation.toUserId,
      ]);

      // Two people who are currently carpooling together may not delete the
      // request that carries their conversation.
      //
      // This is the mirror of the guard `create` holds a few hundred lines
      // above - the same question, asked on the way out instead of the way in.
      // `create` refuses a request between current group members with
      // CONFLICT; without this guard here, a pair in an active carpool could
      // destroy their entire thread — and since this deletes the conversation
      // and its messages rather than orphaning them, that destruction would be
      // permanent.
      //
      // **The UI already fixes this, and that fix is not this
      // one.** It answers the product question - the "Leave Conversation"
      // button was wrong, so it was removed - and `messageHeaderControls`
      // returns `{ kind: "none" }` for a pair in the same group. That guard is
      // correct and stays, but it cannot stop a direct call, a stale cached
      // bundle, or the next caller to reuse this procedure — this is the one
      // thing standing between an active carpool and irreversible loss of
      // their messages.
      //
      // The condition is **grouped, and nothing else** - not grouped and
      // ACCEPTED.
      //
      // Gating on `status === ACCEPTED` in addition to grouped would be wrong,
      // in a way worth spelling out because the mistake is easy to make again.
      // Being in the same group and having an accepted request between you are
      // not the same thing: `markRequestAccepted` resolves only the row
      // between the driver and the joining rider, so every *other* pair of
      // co-members keeps whatever request they already had. One driver and two
      // riders is enough - the two riders share a group, share a route and can
      // message each other, and a PENDING request between them from an earlier
      // co-op cycle still carries their whole conversation. A status-gated
      // guard would never even ask whether they were grouped, so either of
      // them could delete it and take every message with it, permanently.
      //
      // Gating on membership alone does **not** strand the pair who have
      // parted. The test the guard applies is "are these two in the same group
      // *now*", so an ACCEPTED row between two people who have since left is
      // still clearable: `connectAction` reads it to decide whether Connect is
      // offered, and `create`'s reopen branch acts on it. Gating on status as
      // well would strand exactly those pairs.
      //
      // The cost is that the group lookup runs for every delete, not only the
      // accepted ones, so an ordinary PENDING decline or withdrawal - the
      // common path by a wide margin - pays for one more query. It is an
      // indexed read of at most two rows from a table this procedure's own
      // transaction touches moments later, and the thing it buys is the
      // difference between losing a conversation and not.
      //
      // **A self-request is exempt, because the comparison degenerates for
      // one.** With `fromUserId === toUserId` the guard below compares a user's
      // group against their own, so it matches whenever they are in any group
      // at all, and the CONFLICT tells them to leave a carpool they really are
      // in before they can clear a request that is not real. That is not a
      // carpool worth protecting: there is one person, and the "conversation"
      // is their own words to themselves.
      //
      // Two of these exist in production, one of them ACCEPTED and
      // its owner in a group, so the row is unclearable for them today.
      // `requests.create` has refused new self-requests for some time, so this
      // branch goes dormant once `scripts/cleanup-self-requests.ts` has run -
      // it is here so the affected user is not stranded in the meantime, and so
      // the degenerate comparison cannot resurface if one is ever created
      // again.
      if (invitation.fromUserId !== invitation.toUserId) {
        const searches = await ctx.prisma.carpoolSearch.findMany({
          where: {
            userId: { in: [invitation.fromUserId, invitation.toUserId] },
          },
          select: { userId: true, carpoolId: true },
        });

        const fromGroup = searches.find(
          (s) => s.userId === invitation.fromUserId,
        )?.carpoolId;
        const toGroup = searches.find(
          (s) => s.userId === invitation.toUserId,
        )?.carpoolId;

        // `fromGroup &&` covers null and undefined together: a user with no
        // `carpoolSearch` row at all reads as undefined here, and two people
        // who are both ungrouped are not in the same group. The equality then
        // forces `toGroup` to the same non-null value, so this cannot fire on
        // two nulls. Same shape as `create`'s `callerGroup && callerGroup ===
        // targetGroup`, on purpose.
        if (fromGroup && fromGroup === toGroup) {
          // CONFLICT rather than FORBIDDEN, matching `membershipConflict` in
          // `groups.ts`: the input is well formed and the caller is entitled
          // to ask, but the current state of the data says no. It is also in
          // `NON_RETRYABLE_CODES` in `src/utils/trpc.ts`, so the client shows
          // it instead of retrying three times and reporting the third
          // failure.
          throw new TRPCError({
            code: "CONFLICT",
            message: CARPOOLING_PAIR_DELETE_MESSAGE,
          });
        }
      }

      // The conversation goes with the request, in one transaction.
      //
      // The cascade in the schema points the other way: `Request` holds the
      // foreign key, so `onDelete: Cascade` runs Conversation → Request.
      // Nothing runs Request → Conversation, so without this, every decline,
      // withdrawal and "Leave Conversation" would leave a `conversation` row
      // and all its `message` rows behind, with `Conversation.requestId`
      // dangling at a row that no longer exists.
      //
      // Deleting rather than preserving, deliberately: the thread is already
      // unreachable the instant the request row goes.
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
      // This is handled here rather than by correcting the relation direction
      // in `schema.prisma`: that would be a PlanetScale deploy request for an
      // invariant two statements already enforce, and `relationMode = "prisma"`
      // means MySQL would not hold it either way.
      await ctx.prisma.$transaction(async (tx) => {
        // Request first. The other order would trip the declared
        // Conversation → Request cascade, which deletes the request as a side
        // effect and makes this `delete` throw NOT_FOUND.
        //
        // **The delete restates the guard above as its own WHERE, because the
        // guard alone is a snapshot read.** `invitation` and the
        // `carpoolSearch` rows behind it are both read with `ctx.prisma`,
        // outside this transaction; matching the delete on the primary key
        // alone would mean that if `groups.create` committed in the window
        // between those reads and this statement, the request backing a live
        // carpool would be deleted anyway, taking the `Conversation` and every
        // `Message` with it — precisely the state the guard exists to prevent,
        // reached by timing instead of by a direct call.
        //
        // The predicate here tracks the guard above exactly: membership alone,
        // no `status` term, because two people in one group are carpooling
        // together whatever the request between them says. A `status`
        // condition here while the guard above has none would reopen the same
        // race one status wider.
        //
        // Restating the predicate in the statement makes it a real
        // compare-and-swap, the same primitive `markRequestAccepted`,
        // `reserveSeat` and the membership claims in `groups.ts` use. Whichever
        // transaction gets there first wins and the loser is told, rather than
        // both proceeding on a view of the world that stopped being true.
        //
        // A raw `DELETE`, not `request.deleteMany`, for the reason established
        // against a real MySQL for those siblings: `deleteMany`'s WHERE is
        // evaluated against this transaction's own REPEATABLE READ snapshot,
        // so a row another transaction has already accepted still reads
        // `PENDING` to it and the condition passes anyway.
        //
        // `fromUserId` and `toUserId` are bound from the snapshot rather than
        // re-read. They are safe to pin: nothing in the codebase writes either
        // column after `create`, so a request's participants are immutable.
        // Matching on them as well as `id` costs nothing and means a row that
        // somehow did change hands is left alone instead of deleted for the
        // wrong pair.
        //
        // `fromUserId` <> `toUserId` carries the self-request exemption the
        // branch above documents: with one user on both sides the EXISTS
        // compares their group against itself and matches whenever they are in
        // any group at all.
        //
        // The `IS NOT NULL` is redundant - the join is `NULL = NULL`, which is
        // never true - and is kept so the predicate reads as "both in the same
        // real group" without the reader having to reason it out.
        const deleted = await tx.$executeRaw`
          DELETE FROM \`request\`
          WHERE \`id\` = ${input.invitationId}
            AND \`fromUserId\` = ${invitation.fromUserId}
            AND \`toUserId\` = ${invitation.toUserId}
            AND NOT (
              \`fromUserId\` <> \`toUserId\`
              AND EXISTS (
                SELECT 1
                FROM carpool_search AS sender
                JOIN carpool_search AS recipient
                  ON recipient.carpoolId = sender.carpoolId
                WHERE sender.userId = ${invitation.fromUserId}
                  AND recipient.userId = ${invitation.toUserId}
                  AND sender.carpoolId IS NOT NULL
              )
            )
        `;

        if (deleted === 0) {
          // Two different losers reach here, and they deserve different
          // answers - conflating them would tell someone who simply pressed
          // Withdraw twice that they are carpooling with a user they are not.
          //
          // A **locking** read, not `tx.request.findUnique`: a plain
          // consistent read served from this transaction's snapshot would
          // report the row still present after another transaction had
          // deleted it, turning an ordinary double-clear into a CONFLICT
          // naming a carpool that does not exist. `FOR SHARE` reads the latest
          // committed row, which is what the `DELETE` just matched against.
          //
          // It only runs on the zero-match path, so the common withdrawal
          // pays for one statement and takes no extra lock. The row is the
          // one this transaction has just tried to delete, so the lock is on
          // a `request` the statement above already touched rather than a new
          // one - but the ordering against `groups.create` under genuine
          // contention has not been measured, only the interleaving in
          // `requestDeleteRace.db.test.ts`.
          const survivors = await tx.$queryRaw<{ id: string }[]>`
            SELECT \`id\` FROM \`request\`
            WHERE \`id\` = ${input.invitationId}
            FOR SHARE
          `;

          // The row is gone: the other participant cleared the same request
          // in the window, and took its conversation and messages with it in
          // their own transaction. The caller wanted this request not to
          // exist, and it does not. Nothing left to do and nothing to report.
          if (survivors.length === 0) {
            return;
          }

          // The row survived the condition, so the pair share a group - the
          // guard above, arrived at a moment later. Same code and same
          // message, because it is the same refusal.
          //
          // Dropping status from the predicate (matching the guard above)
          // widens what reaching here means, and the widening is in the safe
          // direction: this branch also catches the PENDING-and-grouped pair,
          // which a status-gated guard would miss. What it still cannot be is
          // a plain double-clear - that row is gone, and the `FOR SHARE` read
          // above returns nothing for it.
          throw new TRPCError({
            code: "CONFLICT",
            message: CARPOOLING_PAIR_DELETE_MESSAGE,
          });
        }

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
        // which is a worse version of the orphan this guard exists to prevent.
        // No test in this repository can tell the difference: the suite runs on
        // a mock, so a test asserting the cascade only asserts that the mock
        // implements it. Two explicit statements need no such assumption.
        await tx.message.deleteMany({ where: { conversationId: { in: ids } } });
        await tx.conversation.deleteMany({ where: { id: { in: ids } } });
      });
    }),
});
