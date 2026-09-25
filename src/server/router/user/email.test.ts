import { Permission, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import type { Context } from "../context";
import { BLOCKED_PAIR_MESSAGE } from "../../db/blocks";
import { fakeBlockDelegate } from "../../../testing/blockFake";
import type { BlockRow } from "../../../testing/blockFake";

/**
 * `NEXT_PUBLIC_ENV` is validated by envsafe at import time now, so
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
 * Authorization tests for `user.emails`.
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
  /** Defaults to true: a message `sendMessage` wrote and nobody has announced. */
  notificationPending?: boolean;
};

/**
 * When the fixture request was opened. It is also the `dateCreated` of the
 * opening message, since `requests.create` writes the same value to both.
 */
const OPENED_AT = new Date("2026-09-25T12:00:00.000Z");

/** The message `requests.create` stores with the fixture request. */
const openingMessage = (content: string): MessageRow => ({
  id: "opening-message",
  conversationId: CONVERSATION_ID,
  userId: ALICE,
  content,
  dateCreated: OPENED_AT,
  notificationPending: false,
});

/** Null and Date both compare by value, the way MySQL compares the column. */
const sameInstant = (a: Date | null | undefined, b: Date | null | undefined) =>
  (a ?? null) === null || (b ?? null) === null
    ? (a ?? null) === (b ?? null)
    : a!.getTime() === b!.getTime();

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
    notificationPendingSince?: Date | null;
    acceptanceNotificationPendingSince?: Date | null;
    status?: RequestStatus;
  } | null;
  messages?: MessageRow[];
  /** Makes SES reject every send, as a throttle or an outage would. */
  sesFails?: boolean;
  /**
   * Rows behind `request.count`, which backs the per-sender budget on
   * `sendRequestNotification`. Separate from `request` because the count is
   * over the caller's whole recent history, not the one row being announced.
   */
  senderRequests?: { fromUserId: string; dateCreated: Date }[];
  /** Block rows, either direction. None by default: nobody has blocked anybody. */
  blocks?: BlockRow[];
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
  // Just opened, unannounced and pending unless a test says otherwise. A
  // request that was just created has not been accepted. Acceptance cases opt
  // in explicitly — defaulting to ACCEPTED here would let a procedure that
  // never reads `status` pass every test in the file. The acceptance marker
  // defaults to owed too, matching `markRequestAccepted`, which sets it in
  // the same statement that sets `status: ACCEPTED` — so any fixture that
  // does not override it behaves like a request genuinely just accepted.
  //
  // Mutable, because the claim is a write: `request.updateMany` below changes
  // this row, so a second call sees what the first one left.
  const request = rawRequest
    ? {
        notificationPendingSince: OPENED_AT,
        acceptanceNotificationPendingSince: OPENED_AT,
        status: RequestStatus.PENDING,
        ...rawRequest,
      }
    : rawRequest;
  const senderRequests = opts?.senderRequests ?? [];
  const messages = (opts?.messages ?? []).map((m) => ({
    notificationPending: true,
    ...m,
  }));

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

  // Only the SES-failure path writes through here now: it restores a marker
  // the claim cleared. Matches only while every condition in `where` holds.
  // Two markers share this delegate — `notificationPendingSince` (request
  // email) and `acceptanceNotificationPendingSince` (acceptance email) — each
  // checked only when the release call's `where` actually names it.
  const requestUpdateMany = jest.fn(async ({ where, data }: any) => {
    if (!request || request.id !== where.id) {
      return { count: 0 };
    }
    if (
      "notificationPendingSince" in where &&
      !sameInstant(
        request.notificationPendingSince,
        where.notificationPendingSince,
      )
    ) {
      return { count: 0 };
    }
    if (
      "acceptanceNotificationPendingSince" in where &&
      !sameInstant(
        request.acceptanceNotificationPendingSince,
        where.acceptanceNotificationPendingSince,
      )
    ) {
      return { count: 0 };
    }
    Object.assign(request, data);
    return { count: 1 };
  });

  const messageFindFirst = jest.fn(async ({ where, orderBy }: any) => {
    const matching = messages
      .filter(
        (m) =>
          m.conversationId === where.conversationId &&
          m.userId === where.userId &&
          (where.dateCreated === undefined ||
            sameInstant(m.dateCreated, where.dateCreated)),
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

  const messageUpdateMany = jest.fn(async ({ where, data }: any) => {
    const target = messages.find(
      (m) =>
        m.id === where.id &&
        (where.notificationPending === undefined ||
          m.notificationPending === where.notificationPending),
    );
    if (!target) return { count: 0 };
    Object.assign(target, data);
    return { count: 1 };
  });

  /**
   * The three claim statements, which `email.ts` runs as raw SQL because
   * `updateMany` is not atomic under `relationMode = "prisma"`. Each checks the
   * marker and clears it in one synchronous step, as the single InnoDB
   * `UPDATE` does, and returns the rows changed. Anything else is an error, so
   * a new raw statement cannot pass here unnoticed.
   *
   * `acceptanceNotificationPendingSince` is checked before the plain
   * `notificationPendingSince` branch below, since both templates start with
   * `UPDATE \`request\``.
   */
  const executeRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      const [id] = values;
      if (sql.includes("acceptanceNotificationPendingSince")) {
        if (
          !request ||
          request.id !== id ||
          !request.acceptanceNotificationPendingSince
        ) {
          return 0;
        }
        request.acceptanceNotificationPendingSince = null;
        return 1;
      }
      if (sql.includes("UPDATE `request`")) {
        if (
          !request ||
          request.id !== id ||
          !request.notificationPendingSince
        ) {
          return 0;
        }
        request.notificationPendingSince = null;
        return 1;
      }
      if (sql.includes("UPDATE `message`")) {
        const target = messages.find(
          (m) => m.id === id && m.notificationPending,
        );
        if (!target) return 0;
        target.notificationPending = false;
        return 1;
      }
      throw new Error(`Unexpected raw SQL in a test: ${sql}`);
    },
  );

  // Declares the command parameter so `mock.calls[n][0]` is typed; without it
  // the call tuple is empty and `tsc` rejects the index.
  const ses = jest.fn(async (_command: unknown) => {
    if (opts?.sesFails) throw new Error("Throttling: Maximum sending rate");
    return { MessageId: "ses-message-id" };
  });

  return {
    prisma: {
      $executeRaw: executeRaw,
      block: fakeBlockDelegate(opts?.blocks),
      user: { findUnique: userFindUnique },
      carpoolSearch: { findFirst: carpoolSearchFindFirst },
      request: {
        findUnique: requestFindUnique,
        count: requestCount,
        updateMany: requestUpdateMany,
      },
      message: {
        findFirst: messageFindFirst,
        count: messageCount,
        updateMany: messageUpdateMany,
      },
    },
    /** The fixture rows, as the procedures have left them. */
    request,
    messages,
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
    });

    // Bob drives, so the recipient gets the driver-facing request template.
    expect(db.sentParams().Template).toBe("DriverRequestTemplate");
  });

  it("picks the rider template when the recipient rides", async () => {
    // The mirror of the case above. Without it the assertion is satisfied by
    // a hard-coded template, which is close to the original defect.
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
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  /**
   * The body used to be `input.messagePreview`, sent to SES unchecked. With the
   * replay below, that let a requester mail the recipient any text they liked,
   * repeatedly, and none of it was stored where a report could capture it
   * (SCRUM-559).
   */
  it("no longer accepts a preview from the client", async () => {
    const db = buildEmailDb({ messages: [openingMessage("stored text")] });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification(
        asAny({ requestId: REQUEST_ID, messagePreview: "anything at all" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("quotes the message stored with the request", async () => {
    const db = buildEmailDb({
      messages: [openingMessage("Happy to split gas")],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID });

    // `messageVariables` emits the same text under more than one key.
    expect(JSON.stringify(db.templateData())).toContain("Happy to split gas");
  });

  it("quotes nothing when no message was stored with the request", async () => {
    // A reopen with an empty box writes no message, so there is nothing to
    // quote. Anything else in the thread — here Alice's message from the
    // pair's last carpool — belongs to an earlier request and must not be
    // presented as this one's.
    const db = buildEmailDb({
      messages: [
        {
          ...openingMessage("See you Monday!"),
          id: "old-message",
          dateCreated: new Date("2026-01-10T09:00:00.000Z"),
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
    ).resolves.toEqual({ sent: true });

    expect(JSON.stringify(db.templateData())).not.toContain("See you Monday!");
  });

  it("refuses a caller who is not part of the request", async () => {
    // The reported hole: this used to take a bare `toId`, and
    // every PublicUser the map and recommendations return carries a user id,
    // so any signed-in student could mail any other registered user.
    const { caller, db } = callerFor(sessionFor(MALLORY));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
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
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses a request id that does not exist", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: "no-such-request",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  /**
   * The replay these cases pin (SCRUM-559). The only control used to be "the
   * request is under five minutes old", so inside that window every call sent
   * another email. The count of SES calls is the assertion that matters.
   */
  it("sends one email for a request however many times it is called", async () => {
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
    ).resolves.toEqual({ sent: true });
    for (let i = 0; i < 3; i++) {
      await expect(
        caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
      ).resolves.toEqual({ sent: false, reason: "already_notified" });
    }

    expect(db.ses).toHaveBeenCalledTimes(1);
    expect(db.request?.notificationPendingSince).toBeNull();
  });

  it("sends one email when two calls race", async () => {
    // Both read the marker before either clears it. The conditional update is
    // what lets only one through.
    const { caller, db } = callerFor(sessionFor(ALICE));

    const results = await Promise.all([
      caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
      caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
    ]);

    expect(results).toContainEqual({ sent: true });
    expect(results).toContainEqual({
      sent: false,
      reason: "already_notified",
    });
    expect(db.ses).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a request with no email owed", async () => {
    // Every row older than the marker column, and every request already
    // announced. Such a request can be years old; its age is not what matters.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        notificationPendingSince: null,
      },
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendRequestNotification({
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ sent: false, reason: "already_notified" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("keeps the email owed when SES refuses it, so a retry can still send", async () => {
    const db = buildEmailDb({ sesFails: true });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendRequestNotification({ requestId: REQUEST_ID }),
    ).rejects.toThrow("Throttling");

    expect(db.request?.notificationPendingSince).toEqual(OPENED_AT);
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

  /**
   * The replay (SCRUM-559). The cooldown counts the caller's *other* recent
   * messages, so after one message every call saw none and sent. The marker
   * is what stops that; the cooldown only limits bursts of new messages.
   */
  it("sends one email for a message however many times it is called", async () => {
    const db = withMessage();
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
    ).resolves.toEqual({ sent: true });
    for (let i = 0; i < 3; i++) {
      await expect(
        caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
      ).resolves.toEqual({ sent: false, reason: "already_notified" });
    }

    expect(db.ses).toHaveBeenCalledTimes(1);
    expect(db.messages[0]?.notificationPending).toBe(false);
  });

  it("sends one email when two calls race", async () => {
    const db = withMessage();
    const { caller } = callerFor(sessionFor(ALICE), db);

    const results = await Promise.all([
      caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
      caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
    ]);

    expect(results).toContainEqual({ sent: true });
    expect(results).toContainEqual({
      sent: false,
      reason: "already_notified",
    });
    expect(db.ses).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a message no email is owed for", async () => {
    // The request's opening message, which the request email announces, and
    // every message older than the marker column.
    const db = buildEmailDb({ messages: [openingMessage("hi")] });
    const { caller } = callerFor(sessionFor(ALICE), db);

    const result = await caller.user.emails.sendMessageNotification({
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ sent: false, reason: "already_notified" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("keeps the email owed when SES refuses it", async () => {
    const db = buildEmailDb({
      sesFails: true,
      messages: [
        {
          id: "message-1",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "hello",
          dateCreated: new Date("2026-08-21T12:00:00Z"),
        },
      ],
    });
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
    ).rejects.toThrow("Throttling");

    expect(db.messages[0]?.notificationPending).toBe(true);
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

describe("user.emails.sendAcceptanceNotification — only the party who accepted, and only once it is accepted", () => {
  /**
   * An acceptance email asserts a specific fact about a specific person, so
   * the procedure requires more than the shared "are you a participant" check:
   * the request must be `ACCEPTED`, and the caller must be the party it was
   * addressed to. The fixture default is a fresh `PENDING` request, which is
   * no longer this flow, so every genuine case builds the accepted row.
   */
  const acceptedRequestDb = (
    fromUserId = ALICE,
    toUserId = BOB,
    status: RequestStatus = RequestStatus.ACCEPTED,
  ) =>
    buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId,
        toUserId,
        conversationId: CONVERSATION_ID,
        status,
      },
    });

  it("resolves both parties from the request and copies the sender", async () => {
    const { caller, db } = callerFor(sessionFor(BOB), acceptedRequestDb());

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
    const { caller, db } = callerFor(sessionFor(MALLORY), acceptedRequestDb());

    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  /**
   * The defect these three cases exist to pin.
   *
   * The procedure did not read `Request.status` at all, and the shared party
   * check admits either side of a request. Together that let the *sender* of a
   * still-pending request make the platform email their target "Alice accepted
   * your carpool request" — about a request the target never made and nobody
   * accepted — from our verified SES identity, as many times as they liked.
   *
   * Both halves are asserted separately because either one alone still leaves
   * a way to send a false notice: the status check alone would let the wrong
   * party announce a real acceptance, and the direction check alone would let
   * a recipient announce an acceptance that never happened.
   *
   * `expect(db.ses).not.toHaveBeenCalled()` is the load-bearing assertion, as
   * everywhere else in this file. A refusal that still sends the mail is the
   * failure that actually matters.
   */
  it("refuses the sender of a pending request, who could otherwise fabricate the whole notice", async () => {
    const db = buildEmailDb(); // Alice -> Bob, PENDING by default.
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses a request nobody has accepted, even asked by its recipient", async () => {
    const db = acceptedRequestDb(ALICE, BOB, RequestStatus.PENDING);
    const { caller } = callerFor(sessionFor(BOB), db);

    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "That carpool request has not been accepted.",
    });

    expect(db.ses).not.toHaveBeenCalled();
  });

  it("refuses the requester of an accepted request, who is not the party that accepted it", async () => {
    const db = acceptedRequestDb();
    const { caller } = callerFor(sessionFor(ALICE), db);

    // A distinct message from the case above on purpose: "you did not accept
    // this" and "this was not accepted" call for different things from the
    // caller, and one shared message would leave both unclear.
    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the person a request was sent to can accept it.",
    });

    expect(db.ses).not.toHaveBeenCalled();
  });

  /**
   * Both acceptance templates address the recipient in the second
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
    const { caller, db } = callerFor(sessionFor(BOB), acceptedRequestDb());

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
    const db = acceptedRequestDb(BOB, ALICE);
    const { caller } = callerFor(sessionFor(ALICE), db);

    await caller.user.emails.sendAcceptanceNotification({
      requestId: REQUEST_ID,
    });

    expect(db.sentParams().Destination.ToAddresses).toEqual([
      "bob@example.com",
    ]);
    expect(db.sentParams().Template).toBe("DriverAcceptanceTemplate");
  });

  /**
   * The replay this ticket exists to close (SCRUM-564). Before, the procedure
   * checked only direction and status, both of which stay true forever once a
   * request is accepted, so every call after the first sent another copy of
   * "<name> accepted your carpool request". The marker is what stops that.
   */
  it("sends one email for an acceptance however many times it is called", async () => {
    const { caller, db } = callerFor(sessionFor(BOB), acceptedRequestDb());

    await expect(
      caller.user.emails.sendAcceptanceNotification({
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ sent: true });
    for (let i = 0; i < 3; i++) {
      await expect(
        caller.user.emails.sendAcceptanceNotification({
          requestId: REQUEST_ID,
        }),
      ).resolves.toEqual({ sent: false, reason: "already_notified" });
    }

    expect(db.ses).toHaveBeenCalledTimes(1);
    expect(db.request?.acceptanceNotificationPendingSince).toBeNull();
  });

  it("sends one email when two calls race on the same acceptance", async () => {
    // Both read the marker before either clears it. The conditional update is
    // what lets only one through, as with the request and message emails.
    const { caller, db } = callerFor(sessionFor(BOB), acceptedRequestDb());

    const results = await Promise.all([
      caller.user.emails.sendAcceptanceNotification({
        requestId: REQUEST_ID,
      }),
      caller.user.emails.sendAcceptanceNotification({
        requestId: REQUEST_ID,
      }),
    ]);

    expect(results).toContainEqual({ sent: true });
    expect(results).toContainEqual({
      sent: false,
      reason: "already_notified",
    });
    expect(db.ses).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a request accepted before the marker column existed", async () => {
    // Every row `markRequestAccepted` resolved before this migration: the
    // column defaults to null, and null means no email is owed.
    const db = buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        status: RequestStatus.ACCEPTED,
        acceptanceNotificationPendingSince: null,
      },
    });
    const { caller } = callerFor(sessionFor(BOB), db);

    const result = await caller.user.emails.sendAcceptanceNotification({
      requestId: REQUEST_ID,
    });

    expect(result).toEqual({ sent: false, reason: "already_notified" });
    expect(db.ses).not.toHaveBeenCalled();
  });

  it("keeps the email owed when SES refuses it, so a retry can still send", async () => {
    const db = buildEmailDb({
      sesFails: true,
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        status: RequestStatus.ACCEPTED,
      },
    });
    const { caller } = callerFor(sessionFor(BOB), db);

    await expect(
      caller.user.emails.sendAcceptanceNotification({
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow("Throttling");

    expect(db.request?.acceptanceNotificationPendingSince).toEqual(OPENED_AT);
  });

  /**
   * The three refusal cases above (wrong caller, not accepted, wrong
   * direction) must still send nothing even though every one of them reaches
   * this procedure with the marker owed — the marker is not itself the
   * authorization check.
   */
  it("still sends nothing on a refused accept even though the marker is owed", async () => {
    const db = buildEmailDb(); // Alice -> Bob, PENDING, marker owed by default.
    const { caller } = callerFor(sessionFor(ALICE), db);

    await expect(
      caller.user.emails.sendAcceptanceNotification({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.ses).not.toHaveBeenCalled();
    expect(db.request?.acceptanceNotificationPendingSince).not.toBeNull();
  });
});

/**
 * No mail between a blocked pair (SCRUM-554).
 *
 * All three procedures resolve their parties through one shared helper, which
 * is where the check sits, so each is pinned here separately: a fourth path
 * that bypassed the helper, or a refactor that moved the check into only one
 * procedure, fails the other cases. As everywhere in this file, the
 * load-bearing assertion is that SES was never called.
 */
describe("user.emails — a blocked pair cannot mail each other", () => {
  const bothDirections: [string, BlockRow][] = [
    ["Alice blocked Bob", { blockerId: ALICE, blockedId: BOB }],
    ["Bob blocked Alice", { blockerId: BOB, blockedId: ALICE }],
  ];
  // Control: a block with a third party, which must not silence this pair.
  const unrelated: BlockRow = { blockerId: ALICE, blockedId: MALLORY };

  /** The accepted Alice -> Bob request the acceptance flow needs. */
  const acceptedDb = (blocks: BlockRow[]) =>
    buildEmailDb({
      request: {
        id: REQUEST_ID,
        fromUserId: ALICE,
        toUserId: BOB,
        conversationId: CONVERSATION_ID,
        status: RequestStatus.ACCEPTED,
      },
      blocks,
    });

  /** Alice has written in the thread, so there is something to notify. */
  const withMessageDb = (blocks: BlockRow[]) =>
    buildEmailDb({
      messages: [
        {
          id: "message-1",
          conversationId: CONVERSATION_ID,
          userId: ALICE,
          content: "hello",
          dateCreated: new Date("2026-08-21T12:00:00Z"),
        },
      ],
      blocks,
    });

  describe("sendRequestNotification", () => {
    it.each(bothDirections)(
      "refuses when %s, without contacting SES",
      async (_label, block) => {
        const db = buildEmailDb({ blocks: [block] });
        const { caller } = callerFor(sessionFor(ALICE), db);

        await expect(
          caller.user.emails.sendRequestNotification({
            requestId: REQUEST_ID,
          }),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: BLOCKED_PAIR_MESSAGE,
        });

        expect(db.ses).not.toHaveBeenCalled();
      },
    );

    it("still sends when the only block is with somebody else", async () => {
      const db = buildEmailDb({ blocks: [unrelated] });
      const { caller } = callerFor(sessionFor(ALICE), db);

      await expect(
        caller.user.emails.sendRequestNotification({
          requestId: REQUEST_ID,
        }),
      ).resolves.toEqual({ sent: true });
      expect(db.ses).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendMessageNotification", () => {
    it.each(bothDirections)(
      "refuses when %s, without contacting SES",
      async (_label, block) => {
        const db = withMessageDb([block]);
        const { caller } = callerFor(sessionFor(ALICE), db);

        await expect(
          caller.user.emails.sendMessageNotification({ requestId: REQUEST_ID }),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: BLOCKED_PAIR_MESSAGE,
        });

        expect(db.ses).not.toHaveBeenCalled();
      },
    );

    it("still sends when the only block is with somebody else", async () => {
      const db = withMessageDb([unrelated]);
      const { caller } = callerFor(sessionFor(ALICE), db);

      await caller.user.emails.sendMessageNotification({
        requestId: REQUEST_ID,
      });

      expect(db.ses).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendAcceptanceNotification", () => {
    it.each(bothDirections)(
      "refuses when %s, without contacting SES",
      async (_label, block) => {
        // Bob is the party who accepted, so every other check here passes.
        const db = acceptedDb([block]);
        const { caller } = callerFor(sessionFor(BOB), db);

        await expect(
          caller.user.emails.sendAcceptanceNotification({
            requestId: REQUEST_ID,
          }),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: BLOCKED_PAIR_MESSAGE,
        });

        expect(db.ses).not.toHaveBeenCalled();
      },
    );

    it("still sends when the only block is with somebody else", async () => {
      const db = acceptedDb([unrelated]);
      const { caller } = callerFor(sessionFor(BOB), db);

      await caller.user.emails.sendAcceptanceNotification({
        requestId: REQUEST_ID,
      });

      expect(db.ses).toHaveBeenCalledTimes(1);
    });
  });
});

describe("user.emails — staging still restricts recipients", () => {
  it("refuses a non-gmail recipient in staging without contacting SES", async () => {
    deployEnv = "staging";
    const { caller, db } = callerFor(sessionFor(ALICE));

    await expect(
      caller.user.emails.sendRequestNotification({
        requestId: REQUEST_ID,
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
