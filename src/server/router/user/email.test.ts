import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import type { Context } from "../context";

/**
 * `NEXT_PUBLIC_ENV` is validated by envsafe at import time now (SCRUM-247), so
 * these tests mock the env module instead of assigning to `process.env`
 * mid-run — the variable is read once when the module loads, and a later
 * assignment would never be seen. The getter keeps `deployEnv` swappable
 * per-test, which is what the staging cases below need.
 */
let deployEnv = "production";

jest.mock("../../../utils/env/browser", () => ({
  browserEnv: {
    get NEXT_PUBLIC_ENV() {
      return deployEnv;
    },
  },
}));

// `jest.mock` is hoisted above imports, so the router below picks up the mock.
import { appRouter } from "../index";

/**
 * Authorization tests for `user.emails` (SCRUM-225).
 *
 * The four procedures used to take sender name, sender address, recipient name,
 * recipient address and the body straight from client input, making them an
 * open relay through the NUCarpool SES identity: any signed-in user could send
 * arbitrary text to an arbitrary address under our branding.
 *
 * These tests pin the fixed behaviour — every address is resolved server-side,
 * and no client-supplied address can reach SES. The load-bearing assertion
 * throughout is `expect(ses).not.toHaveBeenCalled()`: on every rejection path,
 * no mail is attempted at all.
 *
 * Same `createCaller` + mocked-Prisma approach as `favorites.test.ts` and
 * `requests.test.ts`. No network, no SES, no database — `ctx.sesClient` is a
 * jest mock, so nothing here can send real email.
 */

/**
 * These procedures branch on NEXT_PUBLIC_ENV (staging restricts recipients to
 * gmail.com). Reset to production before each test so a staging case cannot
 * leak into the ones after it.
 */
beforeEach(() => {
  deployEnv = "production";
});

const ALICE = "user-alice";
const BOB = "user-bob";
const MALLORY = "user-mallory";
const REQUEST_ID = "request-1";
const CONVERSATION_ID = "conversation-1";

type UserRow = {
  id: string;
  preferredName: string;
  name: string | null;
  email: string | null;
  role?: "DRIVER" | "RIDER" | "VIEWER";
};

type MessageRow = {
  id: string;
  conversationId: string;
  userId: string;
  content: string;
  dateCreated: Date;
};

const defaultUsers: UserRow[] = [
  {
    id: ALICE,
    preferredName: "Alice",
    name: "Alice A",
    email: "alice@example.com",
    role: "RIDER",
  },
  {
    id: BOB,
    preferredName: "Bob",
    name: "Bob B",
    email: "bob@example.com",
    role: "DRIVER",
  },
  {
    id: MALLORY,
    preferredName: "Mallory",
    name: "Mallory M",
    email: "mallory@example.com",
    role: "RIDER",
  },
];

