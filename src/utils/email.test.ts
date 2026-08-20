import { generateEmailParams } from "./email";
import type {
  AcceptanceEmailSchema,
  MessageEmailSchema,
  RequestEmailSchema,
} from "./email";

/**
 * `generateEmailParams` picks the SES template and decides who is copied. Getting
 * either wrong means a real email with the wrong wording, or one that discloses a
 * recipient's address to the sender.
 */

const base = {
  senderName: "Ada",
  senderEmail: "ada@northeastern.edu",
  receiverName: "Grace",
  receiverEmail: "grace@northeastern.edu",
};

const requestSchema = (isDriver: boolean): RequestEmailSchema => ({
  ...base,
  isDriver,
  messagePreview: "Would you like to carpool?",
});

const messageSchema = (): MessageEmailSchema => ({
  ...base,
  messageText: "See you at 8:45",
});

const acceptanceSchema = (isDriver: boolean): AcceptanceEmailSchema => ({
  ...base,
  isDriver,
});

const templateData = (params: { TemplateData?: string }) =>
  JSON.parse(params.TemplateData ?? "{}");

describe("generateEmailParams", () => {
  it.each([
    {
      type: "request" as const,
      isDriver: true,
      template: "DriverRequestTemplate",
    },
    {
      type: "request" as const,
      isDriver: false,
      template: "RiderRequestTemplate",
    },
    {
      type: "acceptance" as const,
      isDriver: true,
      template: "DriverAcceptanceTemplate",
    },
    {
      type: "acceptance" as const,
      isDriver: false,
      template: "RiderAcceptanceTemplate",
    },
  ])(
    "selects $template for a $type when isDriver=$isDriver",
    ({ type, isDriver, template }) => {
      const schema =
        type === "request"
          ? requestSchema(isDriver)
          : acceptanceSchema(isDriver);

      expect(generateEmailParams(schema, type, false).Template).toBe(template);
    },
  );

  it("uses the single message template regardless of role", () => {
    expect(
      generateEmailParams(messageSchema(), "message", false).Template,
    ).toBe("MessageNotificationTemplate");
  });

  it("addresses the recipient by their preferred name and names the other user", () => {
    const params = generateEmailParams(requestSchema(true), "request", false);

    expect(templateData(params)).toEqual({
      preferredName: "Grace",
      OtherUser: "Ada",
      message: "Would you like to carpool?",
    });
  });

  it("carries the message body through for a message notification", () => {
    const params = generateEmailParams(messageSchema(), "message", false);

    expect(templateData(params).message).toBe("See you at 8:45");
  });

  it("sends no message body for an acceptance, which has none", () => {
    const params = generateEmailParams(
      acceptanceSchema(false),
      "acceptance",
      false,
    );

    expect(templateData(params)).toEqual({
      preferredName: "Grace",
      OtherUser: "Ada",
    });
  });

  it("sends only to the receiver when CC is not requested", () => {
    const params = generateEmailParams(requestSchema(true), "request", false);

    expect(params.Destination).toEqual({
      ToAddresses: ["grace@northeastern.edu"],
    });
    expect(params.Destination).not.toHaveProperty("CcAddresses");
  });

  it("copies the sender only when CC is requested", () => {
    const params = generateEmailParams(requestSchema(true), "request", true);

    expect(params.Destination).toEqual({
      ToAddresses: ["grace@northeastern.edu"],
      CcAddresses: ["ada@northeastern.edu"],
    });
  });

  it("always sends from the no-reply address", () => {
    expect(generateEmailParams(messageSchema(), "message", true).Source).toBe(
      "no-reply@carpoolnu.com",
    );
  });

  it("serialises TemplateData as JSON, which is what SES expects", () => {
    const params = generateEmailParams(messageSchema(), "message", false);

    expect(typeof params.TemplateData).toBe("string");
    expect(() => JSON.parse(params.TemplateData!)).not.toThrow();
  });

  it("rejects an email type outside the supported set", () => {
    expect(() =>
      generateEmailParams(
        messageSchema(),
        "reminder" as unknown as "message",
        false,
      ),
    ).toThrow("Invalid email type");
  });
});
