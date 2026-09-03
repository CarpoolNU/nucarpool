import { SendTemplatedEmailCommandInput } from "@aws-sdk/client-ses";

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
 * recorded in `scripts/README.md`. See SCRUM-360.
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