const buildEmailDb = (opts?: {
  users?: UserRow[];
  request?: {
    id: string;
    fromUserId: string;
    toUserId: string;
    conversationId: string | null;
    dateCreated?: Date;
  } | null;
  messages?: MessageRow[];
  /**
   * Rows behind `request.count`, which backs the per-sender budget on
   * `sendRequestNotification`. Separate from `request` because the count is
   * over the caller's whole recent history, not the one row being announced.
   */
  senderRequests?: { fromUserId: string; dateCreated: Date }[];
}) => {
  const users = new Map((opts?.users ?? defaultUsers).map((u) => [u.id, u]));
  const rawRequest =
    opts?.request === undefined
      ? {
          id: REQUEST_ID,
          fromUserId: ALICE,
          toUserId: BOB,
          conversationId: CONVERSATION_ID,
        }
      : opts?.request;
  // Fresh unless a test says otherwise: a request notification only fires for
  // a request that was just created.
  const request = rawRequest
    ? { dateCreated: new Date(), ...rawRequest }
    : rawRequest;
  const senderRequests = opts?.senderRequests ?? [];
  const messages = opts?.messages ?? [];

  const userFindUnique = jest.fn(
    async ({ where }: any) => users.get(where.id) ?? null,
  );

  const carpoolSearchFindFirst = jest.fn(async ({ where }: any) => {
    const u = users.get(where.userId);
    return u?.role ? { role: u.role } : null;
  });

  const requestFindUnique = jest.fn(async ({ where }: any) =>
    request && request.id === where.id ? { ...request } : null,
  );

  const requestCount = jest.fn(async ({ where }: any) => {
    const since = where.dateCreated?.gte as Date | undefined;
    return senderRequests.filter(
      (r) =>
        r.fromUserId === where.fromUserId &&
        (since === undefined || r.dateCreated.getTime() >= since.getTime()),
    ).length;
  });

  const messageFindFirst = jest.fn(async ({ where, orderBy }: any) => {
    const matching = messages
      .filter(
        (m) =>
          m.conversationId === where.conversationId &&
          m.userId === where.userId,
      )
      .sort((a, b) =>
        orderBy?.dateCreated === "desc"
          ? b.dateCreated.getTime() - a.dateCreated.getTime()
          : a.dateCreated.getTime() - b.dateCreated.getTime(),
      );
    return matching[0] ?? null;
  });

  const messageCount = jest.fn(async ({ where }: any) => {
    const since = where.dateCreated?.gte as Date | undefined;
    const excludedId = where.id?.not as string | undefined;
    return messages.filter(
      (m) =>
        m.conversationId === where.conversationId &&
        m.userId === where.userId &&
        (excludedId === undefined || m.id !== excludedId) &&
        (since === undefined || m.dateCreated.getTime() >= since.getTime()),
    ).length;
  });

  // Declares the command parameter so `mock.calls[n][0]` is typed; without it
  // the call tuple is empty and `tsc` rejects the index.
  const ses = jest.fn(async (_command: unknown) => ({
    MessageId: "ses-message-id",
  }));

  return {
    prisma: {
      user: { findUnique: userFindUnique },
      carpoolSearch: { findFirst: carpoolSearchFindFirst },
      request: { findUnique: requestFindUnique, count: requestCount },
      message: { findFirst: messageFindFirst, count: messageCount },
    },
    ses,
    /** Params of the nth SendTemplatedEmailCommand handed to SES. */
    sentParams: (n = 0) => (ses.mock.calls[n]?.[0] as any)?.input,
    templateData: (n = 0) =>
      JSON.parse((ses.mock.calls[n]?.[0] as any)?.input?.TemplateData ?? "{}"),
  };
};

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (session: Session | null, db = buildEmailDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: db.ses },
  } as unknown as Context;
  return { caller: appRouter.createCaller(ctx), db };
};

/** Reaches past the compiler to send what an untrusted HTTP client could. */
const asAny = (payload: Record<string, unknown>) => payload as any;

