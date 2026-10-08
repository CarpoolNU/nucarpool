import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import {
  budgetWindowStart,
  claimEmailBudget,
  EMAILS_PER_BUDGET_WINDOW,
} from "../../db/emailBudget";
import type { Context } from "../context";

/**
 * `sendMessage` broadcasts over Pusher once the message is stored. Mocked so
 * this suite never fires a real event, as `notifications.db.test.ts` does.
 */
jest.mock("../../pusher", () => ({
  pusherServer: { trigger: jest.fn(async () => ({})) },
}));

// `jest.mock` is hoisted above imports, so the router picks up the mock.
import { appRouter } from "../index";

/**
 * The per-sender email budget, against a real MySQL. SCRUM-606.
 *
 * **Why a mocked suite could not establish this.** The risk isn't the
 * budget's arithmetic, it's *what the budget counts*: counting `Request` rows
 * would break because `requests.delete` hard-deletes them. Proving that needs
 * the count and the delete to be the same database, across three procedures
 * in two modules — `requests.create`, `emails.sendRequestNotification` and
 * `requests.delete`. A mocked prisma returns whatever the fake says, so the
 * loop would "pass" against a fake that simply chooses not to model the
 * delete. `email.test.ts` covers the branch logic; this covers the claim.
 *
 * **And the claim itself is a MySQL behaviour.** `claimEmailBudget` is an
 * `UPDATE ... WHERE send_count < cap` whose affected-row count is the
 * decision. Whether a spent budget reports zero rows depends on the statement
 * matching no row rather than writing an unchanged value — the distinction
 * `CLIENT_FOUND_ROWS` switches. Only a real server settles that, for the same
 * reason `updateMany is not a compare-and-swap` for the sibling writes in
 * `groups.ts` and `requests.ts`.
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

const callerFor = (userId: string, ses: jest.Mock) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma,
    sesClient: { send: ses },
  } as unknown as Context);

const newSes = () => jest.fn(async (_command: unknown) => ({ MessageId: "x" }));

const seedPair = async () => {
  const alice = await prisma.user.create({
    data: { name: "Alice", email: "alice@northeastern.edu" },
  });
  const bob = await prisma.user.create({
    data: { name: "Bob", email: "bob@northeastern.edu" },
  });
  return { alice, bob };
};

/** `send_count` for `userId` in the window `now` falls in, or 0 for no row. */
const spent = async (userId: string) => {
  const rows = await prisma.emailSendBudget.findMany({
    where: { userId, windowStart: budgetWindowStart(new Date()) },
  });
  return rows[0]?.sendCount ?? 0;
};

