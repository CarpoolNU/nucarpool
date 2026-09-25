import { Permission, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";

/**
 * `sendMessage` broadcasts over Pusher once the message is stored. Mocked so
 * this suite never fires a real event. The procedure catches a Pusher failure,
 * so without the mock the suite would still pass, but it would attempt a real
 * network call.
 */
jest.mock("../../pusher", () => ({
  pusherServer: { trigger: jest.fn(async () => ({})) },
}));

// `jest.mock` is hoisted above imports, so the router picks up the mock.
import { appRouter } from "../index";

/**
 * The notification emails are one-shot, against a real MySQL (SCRUM-559).
 *
 * The mocked suite in `email.test.ts` shows the procedures stop after one
 * send. What it cannot show is the part that crosses modules and the database:
 * that `requests.create` and `sendMessage` actually set the marker, that a
 * reopen sets it again, that the claim is a real conditional `UPDATE`, and
 * that the opening message's timestamp survives MySQL exactly, so the request
 * email finds its body. A mocked prisma returns whatever the test says, so
 * none of that can fail there.
 *
 * SES is a `jest.fn` on the context, so nothing here sends real email.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session => ({
  expires: new Date(Date.now() + 60_000).toISOString(),
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

/** A caller over the real database, sharing one SES mock per test. */
const callerFor = (userId: string, ses: jest.Mock) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma,
    sesClient: { send: ses },
  } as unknown as Context);

const newSes = () => jest.fn(async (_command: unknown) => ({ MessageId: "x" }));

/** `TemplateData` of the nth email handed to SES, as one searchable string. */
const templateText = (ses: jest.Mock, n = 0) =>
  String((ses.mock.calls[n]?.[0] as any)?.input?.TemplateData ?? "");

const seedPair = async () => {
  const alice = await prisma.user.create({
    data: { name: "Alice", email: "alice@northeastern.edu" },
  });
  const bob = await prisma.user.create({
    data: { name: "Bob", email: "bob@northeastern.edu" },
  });
  return { alice, bob };
};

describe("request notifications are one-shot", () => {
  it("sends one email for a new request, quoting the stored message", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const asAlice = callerFor(alice.id, ses);

    const request = await asAlice.user.requests.create({
      toId: bob.id,
      message: "Happy to split gas",
    });

    await expect(
      asAlice.user.emails.sendRequestNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: true });
    await expect(
      asAlice.user.emails.sendRequestNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: false, reason: "already_notified" });

    expect(ses).toHaveBeenCalledTimes(1);
    expect(templateText(ses)).toContain("Happy to split gas");
    const row = await prisma.request.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(row.notificationPendingSince).toBeNull();
  });

  it("sends one email when two calls race on the same request", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const asAlice = callerFor(alice.id, ses);
    const request = await asAlice.user.requests.create({
      toId: bob.id,
      message: "hi",
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        asAlice.user.emails.sendRequestNotification({ requestId: request.id }),
      ),
    );

    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(ses).toHaveBeenCalledTimes(1);
  });

  it("sends one email for a reopened request, quoting the new message", async () => {
    // A pair who carpooled before. Previously the reopen left `dateCreated`
    // alone, so the request was never "recent" and was never announced.
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const asAlice = callerFor(alice.id, ses);
    const asBob = callerFor(bob.id, ses);

    const first = await asAlice.user.requests.create({
      toId: bob.id,
      message: "Carpool this spring?",
    });
    await asAlice.user.emails.sendRequestNotification({ requestId: first.id });
    const { dateCreated: firstContact } =
      await prisma.request.findUniqueOrThrow({ where: { id: first.id } });

    // Accepted, then left behind: the state the reopen branch handles.
    await prisma.request.update({
      where: { id: first.id },
      data: { status: RequestStatus.ACCEPTED },
    });
    ses.mockClear();

    // Bob asks this time, so the direction flips as well.
    const reopened = await asBob.user.requests.create({
      toId: alice.id,
      message: "Carpool again this fall?",
    });
    expect(reopened.id).toBe(first.id);

    await expect(
      asBob.user.emails.sendRequestNotification({ requestId: reopened.id }),
    ).resolves.toEqual({ sent: true });
    await expect(
      asBob.user.emails.sendRequestNotification({ requestId: reopened.id }),
    ).resolves.toEqual({ sent: false, reason: "already_notified" });

    expect(ses).toHaveBeenCalledTimes(1);
    expect(templateText(ses)).toContain("Carpool again this fall?");
    expect(templateText(ses)).not.toContain("Carpool this spring?");
    expect((ses.mock.calls[0]?.[0] as any).input.Destination).toMatchObject({
      ToAddresses: ["alice@northeastern.edu"],
    });

    // First contact stays first contact: the admin series and every sort by
    // `dateCreated` read it that way.
    const row = await prisma.request.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(row.dateCreated).toEqual(firstContact);
  });

  it("quotes nothing for a reopen sent with no text", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const asAlice = callerFor(alice.id, ses);

    const first = await asAlice.user.requests.create({
      toId: bob.id,
      message: "Carpool this spring?",
    });
    await asAlice.user.emails.sendRequestNotification({ requestId: first.id });
    await prisma.request.update({
      where: { id: first.id },
      data: { status: RequestStatus.ACCEPTED },
    });
    ses.mockClear();

    await asAlice.user.requests.create({ toId: bob.id, message: "" });

    await expect(
      asAlice.user.emails.sendRequestNotification({ requestId: first.id }),
    ).resolves.toEqual({ sent: true });
    expect(ses).toHaveBeenCalledTimes(1);
    expect(templateText(ses)).not.toContain("Carpool this spring?");
  });

  it("sends nothing for a request written before the marker existed", async () => {
    // What every existing production row looks like: the column defaults to
    // null, and null means no email is owed.
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const legacy = await prisma.request.create({
      data: { message: "", fromUserId: alice.id, toUserId: bob.id },
    });

    await expect(
      callerFor(alice.id, ses).user.emails.sendRequestNotification({
        requestId: legacy.id,
      }),
    ).resolves.toEqual({ sent: false, reason: "already_notified" });
    expect(ses).not.toHaveBeenCalled();
  });

  it("still refuses a blocked pair, and leaves the email owed", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const asAlice = callerFor(alice.id, ses);
    const request = await asAlice.user.requests.create({
      toId: bob.id,
      message: "hi",
    });
    await prisma.block.create({
      data: { blockerId: bob.id, blockedId: alice.id },
    });

    await expect(
      asAlice.user.emails.sendRequestNotification({ requestId: request.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ses).not.toHaveBeenCalled();
    const row = await prisma.request.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(row.notificationPendingSince).not.toBeNull();
  });
});

