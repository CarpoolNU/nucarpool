import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedRouter } from "../createRouter";
import { generateEmailParams } from "../../../utils/email";
import { SendTemplatedEmailCommand } from "@aws-sdk/client-ses";
import type { PrismaClient } from "@prisma/client";

/**
 * Notification email (SCRUM-225).
 *
 * These procedures used to take `senderName`, `senderEmail`, `receiverName`,
 * `receiverEmail` and the body straight from client input, so any signed-in
 * user could send arbitrary text to an arbitrary address from the NUCarpool SES
 * identity. Every one of those values is now derived on the server:
 *
 *  - the sender is `ctx.session.user.id`, looked up for its stored name/address;
 *  - the recipient is resolved from the referenced request, never from an
 *    address in the input, and never from a bare user id (SCRUM-270);
 *  - the body comes from the stored `Message` row where one exists.
 *
 * The client therefore chooses *which* of its own conversations to notify about,
 * and nothing else. Bodies are rendered by SES templates through Handlebars
 * `{{ }}`, which HTML-escapes, so no additional escaping is applied here.
 */

/** Per-sender, per-conversation cooldown for message notifications. */
const MESSAGE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * A request notification announces a request that was *just* created, so it
 * only fires for a fresh one (SCRUM-270).
 *
 * This is the control that matters. Without it the procedure can be called
 * over and over for one long-lived request row, mailing the same person as
 * many times as the caller likes. With it, an email costs a request creation —
 * and `user.requests.create` rejects a second request between the same pair
 * with CONFLICT, so repeating it means deleting and re-creating the request
 * each time.
 */
const REQUEST_NOTIFICATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Sender budget layered on top: at most this many request notifications per
 * hour.
 *
 * Derived from `Request.dateCreated`, which is the only durable timestamp
 * available — nothing records that a notification was sent. That makes this
 * weaker than it looks: `user.requests.delete` removes the row, so a caller
 * willing to delete and re-create can reset the count. It raises the cost of
 * abuse rather than capping it. The control that would actually cap it needs
 * shared state this deployment does not have, tracked as SCRUM-277.
 */
const REQUEST_NOTIFICATION_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_NOTIFICATIONS_PER_WINDOW = 10;

/** Longest request preview accepted; mirrors the 250-char cap in ConnectModal. */
const MAX_PREVIEW_LENGTH = 250;

type Party = { id: string; name: string; email: string };

/**
 * Staging may only send to gmail.com. This used to be a Zod refinement on the
 * client-supplied address; addresses now come from the database, so the same
 * rule is applied to the resolved recipient instead. The code and message are
 * unchanged so the behaviour a staging user sees is the same.
 */
const assertDeliverable = (email: string) => {
  if (
    process.env.NEXT_PUBLIC_ENV === "staging" &&
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
      dateCreated: true,
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

  const [sender, recipient] = await Promise.all([
    loadParty(prisma, callerId),
    loadParty(prisma, otherUserId),
  ]);

  return { request, sender, recipient };
};

export const emailsRouter = router({
  /**
   * Notifies the other party that the caller has requested to carpool with
   * them.
   *
   * Takes the request being announced, not a bare user id (SCRUM-270). It used
   * to accept `toId` and mail whoever that named, checking only that the
   * caller was signed in and was not mailing themselves — and every
   * `PublicUser` the map and recommendations return carries a user id, so any
   * signed-in student could mail any other registered user, repeatedly.
   *
   * The reason it worked that way was real at the time: the connect flow used
   * to send the mail *before* creating the request, so there was no request
   * row to reference. SCRUM-234 reordered that, and the request now exists
   * first, so this can verify the relationship the same way the other two
   * procedures do.
   */
  sendRequestNotification: protectedRouter
    .input(
      z
        .object({
          requestId: z.string(),
          messagePreview: z.string().max(MAX_PREVIEW_LENGTH),
        })
        .strict(),
    )
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

      const age = Date.now() - request.dateCreated.getTime();
      if (age > REQUEST_NOTIFICATION_MAX_AGE_MS) {
        return { sent: false as const, reason: "request_not_recent" };
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

      // Template choice follows the *recipient's* role, matching what the
      // connect modal used to send from the client.
      const emailParams = generateEmailParams(
        {
          senderName: sender.name,
          senderEmail: sender.email,
          receiverName: recipient.name,
          receiverEmail: recipient.email,
          isDriver: await isDriver(ctx.prisma, recipient.id),
          messagePreview: input.messagePreview,
        },
        "request",
        false,
      );

      await ctx.sesClient.send(new SendTemplatedEmailCommand(emailParams));
      return { sent: true as const };
    }),

  /**
   * Notifies the caller's counterpart about the caller's latest message in the
   * conversation attached to `requestId`. The body is read from the stored
   * `Message` row, so the client cannot supply text of its own.
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
        select: { id: true, content: true, dateCreated: true },
      });

      if (!latest) {
        return { sent: false as const, reason: "no_message_to_notify" };
      }

      // Per-sender, per-conversation rate limit. If the caller already sent
      // another message here within the cooldown, a notification has very
      // likely just gone out, so this one is dropped. Derived from stored
      // Message rows, so it survives a page reload and cannot be bypassed by
      // calling the procedure directly — unlike the client-side check in
      // MessagePanel, which is a UX nicety rather than a control.
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

      await ctx.sesClient.send(new SendTemplatedEmailCommand(emailParams));
      return { sent: true as const };
    }),

  /**
   * Notifies the counterpart that the caller accepted their carpool request.
   *
   * Relies on the request row still existing after acceptance, which it does
   * today only because accepting never resolves the request (SCRUM-228). If
   * that is fixed to delete the row, this lookup has to move ahead of it.
   *
   * **Deliberately not rate limited** (SCRUM-270). The limit on
   * `sendRequestNotification` above keys off `Request.dateCreated`, because a
   * request notification announces a brand new row. Acceptance has no
   * equivalent timestamp: nothing records that a request was accepted — that
   * is the same SCRUM-228 gap — so there is nothing to measure freshness
   * against, and a window keyed on `dateCreated` would refuse to announce the
   * acceptance of a request made yesterday.
   *
   * The replay vector is real: a caller can invoke this repeatedly for one
   * request. Two things would close it, neither belonging here — SCRUM-228
   * resolving the request on acceptance, which removes the row and with it the
   * window, or the shared rate-limit state in SCRUM-277.
   */
  sendAcceptanceNotification: protectedRouter
    .input(z.object({ requestId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const callerId = requireSessionUserId(ctx.session.user?.id);
      const { sender, recipient } = await resolveRequestParties(
        ctx.prisma,
        input.requestId,
        callerId,
      );

      if (!sender || !recipient) {
        return { sent: false as const, reason: "missing_email_address" };
      }

      assertDeliverable(recipient.email);

      // Deliberately the *sender's* role, preserving exactly what the client
      // used to pass. Note that the two acceptance templates are worded for the
      // recipient, so this selects the opposite one — a pre-existing content
      // bug tracked as SCRUM-268, deliberately not changed in this security fix.
      const emailParams = generateEmailParams(
        {
          senderName: sender.name,
          senderEmail: sender.email,
          receiverName: recipient.name,
          receiverEmail: recipient.email,
          isDriver: await isDriver(ctx.prisma, callerId),
        },
        "acceptance",
        true,
      );

      await ctx.sesClient.send(new SendTemplatedEmailCommand(emailParams));
      return { sent: true as const };
    }),
});