describe("user.emails.sendRequestNotification — participants only, addresses from the database", () => {
  it("sends to the stored address of the referenced user", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "hello",
    });

    expect(db.ses).toHaveBeenCalledTimes(1);
    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "bob@example.com",
    ]);
    expect(db.templateData()).toMatchObject({
      preferredName: "Bob",
      OtherUser: "Alice",
    });
  });

  it("ignores any address the client tries to supply, rejecting the payload", async () => {
    // The attack: reference a real request but redirect delivery elsewhere.
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification(
        asAny({
          requestId: REQUEST_ID,
          messagePreview: "x",
          receiverEmail: "attacker@evil.test",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("cannot be used to spoof the sender's display name", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification(
        asAny({
          requestId: REQUEST_ID,
          messagePreview: "x",
          senderName: "NUCarpool Security",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("picks the template from the recipient's role, resolved server-side", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    // Bob drives, so the recipient gets the driver-facing request template.
    expect(db.sentParams().Template).toBe("DriverRequestTemplate");
  });

  it("picks the rider template when the recipient rides", async () => {
    // The mirror of the case above. Without it the assertion is satisfied by
    // a hard-coded template, which is close to the SCRUM-268 defect.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: BOB,
        toUserId: ALICE,
        conversationId: CONVERSATION_ID,
      },
    });
    const { caller } = callerFor(sessionFor(BOB), db);

    await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "alice@example.com",
    ]);
    expect(db.sentParams().Template).toBe("RiderRequestTemplate");
  });

  it("refuses to mail the caller themselves", async () => {
    // `user.requests.create` does not stop a self-request, so a row with both
    // ends the same is reachable. It must not turn into mail.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: ALICE,
        conversationId: CONVERSATION_ID,
      },
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("caps the preview length rather than relaying an unbounded body", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x".repeat(251),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not part of the request", async () => {
    // The reported hole (SCRUM-270): this used to take a bare `toId`, and
    // every PublicUser the map and recommendations return carries a user id,
    // so any signed-in student could mail any other registered user.
    const { caller, db } = callerFor(sessionFor(MALLORY));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses the recipient of the request, not just a stranger", async () => {
    // Bob is a party to the request, so the shared participant check passes.
    // He still must not be able to mail Alice "someone wants to carpool with
    // you" about Alice's own request.
    const { caller, db } = callerFor(sessionFor(BOB));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses a request id that does not exist", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: "no-such-request",
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("will not re-announce a request that is no longer new", async () => {
    // Without this the procedure can be called over and over against one
    // long-lived row, mailing the same person as many times as the caller
    // likes — the volume half of the problem.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        dateCreated: new Date(Date.now() - 6 * 60 * 1000),
      },
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    expect(result).toEqual({ sent: false, reason: "request_not_recent" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("still announces a request created moments ago", async () => {
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        dateCreated: new Date(Date.now() - 30 * 1000),
      },
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).resolves.toEqual({ sent: true });
    expect(db.ses).toHaveBeenCalledTimes(1);
  });

  it("stops a sender who has made more than ten requests in the last hour", async () => {
    const recently = (minutesAgo: number) => ({
      fromUserId: ALICE,
      dateCreated: new Date(Date.now() - minutesAgo * 60 * 1000),
    });
    const db = buildEmailDb({
      senderRequests: Array.from({ length: 11 }, (_, i) => recently(i)),
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    expect(result).toEqual({ sent: false, reason: "rate_limited" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("counts only the caller's own recent requests toward that budget", async () => {
    const db = buildEmailDb({
      senderRequests: [
        // Someone else being busy must not silence Alice...
        ...Array.from({ length: 20 }, () => ({
          fromUserId: MALLORY,
          dateCreated: new Date(),
        })),
        // ...nor must Alice's own requests from yesterday.
        ...Array.from({ length: 20 }, () => ({
          fromUserId: ALICE,
          dateCreated: new Date(Date.now() - 25 * 60 * 60 * 1000),
        })),
        { fromUserId: ALICE, dateCreated: new Date() },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).resolves.toEqual({ sent: true });
    expect(db.ses).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when we hold no address for the recipient", async () => {
    const db = buildEmailDb({
      users: [
        defaultUsers[0]!,
        {
          id: BOB,
          preferredName: "Bob",
          name: null,
          email: null,
          role: "DRIVER",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    expect(result).toEqual({ sent: false, reason: "missing_email_address" });
    expect(db.ses).not.toHaveBeenCalled();
  });
});

describe("user.emails.sendMessageNotification — participants only, stored body", () => {
  const withMessage = (content = "the stored message") =>
    buildEmailDb({
      messages: [
        {
          id: "message-1",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content,
          dateCreated: new Date("2026-08-21T12:00:00Z"),
        },
      ],
    });

  it("takes the body from the stored message, not from the client", async () => {
    const db = withMessage("what Alice actually wrote");
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID });

    expect(db.templateData().message).toBe("what Alice actually wrote");
    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "bob@example.com",
    ]);
  });

  it("refuses a caller who is not a party to the request", async () => {
    const db = withMessage();
    const { caller } = callerFor(sessionFor(MALLORY), db);

    await expect(
      caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("reports NOT_FOUND for a request that does not exist", async () => {
    const db = buildEmailDb({ request: null });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendMessageNotification({ requestId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("rate-limits a second notification within the cooldown", async () => {
    const db = buildEmailDb({
      messages: [
        {
          id: "message-1",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "first",
          dateCreated: new Date("2026-08-21T12:00:00Z"),
        },
        {
          id: "message-2",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "second, one minute later",
          dateCreated: new Date("2026-08-21T12:01:00Z"),
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendMessageNotification({
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ sent: false, reason: "rate_limited" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("allows a notification once the cooldown has elapsed", async () => {
    const db = buildEmailDb({
      messages: [
        {
          id: "message-1",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "first",
          dateCreated: new Date("2026-08-21T12:00:00Z"),
        },
        {
          id: "message-2",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "second, six minutes later",
          dateCreated: new Date("2026-08-21T12:06:00Z"),
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID });

    expect(db.ses).toHaveBeenCalledTimes(1);
    expect(db.templateData().message).toBe("second, six minutes later");
  });

  it("sends nothing when the caller has no message in the thread", async () => {
    const db = buildEmailDb({ messages: [] });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendMessageNotification({
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ sent: false, reason: "no_message_to_notify" });
    expect(db.ses).not.toHaveBeenCalled();
  });
});

describe("user.emails.sendAcceptanceNotification — participants only", () => {
  it("resolves both parties from the request and copies the sender", async () => {
    const { caller, db } = callerFor(sessionFor(BOB));

    await caller.user.emails.sendAcceptanceNotification({
      requestId: REQUEST_ID,
    });

    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "alice@example.com",
    ]);
    expect(db.sentParams().Destination.CcAddresses).toEqual([
      "bob@example.com",
    ]);
  });

  it("refuses a caller who is not a party to the request", async () => {
    const { caller, db } = callerFor(sessionFor(MALLORY));

    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  /**
   * SCRUM-268. Both acceptance templates address the recipient in the second
   * person, so the choice between them is a fact about the recipient:
   *
   *   DriverAcceptanceTemplate  "...accepted your request for them to join your group"
   *   RiderAcceptanceTemplate   "...accepted your request to join their Carpool group"
   *
   * The flow used to supply the *caller's* role. Because the two roles in a
   * pair are complementary that was always the wrong one, so every acceptance
   * email was worded for the other party. Asserting both directions is the
   * point: a test that only checks one could pass with the role hard-coded.
   */
  it("tells a rider their request was accepted, when a driver accepts", async () => {
    // Alice (rider) asked to join Bob's (driver) carpool; Bob accepts.
    const { caller, db } = callerFor(sessionFor(BOB));

    await caller.user.emails.sendAcceptanceNotification({
      requestId: REQUEST_ID,
    });

    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "alice@example.com",
    ]);
    expect(db.sentParams().Template).toBe("RiderAcceptanceTemplate");
  });

  it("tells a driver their invitation was accepted, when a rider accepts", async () => {
    // The other direction: Bob (driver) invited Alice (rider), Alice accepts.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: BOB,
        toUserId: ALICE,
        conversationId: CONVERSATION_ID,
      },
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendAcceptanceNotification({
      requestId: REQUEST_ID,
    });

    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "bob@example.com",
    ]);
    expect(db.sentParams().Template).toBe("DriverAcceptanceTemplate");
  });
});

describe("user.emails — staging still restricts recipients", () => {
  it("refuses a non-gmail recipient in staging without contacting SES", async () => {
    deployEnv = "staging";
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("allows a gmail recipient in staging", async () => {
    deployEnv = "staging";
    const db = buildEmailDb({
      users: [
        defaultUsers[0]!,
        {
          id: BOB,
          preferredName: "Bob",
          name: null,
          email: "bob@gmail.com",
          role: "DRIVER",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
      messagePreview: "x",
    });

    expect(db.ses).toHaveBeenCalledTimes(1);
  });
});

describe("user.emails — authentication gate and removed surface", () => {
  it("rejects an anonymous caller without contacting SES", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
        messagePreview: "x",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("no longer exposes connectEmail", async () => {
    // Unused API surface that accepted a free-text body and an arbitrary
    // recipient; removed rather than authorized.
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).toContain("user.emails.sendRequestNotification");
    expect(paths).not.toContain("user.emails.connectEmail");
  });
});
