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
 * SES renders the `HtmlPart` of a stored template with Handlebars, and the
 * three values below — a recipient's preferred name, the other party's name,
 * and the body of a request or chat message — are all user-controlled and all
 * land inside HTML tags:
 *
 *   <p>Hello {{preferredName}},</p>
 *   <p>{{OtherUser}} sent you a message in Carpool NU:</p>
 *   <p><strong>{{message}}</strong></p>
 *
 * In stock Handlebars a double-brace placeholder HTML-escapes and only a
 * triple brace does not, so `{{message}}` would be safe. **SES does not follow
 * that rule.** The AWS SES developer guide states it outright:
 *
 *   "SES doesn't escape HTML content when rendering the HTML template for a
 *    message. This means if you're including user inputted data, such as from
 *    a contact form, you will need to escape it on the client side."
 *
 *   https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html
 *
 * So escaping is ours to do, and `generateEmailParams` is the one place to do
 * it: every send goes through it, and no other code builds `TemplateData`.
 *
 * Only `&`, `<` and `>` are escaped, not quotes. Every placeholder in
 * `scripts/emailtemplate.py` sits in element text content, never in an
 * attribute value, and quotes carry no meaning there. Escaping them instead
 * costs real text: one `TemplateData` blob feeds both the `HtmlPart` and the
 * `TextPart`, so anything escaped here shows up literally in the plain-text
 * alternative, and apostrophes are far too common in ordinary messages to
 * mangle. `&`, `<` and `>` are rare enough for that to be an acceptable
 * trade, and the plain-text part has no injection semantics to protect.
 *
 * **If a placeholder is ever moved into an attribute** — `href="{{...}}"`, say
 * — this is no longer sufficient and the quote characters have to come with
 * it. See SCRUM-360 for splitting the HTML and text variables, which is what
 * would let this escape aggressively without damaging the `TextPart`.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
        preferredName: escapeHtmlText(requestSchema.receiverName),
        OtherUser: escapeHtmlText(requestSchema.senderName),
        message: escapeHtmlText(requestSchema.messagePreview),
      };
      break;
    case "message":
      const messageSchema = schema as MessageEmailSchema;
      templateName = "MessageNotificationTemplate";
      templateData = {
        preferredName: escapeHtmlText(messageSchema.receiverName),
        OtherUser: escapeHtmlText(messageSchema.senderName),
        message: escapeHtmlText(messageSchema.messageText),
      };
      break;
    case "acceptance":
      const acceptanceSchema = schema as AcceptanceEmailSchema;
      templateName = acceptanceSchema.recipientIsDriver
        ? "DriverAcceptanceTemplate"
        : "RiderAcceptanceTemplate";
      templateData = {
        preferredName: escapeHtmlText(acceptanceSchema.receiverName),
        OtherUser: escapeHtmlText(acceptanceSchema.senderName),
      };
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
