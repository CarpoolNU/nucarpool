import {
  escapeHtmlAttribute,
  escapeHtmlText,
  generateEmailParams,
} from "./emailParams";
import type {
  AcceptanceEmailSchema,
  MessageEmailSchema,
  RequestEmailSchema,
} from "./emailParams";

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

const requestSchema = (recipientIsDriver: boolean): RequestEmailSchema => ({
  ...base,
  recipientIsDriver,
  messagePreview: "Would you like to carpool?",
});

const messageSchema = (): MessageEmailSchema => ({
  ...base,
  messageText: "See you at 8:45",
});

const acceptanceSchema = (
  recipientIsDriver: boolean,
): AcceptanceEmailSchema => ({
  ...base,
  recipientIsDriver,
});

const templateData = (params: { TemplateData?: string }) =>
  JSON.parse(params.TemplateData ?? "{}");

describe("generateEmailParams", () => {
  it.each([
    {
      type: "request" as const,
      recipientIsDriver: true,
      template: "DriverRequestTemplate",
    },
    {
      type: "request" as const,
      recipientIsDriver: false,
      template: "RiderRequestTemplate",
    },
    {
      type: "acceptance" as const,
      recipientIsDriver: true,
      template: "DriverAcceptanceTemplate",
    },
    {
      type: "acceptance" as const,
      recipientIsDriver: false,
      template: "RiderAcceptanceTemplate",
    },
  ])(
    "selects $template for a $type when recipientIsDriver=$recipientIsDriver",
    ({ type, recipientIsDriver, template }) => {
      const schema =
        type === "request"
          ? requestSchema(recipientIsDriver)
          : acceptanceSchema(recipientIsDriver);

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
      preferredNameHtml: "Grace",
      OtherUserHtml: "Ada",
      messageHtml: "Would you like to carpool?",
      preferredNamePlain: "Grace",
      OtherUserPlain: "Ada",
      messagePlain: "Would you like to carpool?",
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
      preferredNameHtml: "Grace",
      OtherUserHtml: "Ada",
      preferredNamePlain: "Grace",
      OtherUserPlain: "Ada",
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

/**
 * SES does not escape substitutions in a template's `HtmlPart`, so every
 * user-controlled value has to arrive already escaped. See the comment above
 * `escapeHtmlText` for the AWS note that says so, and for why the escape set
 * stops at `&`, `<` and `>`.
 */
describe("escapeHtmlText", () => {
  it("escapes the characters that can open or close a tag", () => {
    expect(escapeHtmlText("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("escapes an ampersand first, so an entity is not double-encoded", () => {
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;");
  });

  it("leaves quotes alone, because no placeholder sits in an attribute", () => {
    expect(escapeHtmlText(`I'm "here"`)).toBe(`I'm "here"`);
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtmlText("See you at 8:45")).toBe("See you at 8:45");
  });

  it("handles the empty string", () => {
    expect(escapeHtmlText("")).toBe("");
  });
});

describe("generateEmailParams HTML escaping", () => {
  const injected = {
    senderName: '<a href="https://evil.example">Ada</a>',
    senderEmail: "ada@northeastern.edu",
    receiverName: "Grace & Co",
    receiverEmail: "grace@northeastern.edu",
  };

  it("escapes both names and the message body of a request", () => {
    const params = generateEmailParams(
      { ...injected, recipientIsDriver: true, messagePreview: "<b>x</b>" },
      "request",
      false,
    );

    expect(templateData(params)).toEqual({
      preferredName: "Grace &amp; Co",
      OtherUser: '&lt;a href="https://evil.example"&gt;Ada&lt;/a&gt;',
      message: "&lt;b&gt;x&lt;/b&gt;",
      preferredNameHtml: "Grace &amp; Co",
      OtherUserHtml:
        "&lt;a href=&quot;https://evil.example&quot;&gt;Ada&lt;/a&gt;",
      messageHtml: "&lt;b&gt;x&lt;/b&gt;",
      preferredNamePlain: "Grace & Co",
      OtherUserPlain: '<a href="https://evil.example">Ada</a>',
      messagePlain: "<b>x</b>",
    });
  });

  it("escapes the body of a message notification", () => {
    const params = generateEmailParams(
      { ...injected, messageText: "<script>alert(1)</script>" },
      "message",
      false,
    );

    expect(templateData(params).message).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes the names in an acceptance, which carries no message", () => {
    const params = generateEmailParams(
      { ...injected, recipientIsDriver: false },
      "acceptance",
      false,
    );

    expect(templateData(params)).toEqual({
      preferredName: "Grace &amp; Co",
      OtherUser: '&lt;a href="https://evil.example"&gt;Ada&lt;/a&gt;',
      preferredNameHtml: "Grace &amp; Co",
      OtherUserHtml:
        "&lt;a href=&quot;https://evil.example&quot;&gt;Ada&lt;/a&gt;",
      preferredNamePlain: "Grace & Co",
      OtherUserPlain: '<a href="https://evil.example">Ada</a>',
    });
  });

  it("does not escape the addresses, which are not template data", () => {
    const params = generateEmailParams(
      { ...injected, messageText: "hi" },
      "message",
      true,
    );

    expect(params.Destination).toEqual({
      ToAddresses: ["grace@northeastern.edu"],
      CcAddresses: ["ada@northeastern.edu"],
    });
  });
});

/**
 * SES renders one `TemplateData` blob into both parts of a template, so each
 * part reads its own variables: the `HtmlPart` the escaped `...Html` set, the
 * `TextPart` the raw `...Plain` set. The unsuffixed set is the previous
 * generation, still emitted so that a template not yet republished keeps
 * working. See the note above `escapeHtmlText` and SCRUM-360.
 */
describe("escapeHtmlAttribute", () => {
  it("agrees with escapeHtmlText on input carrying no quotes", () => {
    const value = "<b>me & you</b>";

    expect(escapeHtmlAttribute(value)).toBe(escapeHtmlText(value));
    expect(escapeHtmlAttribute(value)).toBe("&lt;b&gt;me &amp; you&lt;/b&gt;");
  });

  it("escapes the quotes that can break out of an attribute value", () => {
    expect(escapeHtmlAttribute(`" onmouseover="alert(1)`)).toBe(
      "&quot; onmouseover=&quot;alert(1)",
    );
    expect(escapeHtmlAttribute("' onmouseover='alert(1)")).toBe(
      "&#39; onmouseover=&#39;alert(1)",
    );
  });

  it("escapes an ampersand once, not twice", () => {
    expect(escapeHtmlAttribute("&quot;")).toBe("&amp;quot;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtmlAttribute("See you at 8:45")).toBe("See you at 8:45");
  });
});

describe("the HtmlPart and TextPart variable split", () => {
  const withApostrophe = {
    ...base,
    receiverName: "Grace O'Brien",
    senderName: "Ada & Co",
  };

  it("gives the plain-text part exactly what the user typed", () => {
    const data = templateData(
      generateEmailParams(
        { ...withApostrophe, messageText: "I'm running late — me & you at 8?" },
        "message",
        false,
      ),
    );

    expect(data.preferredNamePlain).toBe("Grace O'Brien");
    expect(data.OtherUserPlain).toBe("Ada & Co");
    expect(data.messagePlain).toBe("I'm running late — me & you at 8?");
  });

  it("escapes the HTML part aggressively, apostrophes included", () => {
    const data = templateData(
      generateEmailParams(
        { ...withApostrophe, messageText: `say "hi" & <bye>` },
        "message",
        false,
      ),
    );

    expect(data.preferredNameHtml).toBe("Grace O&#39;Brien");
    expect(data.OtherUserHtml).toBe("Ada &amp; Co");
    expect(data.messageHtml).toBe("say &quot;hi&quot; &amp; &lt;bye&gt;");
  });

  it("still emits the legacy set, escaped as it was, for templates awaiting a republish", () => {
    const data = templateData(
      generateEmailParams(
        { ...withApostrophe, messageText: `say "hi" & <bye>` },
        "message",
        false,
      ),
    );

    expect(data.preferredName).toBe("Grace O'Brien");
    expect(data.OtherUser).toBe("Ada &amp; Co");
    expect(data.message).toBe(`say "hi" &amp; &lt;bye&gt;`);
  });

  it("never leaves a tag unescaped in either escaped set", () => {
    const data = templateData(
      generateEmailParams(
        { ...base, messageText: "<script>alert(1)</script>" },
        "message",
        false,
      ),
    );

    for (const key of ["message", "messageHtml"]) {
      expect(data[key]).not.toContain("<");
      expect(data[key]).not.toContain(">");
    }
    expect(data.messagePlain).toContain("<script>");
  });

  it("emits every variable a template can reference, and nothing else", () => {
    const request = templateData(
      generateEmailParams(requestSchema(true), "request", false),
    );
    const acceptance = templateData(
      generateEmailParams(acceptanceSchema(true), "acceptance", false),
    );

    expect(Object.keys(request).sort()).toEqual([
      "OtherUser",
      "OtherUserHtml",
      "OtherUserPlain",
      "message",
      "messageHtml",
      "messagePlain",
      "preferredName",
      "preferredNameHtml",
      "preferredNamePlain",
    ]);
    expect(Object.keys(acceptance).sort()).toEqual([
      "OtherUser",
      "OtherUserHtml",
      "OtherUserPlain",
      "preferredName",
      "preferredNameHtml",
      "preferredNamePlain",
    ]);
  });
});
