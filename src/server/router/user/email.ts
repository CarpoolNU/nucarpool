import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedRouter } from "../createRouter";
import { generateEmailParams, isDeliverableRecipient } from "../../emailParams";
import { SendTemplatedEmailCommand } from "@aws-sdk/client-ses";
import type {
  SESClient,
  SendTemplatedEmailCommandInput,
} from "@aws-sdk/client-ses";
import { RequestStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { assertNotBlocked } from "../../db/blocks";
import { claimEmailBudget } from "../../db/emailBudget";

/**
 * Notification email.
 *
 * Every value these procedures send is derived on the server, never taken
 * from client input — accepting `senderName`, `senderEmail`, `receiverName`,
 * `receiverEmail` or the body directly would let any signed-in user send
 * arbitrary text to an arbitrary address from the NUCarpool SES identity:
 *
 *  - the sender is `ctx.session.user.id`, looked up for its stored name/address;
 *  - the recipient is resolved from the referenced request, never from an
 *    address in the input, and never from a bare user id;
 *  - every body comes from a stored `Message` row. None is taken from input.
 *
 * The client therefore chooses *which* of its own conversations to notify about,
 * and nothing else. Bodies are rendered by SES templates through Handlebars
 * `{{ }}`, which HTML-escapes, so no additional escaping is applied here.
 *
 * **All three emails are one-shot.**
 * The write that creates the thing being announced also marks an email as
 * owed: `Request.notificationPendingSince`, `Message.notificationPending`, or
 * `Request.acceptanceNotificationPendingSince`. The procedure clears that
 * marker in one conditional `UPDATE` before it sends. Only one caller's
 * update can match, so calling the procedure again, or twice at once, sends
 * nothing more. Each email costs one real write by the caller.
 *
 * **All three also claim from one per-sender budget**, `claimEmailBudget`.
 * A marker stops one thing being announced twice; it says nothing about how
 * many things a caller can manufacture. A count of the caller's recent
 * `Request` rows would not bound that on its own: `requests.delete`
 * hard-deletes the row the count is taken over, so a create -> notify ->
 * delete loop could run past it indefinitely. The budget counts sends
 * instead, in a table no procedure a caller can reach writes to. See
 * `src/server/db/emailBudget.ts` for the whole argument and for why the claim
 * is shaped the way it is.
 *
 * Each procedure claims *after* its own cheap refusals and *before* it clears
 * a marker, and refunds on every path that then declines to send. So a replay
 * costs nothing, a staging-refused recipient costs nothing and an SES failure
 * costs nothing: the budget tracks mail that actually went out.
 *
 * **Two senders in the app are deliberately exempt from all of this**, and
 * both mail staff rather than students:
 *
 *  - the immediate alert that a `SAFETY_CONCERN` report was filed, in
 *    `src/server/adminReportAlert.ts`;
 *  - the weekly digest of every other report, in
 *    `src/server/reportDigestSend.ts`.
 *
 * Neither is a procedure here and neither claims a budget. For the alert, the
 * budget is keyed to the sender and claiming it against the reporter would let
 * a reporter who had already sent request and message notifications that hour
 * **silence their own safety alert**. A reserved key of its own was rejected
 * for a related reason — a global per-window cap is spendable by other
 * people's reports — and the bound is instead the report write itself, which
 * `reports.ts` rate-limits per reporter. The digest has no sender to charge at
 * all, and sends once a week.
 *
 * What makes both safe without a cap is that the recipients are **staff
 * resolved from `Permission`**, so unlike these three procedures neither path
 * can be aimed at a chosen person. The full argument is in
 * `adminReportAlert.ts`'s header. **A fourth email added to this router is not
 * covered by that reasoning** and claims from the budget like the rest.
 */

/** Per-sender, per-conversation cooldown for message notifications. */
const MESSAGE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

type Party = { id: string; name: string; email: string };

/**
 * Staging may only send to gmail.com. Addresses are resolved from the
 * database rather than supplied by the client, so this rule is applied to the
 * resolved recipient.
 *
 * The rule itself is `isDeliverableRecipient` in `emailParams.ts`, shared with
 * the admin report alert, which has to filter rather than throw. Only the
 * refusal is this procedure's own.
 */
const assertDeliverable = (email: string) => {
  if (!isDeliverableRecipient(email)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Only gmail.com email addresses are accepted in the staging environment",
    });
  }
};

