import { SendTemplatedEmailCommandInput } from "@aws-sdk/client-ses";
import { browserEnv } from "../utils/env/browser";

/**
 * Whether staging is allowed to mail this address.
 *
 * Staging may only send to gmail.com. The rule lives here, with the other
 * send-shaped code and no router dependency, because two callers need it and
 * they need opposite things from it: `assertDeliverable` in
 * `router/user/email.ts` throws, so a staging user sees why their
 * notification was refused, while `adminReportAlert.ts` filters, because an
 * admin alert must never fail the report that caused it. One predicate, so
 * the two cannot drift into disagreeing about what staging may send.
 */
export const isDeliverableRecipient = (email: string): boolean =>
  browserEnv.NEXT_PUBLIC_ENV !== "staging" ||
  email.toLowerCase().endsWith("@gmail.com");

/**
 * Template selection.
 *
 * All four request/acceptance templates in `scripts/emailtemplate.py` are
 * written in the second person and addressed to `{{preferredName}}`, which is
 * the *recipient*. Their wording only makes sense for one role:
 *
 *   DriverRequestTemplate     "...has sent a request to join your Carpool group"
 *   DriverAcceptanceTemplate  "...accepted your request for them to join your group"
 *                             -> the recipient owns the group, so drives
 *
 *   RiderRequestTemplate      "...sent a request for you to join their Carpool group"
 *   RiderAcceptanceTemplate   "...accepted your request to join their Carpool group"
 *                             -> the recipient is joining, so rides
 *
 * So the flag that picks between them is a fact about the **recipient**, and
 * `recipientIsDriver` is named to say so. It used to be called `isDriver`, and
 * the acceptance flow supplied the *sender's* role instead. The two roles in a
 * carpool pair are complementary, so the selector was always inverted and
 * every acceptance email was worded for the other party.
 */

/**
 * Escaping of user-controlled template data.
 *
 * Three values here are user-controlled: a recipient's preferred name, the
 * other party's name, and the body of a request or chat message. SES renders
 * them into both the `HtmlPart` and the `TextPart` of a stored template, and
 * it does not escape anything on the way:
 *
 *   "SES doesn't escape HTML content when rendering the HTML template for a
 *    message. This means if you're including user inputted data, such as from
 *    a contact form, you will need to escape it on the client side."
 *
 *   https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html
 *
 * So escaping is ours, and `generateEmailParams` is the one place to do it:
 * every send goes through it and no other code builds `TemplateData`.
 *
 * The awkward part is that `SendTemplatedEmail` takes **one** `TemplateData`
 * blob for both parts. A single set of variables therefore cannot be right for
 * both — escape it and HTML entities leak into the plain-text alternative,
 * where there is nothing to protect and they are just noise; leave it raw and
 * the HTML body is injectable. So each part gets its own variables, and the
 * same source value is emitted under more than one key:
 *
 *   {{...Html}}   escaped with `escapeHtmlAttribute` — safe in element text
 *                 content *and* in an attribute value. Read by the `HtmlPart`.
 *   {{...Plain}}  raw. Read by the `TextPart`, which has no injection
 *                 semantics and should show exactly what the user typed.
 *
 * The third set is the unsuffixed `{{preferredName}}` / `{{OtherUser}}` /
 * `{{message}}`, escaped with `escapeHtmlText`. **Those are legacy, and they
 * are load-bearing until the templates are republished.** The templates live
 * in AWS, not in this repository: editing `scripts/emailtemplate.py` changes
 * nothing until someone runs it, and the templates deployed right now read the
 * unsuffixed names in their `HtmlPart`. Dropping them here — or, worse,
 * redefining them as raw — would silently un-escape live email for however
 * long that gap lasts. They cost a few bytes, they keep the change revertible
 * without a second AWS mutation, and they can be deleted once a republish is
 * recorded in `scripts/README.md`.
 */