describe("the create -> notify -> delete loop no longer evades the budget", () => {
  /**
   * The reported attack, run for real.
   *
   * Each pass creates a request, sends its notification and withdraws it. The
   * withdrawal removes the `Request` row, so counting `Request` rows would
   * leave the count near one and let this loop run forever; counting sends
   * instead means each pass spends a send that the withdrawal cannot give
   * back.
   *
   * Runs one pass past the cap so the assertion is about the transition, not
   * just about the end state.
   */
  it("sends exactly the budget and then reports rate_limited", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const alices = callerFor(alice.id, ses);

    const reasons: (string | undefined)[] = [];

    for (let pass = 0; pass < EMAILS_PER_BUDGET_WINDOW + 1; pass++) {
      const request = await alices.user.requests.create({
        toId: bob.id,
        message: `pass ${pass}`,
      });
      const result = await alices.user.emails.sendRequestNotification({
        requestId: request.id,
      });
      reasons.push("reason" in result ? result.reason : undefined);
      await alices.user.requests.delete({ invitationId: request.id });
    }

    // The first `EMAILS_PER_BUDGET_WINDOW` passes send; the next does not.
    expect(reasons.slice(0, EMAILS_PER_BUDGET_WINDOW)).toEqual(
      Array(EMAILS_PER_BUDGET_WINDOW).fill(undefined),
    );
    expect(reasons[EMAILS_PER_BUDGET_WINDOW]).toBe("rate_limited");
    expect(ses).toHaveBeenCalledTimes(EMAILS_PER_BUDGET_WINDOW);
  });

  /**
   * The ticket asks for this one explicitly: deleting the request must not
   * give the send back. It is the single assertion that would fail if the
   * budget counted `Request` rows instead of sends.
   */
  it("does not give the send back when the request is deleted", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const alices = callerFor(alice.id, ses);

    const request = await alices.user.requests.create({
      toId: bob.id,
      message: "hello",
    });
    await alices.user.emails.sendRequestNotification({ requestId: request.id });
    expect(await spent(alice.id)).toBe(1);

    await alices.user.requests.delete({ invitationId: request.id });

    // The Request row is gone...
    expect(await prisma.request.findUnique({ where: { id: request.id } })).toBe(
      null,
    );
    // ...and the send is still spent.
    expect(await spent(alice.id)).toBe(1);
  });

  /**
   * AC 2. Withdrawing and resending is a real thing users do — they change
   * their mind, or fix a typo in the opening message — and it must keep
   * working. What it may not do is buy extra sends, so it is bounded by the
   * budget like everything else rather than blocked outright.
   */
  it("still lets a real user withdraw and resend inside the window", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();
    const alices = callerFor(alice.id, ses);

    for (let attempt = 0; attempt < 3; attempt++) {
      const request = await alices.user.requests.create({
        toId: bob.id,
        message: `attempt ${attempt}`,
      });
      await expect(
        alices.user.emails.sendRequestNotification({ requestId: request.id }),
      ).resolves.toEqual({ sent: true });
      await alices.user.requests.delete({ invitationId: request.id });
    }

    expect(ses).toHaveBeenCalledTimes(3);
    expect(await spent(alice.id)).toBe(3);
  });
});

describe("the budget is shared across user.emails.*", () => {
  /**
   * AC 3. The message path has the same hole for a different reason: its
   * cooldown is per conversation, and deleting a request takes the
   * conversation with it, so every new request would open a fresh bucket.
   * The shared budget is what closes that, so a spent budget must silence a
   * message notification even though its own cooldown has nothing to say.
   */
  /**
   * **Bob replies, not Alice, and that detail is the test.** The cooldown
   * counts the caller's *other* recent messages in the conversation, and
   * `requests.create` stores Alice's opening message — so if Alice were the
   * one notifying, the cooldown would refuse her with the same
   * `rate_limited` and this would pass with the budget removed entirely. Bob
   * has no earlier message in the thread, so his cooldown has nothing to say
   * and the budget is the only thing that can refuse him.
   */
  it("refuses a message notification once the budget is spent", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();

    const request = await callerFor(alice.id, ses).user.requests.create({
      toId: bob.id,
      message: "opening",
    });

    // Spend Bob's whole budget without going near the message path.
    await prisma.emailSendBudget.create({
      data: {
        userId: bob.id,
        windowStart: budgetWindowStart(new Date()),
        sendCount: EMAILS_PER_BUDGET_WINDOW,
      },
    });

    const bobs = callerFor(bob.id, ses);
    await bobs.user.messages.sendMessage({
      requestId: request.id,
      content: "Bob's first message in this thread",
    });

    await expect(
      bobs.user.emails.sendMessageNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: false, reason: "rate_limited" });
    expect(ses).not.toHaveBeenCalled();
  });

  /**
   * The control for the test above: the same setup with an unspent budget
   * must send. Without this, "refuses" could be the cooldown, a missing
   * marker or any other refusal wearing the same reason string.
   */
  it("sends that same message notification when the budget is intact", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();

    const request = await callerFor(alice.id, ses).user.requests.create({
      toId: bob.id,
      message: "opening",
    });

    const bobs = callerFor(bob.id, ses);
    await bobs.user.messages.sendMessage({
      requestId: request.id,
      content: "Bob's first message in this thread",
    });

    await expect(
      bobs.user.emails.sendMessageNotification({ requestId: request.id }),
    ).resolves.toEqual({ sent: true });
    expect(await spent(bob.id)).toBe(1);
  });

  it("leaves one sender's budget alone when another spends theirs", async () => {
    const { alice, bob } = await seedPair();
    const ses = newSes();

    await prisma.emailSendBudget.create({
      data: {
        userId: bob.id,
        windowStart: budgetWindowStart(new Date()),
        sendCount: EMAILS_PER_BUDGET_WINDOW,
      },
    });

    const request = await callerFor(alice.id, ses).user.requests.create({
      toId: bob.id,
      message: "hello",
    });
    await expect(
      callerFor(alice.id, ses).user.emails.sendRequestNotification({
        requestId: request.id,
      }),
    ).resolves.toEqual({ sent: true });

    expect(await spent(bob.id)).toBe(EMAILS_PER_BUDGET_WINDOW);
  });
});