const requireSessionUserId = (userId: string | undefined): string => {
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User not authenticated",
    });
  }
  return userId;
};

/** A user is only a usable email party if we hold an address for them. */
const toParty = (user: {
  id: string;
  preferredName: string;
  name: string | null;
  email: string | null;
}): Party | null =>
  user.email
    ? {
        id: user.id,
        name: user.preferredName || user.name || "",
        email: user.email,
      }
    : null;

const loadParty = async (
  prisma: PrismaClient,
  userId: string,
): Promise<Party | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, preferredName: true, name: true, email: true },
  });
  return user ? toParty(user) : null;
};

/** `true` when the user's carpool search says they drive. */
const isDriver = async (prisma: PrismaClient, userId: string) => {
  const search = await prisma.carpoolSearch.findFirst({
    where: { userId },
    select: { role: true },
  });
  return search?.role === "DRIVER";
};

/**
 * Resolves the two ends of a notification about an existing request, refusing
 * any caller who is not a party to it. This is the check that makes an
 * arbitrary recipient impossible: the address is read from the counterpart on
 * the request row, so a caller can only ever mail someone they are already in a
 * request with.
 */
const resolveRequestParties = async (
  prisma: PrismaClient,
  requestId: string,
  callerId: string,
) => {
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      conversationId: true,
      notificationPendingSince: true,
      acceptanceNotificationPendingSince: true,
      status: true,
    },
  });

  if (!request) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No request with id '${requestId}'`,
    });
  }

  if (request.fromUserId !== callerId && request.toUserId !== callerId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a participant in this request.",
    });
  }

  const otherUserId =
    request.fromUserId === callerId ? request.toUserId : request.fromUserId;

  // No mail between a blocked pair, in either direction. Here rather than in
  // each procedure because all three resolve their parties
  // through this, so a fourth added later cannot forget it. Thrown rather
  // than returned as `sent: false`: the request, message or acceptance it
  // would announce has already been refused, so reaching this is a direct
  // call, not a flow the client needs to degrade gracefully from.
  await assertNotBlocked(prisma, callerId, otherUserId);

  const [sender, recipient] = await Promise.all([
    loadParty(prisma, callerId),
    loadParty(prisma, otherUserId),
  ]);

  return { request, sender, recipient };
};

/**
 * The claims: each clears a one-shot marker and reports whether *this* call
 * was the one that cleared it.
 *
 * Raw SQL on purpose. `updateMany` looks like the same statement and is not
 * one here: with `relationMode = "prisma"` it reads the matching ids first and
 * then updates by id, so concurrent calls all read the row before any of them
 * clears it, and every one reports `count: 1`. `notifications.db.test.ts`
 * caught exactly that, with five concurrent calls sending five emails. A single
 * `UPDATE … WHERE` is atomic in InnoDB. The second statement waits on the
 * first one's row lock, re-reads the row, and changes nothing, and the return
 * value is the number of rows it changed.
 *
 * The request claim tests `IS NOT NULL`, not the value read earlier. A reopen
 * can only replace the value after an accept, and an accept cannot land
 * between the read and the claim of a single call in any real flow.
 */
const claimRequestNotification = async (
  prisma: PrismaClient,
  requestId: string,
) =>
  (await prisma.$executeRaw`
    UPDATE \`request\` SET \`notificationPendingSince\` = NULL
    WHERE \`id\` = ${requestId} AND \`notificationPendingSince\` IS NOT NULL
  `) === 1;

const claimMessageNotification = async (
  prisma: PrismaClient,
  messageId: string,
) =>
  (await prisma.$executeRaw`
    UPDATE \`message\` SET \`notificationPending\` = false
    WHERE \`id\` = ${messageId} AND \`notificationPending\` = true
  `) === 1;

const claimAcceptanceNotification = async (
  prisma: PrismaClient,
  requestId: string,
) =>
  (await prisma.$executeRaw`
    UPDATE \`request\` SET \`acceptanceNotificationPendingSince\` = NULL
    WHERE \`id\` = ${requestId} AND \`acceptanceNotificationPendingSince\` IS NOT NULL
  `) === 1;