/** Escapes for HTML element text content. Not sufficient inside an attribute. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escapes for anywhere in HTML, attribute values included.
 *
 * A superset of `escapeHtmlText`. Quotes are what an attribute value needs and
 * text content does not, and escaping them is free here precisely because the
 * `TextPart` no longer reads these variables — apostrophes are common enough
 * in ordinary messages ("I'm", "let's") that this would have been unacceptable
 * while one variable had to serve both parts.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The two names, under all three variable sets. See the note above for why the
 * same value is emitted more than once.
 */
function nameVariables(receiverName: string, senderName: string) {
  return {
    preferredName: escapeHtmlText(receiverName),
    OtherUser: escapeHtmlText(senderName),
    preferredNameHtml: escapeHtmlAttribute(receiverName),
    OtherUserHtml: escapeHtmlAttribute(senderName),
    preferredNamePlain: receiverName,
    OtherUserPlain: senderName,
  };
}

/** The message body, under all three variable sets. Acceptances have none. */
function messageVariables(message: string) {
  return {
    message: escapeHtmlText(message),
    messageHtml: escapeHtmlAttribute(message),
    messagePlain: message,
  };
}

export interface BaseEmailSchema {
  senderName: string;
  senderEmail: string;
  receiverName: string;
  receiverEmail: string;
}

export interface RequestEmailSchema extends BaseEmailSchema {
  messagePreview: string;
  /** Does the *recipient* drive? See the note at the top of this file. */
  recipientIsDriver: boolean;
}

export interface MessageEmailSchema extends BaseEmailSchema {
  messageText: string;
}

export interface AcceptanceEmailSchema extends BaseEmailSchema {
  /** Does the *recipient* drive? See the note at the top of this file. */
  recipientIsDriver: boolean;
}

/**
 * The admin alert that a report was filed. See `adminReportAlert.ts`.
 *
 * **There is deliberately no user-authored value in here at all** — no
 * reporter message, no snapshot, and not even the two users' names. The
 * reporter's `message` and the `conversationSnapshot` are unvalidated past a
 * length cap (`textLimits.ts` checks length and nothing else), and SCRUM-225
 * established that caller-supplied text must not reach an email body. The
 * alert therefore carries the *fact* of a report and its reason, and the
 * queue itself is where the content is read, behind `adminRouter`.
 *
 * `reasonLabel` is a value from `REPORT_REASON_LABELS`, keyed by a Prisma
 * enum: a string this repository wrote, not one a caller chose. It is escaped
 * anyway, under the same two keys as everything else here, because the cost
 * is a few bytes and the alternative is a file where some substitutions are
 * escaped and some are not — which is how the next one gets it wrong.
 */
export interface AdminReportEmailSchema {
  /**
   * Every admin the alert goes to, resolved from the database on the server.
   * Never input, and never an address derived from the reporter.
   */
  recipientEmails: string[];
  /** The report's reason, already turned into its on-screen label. */
  reasonLabel: string;
}

/**
 * Built here rather than as a fourth `type` on `generateEmailParams` below.
 * That function's three cases all address one recipient and share
 * `nameVariables`, and its `BaseEmailSchema` requires a sender and a
 * receiver; this alert has many recipients and no sender in that sense. The
 * useful half of the convention — one file builds every `TemplateData`, and
 * nothing else in the app constructs one — is unchanged.
 */
export function generateAdminReportEmailParams(
  schema: AdminReportEmailSchema,
): SendTemplatedEmailCommandInput {
  return {
    Source: "no-reply@carpoolnu.com",
    // All recipients are staff holding the same privilege over the same
    // queue, so a visible `To` discloses nothing between them that
    // `getAllUsers` does not already show each of them.
    Destination: { ToAddresses: schema.recipientEmails },
    Template: "AdminReportTemplate",
    TemplateData: JSON.stringify({
      reasonHtml: escapeHtmlAttribute(schema.reasonLabel),
      reasonPlain: schema.reasonLabel,
    }),
  };
}