describe("message notifications are one-shot", () => {
  /**
   * Alice has asked Bob, and the request email has already gone out.
   *
   * The messages under test are Bob's. Alice's opening message is seconds old,
   * so the burst cooldown would drop any message she sent next as
   * `rate_limited`, and the marker would never be reached.
   */
  const seedThread = async (ses: jest.Mock) => {
    const { alice, bob } = await seedPair();
    const asAlice = callerFor(alice.id, ses);
    const asBob = callerFor(bob.id, ses);
    const request = await asAlice.user.requests.create({
      toId: bob.id,
      message: "hi",
    });
    await asAlice.user.emails.sendRequestNotification({
      requestId: request.id,
    });
    ses.mockClear();
    return { asAlice, asBob, request };
  };

  it("sends one email per message however many times it is called", async () => {
    const ses = newSes();
    const { asBob, request } = await seedThread(ses);

    await asBob.user.messages.sendMessage({
      requestId: request.id,
      content: "Running five minutes late",
    });

    await expect(
      asBob.user.emails.sendMessageNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: true });
    for (let i = 0; i < 3; i++) {
      await expect(
        asBob.user.emails.sendMessageNotification({ requestId: request.id }),
      ).resolves.toEqual({ sent: false, reason: "already_notified" });
    }

    expect(ses).toHaveBeenCalledTimes(1);
    expect(templateText(ses)).toContain("Running five minutes late");
  });

  it("sends one email when two calls race on the same message", async () => {
    const ses = newSes();
    const { asBob, request } = await seedThread(ses);
    await asBob.user.messages.sendMessage({
      requestId: request.id,
      content: "hello",
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        asBob.user.emails.sendMessageNotification({ requestId: request.id }),
      ),
    );

    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(ses).toHaveBeenCalledTimes(1);
  });

  it("does not send a second email for the request's opening message", async () => {
    // The request email announced it. Before, the requester could follow it
    // with a message email quoting the same text.
    const ses = newSes();
    const { asAlice, request } = await seedThread(ses);

    await expect(
      asAlice.user.emails.sendMessageNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: false, reason: "already_notified" });
    expect(ses).not.toHaveBeenCalled();
  });
});

describe("markMessagesAsRead marks only the other person's messages", () => {
  it("leaves the caller's own messages unread", async () => {
    const ses = newSes();
    const { alice, bob } = await seedPair();
    const asAlice = callerFor(alice.id, ses);
    const asBob = callerFor(bob.id, ses);
    const request = await asAlice.user.requests.create({
      toId: bob.id,
      message: "hi",
    });
    const fromBob = await asBob.user.messages.sendMessage({
      requestId: request.id,
      content: "hey",
    });
    const fromAlice = await asAlice.user.messages.sendMessage({
      requestId: request.id,
      content: "see you then",
    });

    // Alice names both. Only Bob's is hers to mark read.
    const result = await asAlice.user.messages.markMessagesAsRead({
      messageIds: [fromBob.id, fromAlice.id],
    });

    expect(result.count).toBe(1);
    const rows = await prisma.message.findMany({
      where: { id: { in: [fromBob.id, fromAlice.id] } },
      select: { id: true, isRead: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: fromBob.id, isRead: true },
        { id: fromAlice.id, isRead: false },
      ]),
    );
  });
});