describe("claimEmailBudget is a compare-and-swap", () => {
  const WINDOW = () => budgetWindowStart(new Date());

  /**
   * The behaviour the whole design rests on, asserted against the real server
   * rather than assumed: a claim at the cap must report that it changed
   * nothing. Written as a direct call because the procedures above cannot
   * distinguish "refused" from "refused for some other reason".
   */
  it("admits exactly the cap and then refuses, sequentially", async () => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < EMAILS_PER_BUDGET_WINDOW + 3; i++) {
      outcomes.push((await claimEmailBudget(prisma, "seq-user")).claimed);
    }

    expect(outcomes.filter(Boolean)).toHaveLength(EMAILS_PER_BUDGET_WINDOW);
    // The refusals are the tail, not scattered through.
    expect(outcomes.slice(EMAILS_PER_BUDGET_WINDOW)).toEqual([
      false,
      false,
      false,
    ]);
  });

  /**
   * The race. `updateMany` would let every one of these through: under
   * `relationMode = "prisma"` it reads the matching ids first and then updates
   * by id, so each caller reads the row before any of them increments it and
   * all report `count: 1`. A single `UPDATE` serialises on the row lock, so
   * each waits, re-reads, and only the first `cap` of them match.
   *
   * Run with far more callers than the cap so an off-by-one cannot hide.
   */
  it("admits exactly the cap when many callers race", async () => {
    const attempts = EMAILS_PER_BUDGET_WINDOW * 3;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        claimEmailBudget(prisma, "race-user"),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(
      EMAILS_PER_BUDGET_WINDOW,
    );

    const rows = await prisma.emailSendBudget.findMany({
      where: { userId: "race-user" },
    });
    // One bucket, holding exactly the cap. Not cap + overshoot, and not two
    // rows from concurrent inserts racing on the primary key.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sendCount).toBe(EMAILS_PER_BUDGET_WINDOW);
  });

  it("gives a send back on refund, and never drops below zero", async () => {
    const claim = await claimEmailBudget(prisma, "refund-user");
    expect(claim.claimed).toBe(true);
    expect(await spent("refund-user")).toBe(1);

    await claim.refund();
    expect(await spent("refund-user")).toBe(0);

    // A second refund must not create a free send for later in the window.
    await claim.refund();
    expect(await spent("refund-user")).toBe(0);
  });

  it("counts each window separately", async () => {
    const now = new Date();
    const anHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    await prisma.emailSendBudget.create({
      data: {
        userId: "window-user",
        windowStart: budgetWindowStart(anHourAgo),
        sendCount: EMAILS_PER_BUDGET_WINDOW,
      },
    });

    // Last window is spent; this one is untouched.
    await expect(
      claimEmailBudget(prisma, "window-user", now).then((c) => c.claimed),
    ).resolves.toBe(true);
    expect(await spent("window-user")).toBe(1);
  });

  it("floors a window to the window length", () => {
    const start = budgetWindowStart(new Date("2026-09-30T14:37:12.345Z"));
    expect(start.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(WINDOW().getTime() % (60 * 60 * 1000)).toBe(0);
  });
});