/**
 * Sends an email whose one-shot marker the caller has already cleared.
 *
 * If SES refuses, `release` puts the marker back and the error is rethrown.
 * Otherwise a failed send would still use up the one email, and the recipient
 * would never be told. Putting it back cannot cause an extra email, because no
 * email went out.
 *
 * `release` owes two things, in this order: restore the marker, then
 * `budget.refund()`. The marker first, so a failed refund write still leaves
 * the email owed. All three callers do both: doing only the first would leave
 * an SES failure charging a send that never went out.
 */
const sendOrRelease = async (
  ses: Pick<SESClient, "send">,
  params: SendTemplatedEmailCommandInput,
  release: () => Promise<unknown>,
) => {
  try {
    await ses.send(new SendTemplatedEmailCommand(params));
  } catch (error) {
    await release().catch((releaseError: unknown) => {
      console.error("Could not re-mark a notification as owed", releaseError);
    });
    throw error;
  }
};

export const emailsRouter = router({
  /**
   * Notifies the other party that the caller has requested to carpool with
   * them.
   *
   * Takes the request being announced, not a bare user id: a `toId` naming an
   * arbitrary recipient would need only that the caller was signed in and not
   * mailing themselves, and every `PublicUser` the map and recommendations
   * return carries a user id, so any signed-in student could mail any other
   * registered user, repeatedly. Verifying the relationship through the
   * request row this way depends on the request already existing, which is
   * why `requests.create` runs before this is called.
   *
   * The body is read from the database too: the input never carries raw text,
   * because unchecked text sent in a loop would let a requester send the
   * recipient NUCarpool-branded mail containing anything, with no stored copy
   * for a report to capture. It is the message `requests.create` stored when
   * it opened the request (see `requestedAt` there) — not `Request.message`,
   * which is always `""`, and which `MessageContent` would render as a second
   * copy of the first message if it were ever filled in.
   */
  sendRequestNotification: protectedRouter
    .input(z.object({ requestId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const callerId = requireSessionUserId(ctx.session.user?.id);
      const { request, sender, recipient } = await resolveRequestParties(
        ctx.prisma,
        input.requestId,
        callerId,
      );

      // Stricter than the shared helper, which admits either party. Only the
      // person who made the request can announce it — otherwise the recipient
      // could mail the sender "someone wants to carpool with you" about the
      // sender's own request.
      if (request.fromUserId !== callerId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the requester can send this notification.",
        });
      }

      if (request.toUserId === callerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot send a carpool request to yourself.",
        });
      }

      if (!sender || !recipient) {
        return { sent: false as const, reason: "missing_email_address" };
      }

      // Null once announced, and on every request older than the column.
      const pendingSince = request.notificationPendingSince;
      if (!pendingSince) {
        return { sent: false as const, reason: "already_notified" };
      }

      assertDeliverable(recipient.email);

      // Claimed before the marker so a spent budget leaves the marker alone
      // and the email stays owed: the recipient is told late rather than never,
      // and the caller can retry in the next window. Claiming in the other
      // order would spend the marker on a send that never happened.
      const budget = await claimEmailBudget(ctx.prisma, callerId);
      if (!budget.claimed) {
        return { sent: false as const, reason: "rate_limited" };
      }

      // Of any number of concurrent calls, exactly one gets past this. See
      // `claimRequestNotification`. The loser refunds: it is a replay, and a
      // replay must not cost the caller a send it never received.
      if (!(await claimRequestNotification(ctx.prisma, request.id))) {
        await budget.refund();
        return { sent: false as const, reason: "already_notified" };
      }

      const opening = request.conversationId
        ? await ctx.prisma.message.findFirst({
            where: {
              conversationId: request.conversationId,
              userId: callerId,
              dateCreated: pendingSince,
            },
            select: { content: true },
          })
        : null;

      // Template choice follows the *recipient's* role.
      const emailParams = generateEmailParams(
        {
          senderName: sender.name,
          senderEmail: sender.email,
          receiverName: recipient.name,
          receiverEmail: recipient.email,
          recipientIsDriver: await isDriver(ctx.prisma, recipient.id),
          messagePreview: opening?.content ?? "",
        },
        "request",
        false,
      );

      await sendOrRelease(ctx.sesClient, emailParams, async () => {
        await ctx.prisma.request.updateMany({
          where: { id: request.id, notificationPendingSince: null },
          data: { notificationPendingSince: pendingSince },
        });
        await budget.refund();
      });
      return { sent: true as const };
    }),

  /**
   * Notifies the caller's counterpart about the caller's latest message in the
   * conversation attached to `requestId`. The body is read from the stored
   * `Message` row, so the client cannot supply text of its own.
   *
   * At most one email per message: `sendMessage` marks the message, and this
   * clears the mark before sending. The cooldown below counts the caller's
   * *other* recent messages, so alone it would not stop repeat calls about the
   * same message: one message followed by N calls would pass it N times,
   * because each call sees no prior message.
   *
   * The cooldown is per conversation, so it resets whenever a new one opens.
   * The shared budget below does not, which is the half of SCRUM-606 this
   * path needs.
   */
  sendMessageNotification: protectedRouter
    .input(z.object({ requestId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const callerId = requireSessionUserId(ctx.session.user?.id);
      const { request, sender, recipient } = await resolveRequestParties(
        ctx.prisma,
        input.requestId,
        callerId,
      );

      if (!sender || !recipient) {
        return { sent: false as const, reason: "missing_email_address" };
      }
      if (!request.conversationId) {
        return { sent: false as const, reason: "no_conversation" };
      }

      // The message being announced: the caller's most recent in this thread.
      const latest = await ctx.prisma.message.findFirst({
        where: { conversationId: request.conversationId, userId: callerId },
        orderBy: { dateCreated: "desc" },
        select: {
          id: true,
          content: true,
          dateCreated: true,
          notificationPending: true,
        },
      });

      if (!latest) {
        return { sent: false as const, reason: "no_message_to_notify" };
      }

      // Already announced, or never owed an email: the request's opening
      // message, and every message older than the column.
      if (!latest.notificationPending) {
        return { sent: false as const, reason: "already_notified" };
      }

      // Per-sender, per-conversation burst limit. If the caller already sent
      // another message here within the cooldown, a notification has very
      // likely just gone out, so this one is dropped. Derived from stored
      // Message rows, so it survives a page reload and cannot be bypassed by
      // calling the procedure directly — unlike the client-side check in
      // MessagePanel, which is a UX nicety rather than a control. This limits
      // how often new messages earn an email. The marker above stops one
      // message from being mailed twice.
      const recentPriorMessages = await ctx.prisma.message.count({
        where: {
          conversationId: request.conversationId,
          userId: callerId,
          id: { not: latest.id },
          dateCreated: {
            gte: new Date(
              latest.dateCreated.getTime() - MESSAGE_NOTIFICATION_COOLDOWN_MS,
            ),
          },
        },
      });

      if (recentPriorMessages > 0) {
        return { sent: false as const, reason: "rate_limited" };
      }

      assertDeliverable(recipient.email);

      // The shared per-sender cap, on top of the per-conversation cooldown
      // above. The cooldown alone can be reset by a create -> notify -> delete
      // loop: deleting a request takes its `Conversation` and every `Message`
      // with it, so the next request opens a thread with no prior message to
      // be within a cooldown of. This budget is not stored on anything the
      // caller can delete, so that loop spends it and stops.
      const budget = await claimEmailBudget(ctx.prisma, callerId);
      if (!budget.claimed) {
        return { sent: false as const, reason: "rate_limited" };
      }

      // As in `sendRequestNotification`: of any number of concurrent calls,
      // exactly one gets past this, and the losers refund.
      if (!(await claimMessageNotification(ctx.prisma, latest.id))) {
        await budget.refund();
        return { sent: false as const, reason: "already_notified" };
      }

      const emailParams = generateEmailParams(
        {
          senderName: sender.name,
          senderEmail: sender.email,
          receiverName: recipient.name,
          receiverEmail: recipient.email,
          messageText: latest.content,
        },
        "message",
        false,
      );

      await sendOrRelease(ctx.sesClient, emailParams, async () => {
        await ctx.prisma.message.updateMany({
          where: { id: latest.id },
          data: { notificationPending: true },
        });
        await budget.refund();
      });
      return { sent: true as const };
    }),

  /**
   * Notifies the requester that the caller accepted their carpool request.
   *
   * Two checks narrower than the shared helper's "is a participant", because
   * this procedure asserts something specific about who did what:
   *
   *  - the caller must be `toUserId`. Only the person a request was addressed
   *    to can accept it — the invariant `requireAcceptableRequest` enforces in
   *    `groups.ts`, and the same direction rule `sendRequestNotification`
   *    applies above. The helper admits either party and the template is
   *    addressed to whichever party did *not* call, so without this a
   *    request's sender could produce a coherent-looking but entirely
   *    fabricated notice.
   *  - the request must actually be `ACCEPTED`. Without checking
   *    `Request.status`, a `PENDING` request would satisfy the procedure
   *    exactly as an accepted one does: the sender of a request could make the
   *    platform email their target "<sender> accepted your request" about
   *    something nobody had accepted, repeatedly and from our verified SES
   *    identity.
   *
   * The refusals are worded separately on purpose, following
   * `requireAcceptableRequest`: "you did not accept this" and "this was not
   * accepted" call for different things from the caller, and collapsing them
   * would leave both unclear.
   *
   * **One-shot, like the request and message emails above.**
   * `markRequestAccepted` in `groups.ts` sets
   * `Request.acceptanceNotificationPendingSince` in the same statement that
   * flips `status` to `ACCEPTED`, and this procedure clears it in one
   * conditional `UPDATE` before sending. Only one caller's update can match,
   * so calling this in a loop sends at most one email per acceptance.
   *
   * **A per-user cap applies here too.** `claimEmailBudget` keeps the shared
   * state in one small database table, so a caller earning many separate
   * accepted requests and notifying each exactly once is bounded by the same
   * budget as the other two emails. See SCRUM-606.
   */
  sendAcceptanceNotification: protectedRouter
    .input(z.object({ requestId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const callerId = requireSessionUserId(ctx.session.user?.id);
      const { request, sender, recipient } = await resolveRequestParties(
        ctx.prisma,
        input.requestId,
        callerId,
      );

      if (request.toUserId !== callerId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the person a request was sent to can accept it.",
        });
      }

      if (request.status !== RequestStatus.ACCEPTED) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That carpool request has not been accepted.",
        });
      }

      if (!sender || !recipient) {
        return { sent: false as const, reason: "missing_email_address" };
      }

      // Null once announced, and on every request accepted before the column
      // existed.
      const pendingSince = request.acceptanceNotificationPendingSince;
      if (!pendingSince) {
        return { sent: false as const, reason: "already_notified" };
      }

      assertDeliverable(recipient.email);

      // The same shared cap the other two claim from. An acceptance is earned
      // rather than self-served — the other party has to have requested — so
      // this path is the hardest of the three to abuse, but it draws on one
      // budget with the others so that the total a single account can emit is
      // bounded whatever mixture it sends.
      const budget = await claimEmailBudget(ctx.prisma, callerId);
      if (!budget.claimed) {
        return { sent: false as const, reason: "rate_limited" };
      }

      // Of any number of concurrent calls, exactly one gets past this. See
      // `claimAcceptanceNotification`. The losers refund.
      if (!(await claimAcceptanceNotification(ctx.prisma, request.id))) {
        await budget.refund();
        return { sent: false as const, reason: "already_notified" };
      }

      // The *recipient's* role, same as the request flow above. Both
      // acceptance templates are worded for the recipient, and the two roles
      // in a pair are complementary, so supplying the sender's role would
      // always select the opposite template: a driver accepting a rider's
      // request would tell the rider "…accepted your request for them to join
      // your group", which describes the driver's side, not the rider's.
      const emailParams = generateEmailParams(
        {
          senderName: sender.name,
          senderEmail: sender.email,
          receiverName: recipient.name,
          receiverEmail: recipient.email,
          recipientIsDriver: await isDriver(ctx.prisma, recipient.id),
        },
        "acceptance",
        true,
      );

      await sendOrRelease(ctx.sesClient, emailParams, async () => {
        await ctx.prisma.request.updateMany({
          where: { id: request.id, acceptanceNotificationPendingSince: null },
          data: { acceptanceNotificationPendingSince: pendingSince },
        });
        await budget.refund();
      });
      return { sent: true as const };
    }),
});