/**
 * The weekly digest of the reports a Monday-to-Sunday week produced. See
 * `reportDigestSend.ts`.
 *
 * **Every value in here is a number this repository counted or a string it
 * wrote.** Nothing a user typed reaches it, and nothing identifies a user at
 * all — not the people reported, not the people reporting, not a count of
 * reports attached to anyone nameable. The aggregate is the message and
 * `/admin` is where a name is attached to it; `reportDigest.ts` argues why at
 * length, and `emailParams.test.ts` asserts the exact key set so that a
 * future edit cannot quietly add a seventh field holding an id.
 *
 * The two string values are escaped under the usual `Html` / `Plain` pair,
 * matching every other builder here. Neither can contain markup —
 * `windowLabel` is formatted from two `Date`s and `reasonBreakdown` from
 * `REPORT_REASON_LABELS` — and they are escaped anyway, for the reason the
 * admin alert above gives: a file where some substitutions are escaped and
 * some are not is how the next one gets it wrong.
 *
 * The counts are emitted once each rather than as pairs. A number has no
 * injection surface and renders identically in both parts, so a second key
 * would be noise that still has to be kept in step.
 */
export interface AdminReportDigestEmailSchema {
  /** Staff, resolved from `Permission` on the server. Never input. */
  recipientEmails: string[];
  /** The week covered, e.g. `29 Sep – 5 Oct 2026`. */
  windowLabel: string;
  /** Per-reason counts as one line, already formatted. */
  reasonBreakdown: string;
  reportCount: number;
  uniqueReportedUserCount: number;
  repeatedReportedUserCount: number;
  highestReportsAboutOneUser: number;
  criticalReportCount: number;
}

export function generateAdminReportDigestEmailParams(
  schema: AdminReportDigestEmailSchema,
): SendTemplatedEmailCommandInput {
  return {
    Source: "no-reply@carpoolnu.com",
    Destination: { ToAddresses: schema.recipientEmails },
    Template: "AdminReportDigestTemplate",
    TemplateData: JSON.stringify({
      windowLabelHtml: escapeHtmlAttribute(schema.windowLabel),
      windowLabelPlain: schema.windowLabel,
      reasonBreakdownHtml: escapeHtmlAttribute(schema.reasonBreakdown),
      reasonBreakdownPlain: schema.reasonBreakdown,
      reportCount: String(schema.reportCount),
      uniqueReportedUsers: String(schema.uniqueReportedUserCount),
      repeatedReportedUsers: String(schema.repeatedReportedUserCount),
      highestReportsAboutOneUser: String(schema.highestReportsAboutOneUser),
      criticalReports: String(schema.criticalReportCount),
    }),
  };
}

export function generateEmailParams(
  schema: RequestEmailSchema | MessageEmailSchema | AcceptanceEmailSchema,
  type: "request" | "message" | "acceptance",
  includeCc: boolean,
): SendTemplatedEmailCommandInput {
  let templateName: string;
  let templateData: Record<string, any>;

  switch (type) {
    case "request":
      const requestSchema = schema as RequestEmailSchema;
      templateName = requestSchema.recipientIsDriver
        ? "DriverRequestTemplate"
        : "RiderRequestTemplate";
      templateData = {
        ...nameVariables(requestSchema.receiverName, requestSchema.senderName),
        ...messageVariables(requestSchema.messagePreview),
      };
      break;
    case "message":
      const messageSchema = schema as MessageEmailSchema;
      templateName = "MessageNotificationTemplate";
      templateData = {
        ...nameVariables(messageSchema.receiverName, messageSchema.senderName),
        ...messageVariables(messageSchema.messageText),
      };
      break;
    case "acceptance":
      const acceptanceSchema = schema as AcceptanceEmailSchema;
      templateName = acceptanceSchema.recipientIsDriver
        ? "DriverAcceptanceTemplate"
        : "RiderAcceptanceTemplate";
      templateData = nameVariables(
        acceptanceSchema.receiverName,
        acceptanceSchema.senderName,
      );
      break;
    default:
      throw new Error("Invalid email type");
  }

  const destination: { ToAddresses: string[]; CcAddresses?: string[] } = {
    ToAddresses: [schema.receiverEmail],
  };

  if (includeCc) {
    destination.CcAddresses = [schema.senderEmail];
  }

  return {
    Source: "no-reply@carpoolnu.com",
    Destination: destination,
    Template: templateName,
    TemplateData: JSON.stringify(templateData),
  };
}
