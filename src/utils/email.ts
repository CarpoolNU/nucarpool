import { SendTemplatedEmailCommandInput } from "@aws-sdk/client-ses";

/**
 * Template selection (SCRUM-268).
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
        preferredName: requestSchema.receiverName,
        OtherUser: requestSchema.senderName,
        message: requestSchema.messagePreview,
      };
      break;
    case "message":
      const messageSchema = schema as MessageEmailSchema;
      templateName = "MessageNotificationTemplate";
      templateData = {
        preferredName: messageSchema.receiverName,
        OtherUser: messageSchema.senderName,
        message: messageSchema.messageText,
      };
      break;
    case "acceptance":
      const acceptanceSchema = schema as AcceptanceEmailSchema;
      templateName = acceptanceSchema.recipientIsDriver
        ? "DriverAcceptanceTemplate"
        : "RiderAcceptanceTemplate";
      templateData = {
        preferredName: acceptanceSchema.receiverName,
        OtherUser: acceptanceSchema.senderName,
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
