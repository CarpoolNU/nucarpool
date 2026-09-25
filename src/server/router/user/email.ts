import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedRouter } from "../createRouter";
import { generateEmailParams } from "../../emailParams";
import { browserEnv } from "../../../utils/env/browser";
import { SendTemplatedEmailCommand } from "@aws-sdk/client-ses";
import type {
  SESClient,
  SendTemplatedEmailCommandInput,
} from "@aws-sdk/client-ses";
import { RequestStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { assertNotBlocked } from "../../db/blocks";

/**
 * Notification email.
 *
 * These procedures used to take `senderName`, `senderEmail`, `receiverName`,
 * `receiverEmail` and the body straight from client input, so any signed-in
 * user could send arbitrary text to an arbitrary address from the NUCarpool SES
 * identity. Every one of those values is now derived on the server:
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
 * **Request and message emails are one-shot** (SCRUM-559). The write that
 * creates the thing being announced also marks an email as owed:
 * `Request.notificationPendingSince` or `Message.notificationPending`. The
 * procedure clears that marker with a conditional `updateMany` before it sends.
 * Only one caller's update can match, so calling the procedure again, or twice
 * at once, sends nothing more. Each email costs one real write by the caller.
 * These were time windows before, and inside one the procedure sent on every
 * call.
 */

/** Per-sender, per-conversation cooldown for message notifications. */
const MESSAGE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Sender budget: at most this many request notifications per hour.
 *
 * The one-shot marker already limits a request to one email. This limits how
 * fast new requests can be made to earn one, since deleting and re-creating a
 * request marks it owed again. Counted from `Request.dateCreated`, so
 * `user.requests.delete` removes rows from the count, and a reopen, which keeps
 * the original `dateCreated`, is never in it. It raises the cost of abuse and
 * is not a cap. A reopen needs the other person to have accepted first, so it
 * is not something a caller can repeat on their own.
 */
const REQUEST_NOTIFICATION_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_NOTIFICATIONS_PER_WINDOW = 10;

type Party = { id: string; name: string; email: string };

/**
 * Staging may only send to gmail.com. This used to be a Zod refinement on the
 * client-supplied address; addresses now come from the database, so the same
 * rule is applied to the resolved recipient instead. The code and message are
 * unchanged so the behaviour a staging user sees is the same.
 */
const assertDeliverable = (email: string) => {
  if (
    browserEnv.NEXT_PUBLIC_ENV === "staging" &&
    !email.toLowerCase().endsWith("@gmail.com")
  ) {
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

  // No mail between a blocked pair, in either direction (SCRUM-554). Here
  // rather than in each procedure because all three resolve their parties
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
 * Sends an email whose one-shot marker the caller has already cleared.
 *
 * If SES refuses, `release` puts the marker back and the error is rethrown.
 * Otherwise a failed send would still use up the one email, and the recipient
 * would never be told. Putting it back cannot cause an extra email, because no
 * email went out.
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
   * Takes the request being announced, not a bare user id. It used
   * to accept `toId` and mail whoever that named, checking only that the
   * caller was signed in and was not mailing themselves — and every
   * `PublicUser` the map and recommendations return carries a user id, so any
   * signed-in student could mail any other registered user, repeatedly.
   *
   * The reason it worked that way was real at the time: the connect flow used
   * to send the mail *before* creating the request, so there was no request
   * row to reference. That was reordered, and the request now exists
   * first, so this can verify the relationship the same way the other two
   * procedures do.
   *
   * The body is read from the database too. The input used to carry a
   * `messagePreview` that went to SES unchecked. Called in a loop, that let a
   * requester send the recipient NUCarpool-branded mail containing any text,
   * and because the text was never stored, a report could not capture it. It
   * is now the message `requests.create` stored when it opened the request
   * (see `requestedAt` there). It is not `Request.message`: that column is
   * always `""`, and `MessageContent` would render it as a second copy of the
   * first message if it were ever filled in.
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

      const recentRequests = await ctx.prisma.request.count({
        where: {
          fromUserId: callerId,
          dateCreated: {
            gte: new Date(Date.now() - REQUEST_NOTIFICATION_WINDOW_MS),
          },
        },
      });

      if (recentRequests > REQUEST_NOTIFICATIONS_PER_WINDOW) {
        return { sent: false as const, reason: "rate_limited" };
      }

      assertDeliverable(recipient.email);

      // The claim. The update matches only while the marker still holds the
      // value read above, so of two concurrent calls exactly one gets
      // `count: 1`. Matching on the value, not just on non-null, also means a
      // reopen landing in between is not consumed by this call.
      const claim = await ctx.prisma.request.updateMany({
        where: { id: request.id, notificationPendingSince: pendingSince },
        data: { notificationPendingSince: null },
      });
      if (claim.count === 0) {
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

      // Template choice follows the *recipient's* role, matching what the
      // connect modal used to send from the client.
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

      await sendOrRelease(ctx.sesClient, emailParams, () =>
        ctx.prisma.request.updateMany({
          where: { id: request.id, notificationPendingSince: null },
          data: { notificationPendingSince: pendingSince },
        }),
      );
      return { sent: true as const };
    }),

  /**
   * Notifies the caller's counterpart about the caller's latest message in the
   * conversation attached to `requestId`. The body is read from the stored
   * `Message` row, so the client cannot supply text of its own.
   *
   * At most one email per message: `sendMessage` marks the message, and this
   * clears the mark before sending. The cooldown below used to be the only
   * control, and it counts the caller's *other* recent messages. So one message
   * followed by N calls passed it N times, because each call saw no prior
   * message.
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

      // The claim, as in `sendRequestNotification`: only one caller's update
      // can match.
      const claim = await ctx.prisma.message.updateMany({
        where: { id: latest.id, notificationPending: true },
        data: { notificationPending: false },
      });
      if (claim.count === 0) {
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

      await sendOrRelease(ctx.sesClient, emailParams, () =>
        ctx.prisma.message.updateMany({
          where: { id: latest.id },
          data: { notificationPending: true },
        }),
      );
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
   *  - the request must actually be `ACCEPTED`. This used to read
   *    `Request.status` not at all, so a `PENDING` request satisfied the
   *    procedure exactly as an accepted one did: the sender of a request could
   *    make the platform email their target "<sender> accepted your request"
   *    about something nobody had accepted, repeatedly and from our verified
   *    SES identity.
   *
   * The refusals are worded separately on purpose, following
   * `requireAcceptableRequest`: "you did not accept this" and "this was not
   * accepted" call for different things from the caller, and collapsing them
   * would leave both unclear.
   *
   * **Not yet one-shot.** The request and message emails above each clear a
   * marker set by the write they announce (SCRUM-559). Acceptance was left out
   * of that ticket: it is written by `markRequestAccepted` in `groups.ts`,
   * which would have to set the marker, and nothing records that an acceptance
   * was announced.
   *
   * Replay is therefore still possible, but the checks above bound it to
   * requests genuinely accepted with the caller as their recipient, which is a
   * real relationship rather than an unbounded set. That is a large reduction
   * and not a cap. Both the missing marker and the missing per-user cap
   * across `user.emails.*` are SCRUM-564.
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

      assertDeliverable(recipient.email);

      // The *recipient's* role, same as the request flow above. This used to
      // pass the caller's role, preserved from what the client sent. Both
      // acceptance templates are worded for the recipient and the two roles in
      // a pair are complementary, so supplying the sender's role always
      // selected the opposite template: a driver accepting a rider's request
      // told the rider "…accepted your request for them to join your group",
      // which describes the driver's side, not the rider's.
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

      await ctx.sesClient.send(new SendTemplatedEmailCommand(emailParams));
      return { sent: true as const };
    }),
});
