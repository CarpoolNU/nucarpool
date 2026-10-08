import { Prisma, Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * `user.requests.delete` must not destroy the request behind a live carpool,
 * however the two writers interleave.
 *
 * The guard that refuses a currently-carpooling pair is correct, and every
 * read it depends on is taken outside the transaction: the request row with
 * `ctx.prisma.request.findUnique`, and the two `carpoolSearch` rows with
 * `ctx.prisma.carpoolSearch.findMany`. The delete itself then matched on the
 * primary key and nothing else. Sequence a withdrawal against an accept and
 * the guard simply is not consulted about the state that actually exists at
 * commit time: the request is deleted, and the `Conversation` and every
 * `Message` go with it - exactly the loss the guard exists to prevent,
 * reached by timing.
 *
 * The guard asks about group membership **and nothing else**. Gating it on
 * membership *and* an ACCEPTED status would reopen a second hole beside the
 * timing one: two riders in a group could keep whatever request they had
 * between them, because an acceptance resolves only the driver's row, so a
 * PENDING request would never reach the group lookup on either side. The
 * cases below cover both routes into that state - seeded directly, and raced.
 *
 * The same defect class as the writes made compare-and-swaps earlier, and it
 * needs the same kind of proof. `requests.test.ts` drives the new predicate
 * directly and does, but a mocked Prisma has no isolation level: it cannot
 * produce a stale snapshot, and it cannot say whether MySQL accepts the
 * statement at all. Only a real MySQL at REPEATABLE READ can.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

const callerFor = (userId: string, client: typeof prisma = prisma) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: client,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/**
 * A client whose next interactive transaction takes its REPEATABLE READ
 * snapshot, lets `interleaved` run to completion, and only then runs the
 * procedure's own logic. The same device `seatAccountingRace.db.test.ts`
 * uses, and for the same reason: forcing the ordering rather than racing for
 * it is what makes the test deterministic, where a coin-flip race passes half
 * the time by taking the branch that was never broken.
 *
 * Here it does double duty. `requests.delete`'s guard reads are taken outside
 * the transaction and have already happened by the time this runs, so the
 * interleaved accept lands in the real window. The plain read before it then
 * pins a read view that predates that accept, so the `DELETE` is being asked
 * the harder question too: whether it matches the current committed row or
 * this transaction's stale snapshot.
 *
 * The snapshot is taken with a plain, non-locking read, so `interleaved`
 * cannot deadlock against it: nothing is locked yet.
 */
const buildDelayedClient = (
  client: typeof prisma,
  interleaved: () => Promise<unknown>,
) => {
  let alreadyRun = false;

  return new Proxy(client, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property);
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM carpool_search LIMIT 1`;
          if (!alreadyRun) {
            alreadyRun = true;
            await interleaved();
          }
          return fn(tx);
        });
    },
  }) as typeof client;
};

const seedLocation = async (streetAddress: string) =>
  prisma.location.create({
    data: {
      city: "Boston",
      state: "MA",
      street: streetAddress,
      streetAddress,
      coordLng: -71.05,
      coordLat: 42.36,
    },
  });

const seedUser = async (
  name: string,
  email: string,
  search: { role: Role; seatsAvail: number; carpoolId?: string | null },
) => {
  const user = await prisma.user.create({ data: { name, email } });
  const home = await seedLocation(`${email} home`);
  const company = await seedLocation(`${email} work`);
  const carpoolSearch = await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: search.role,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: search.seatsAvail,
      carpoolId: search.carpoolId ?? null,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return { user, search: carpoolSearch };
};

/**
 * A request with the conversation and message the real `create` writes, so
 * the thing at risk is present rather than assumed. `Request.conversationId`
 * is set as well as `Conversation.requestId`, because the schema stores the
 * link twice and `conversationsToDeleteWith` reads both.
 */
const seedRequestWithThread = async (
  fromUserId: string,
  toUserId: string,
  status: RequestStatus = RequestStatus.PENDING,
) => {
  const request = await prisma.request.create({
    data: { message: "Want to carpool?", fromUserId, toUserId, status },
  });
  const conversation = await prisma.conversation.create({
    data: { requestId: request.id },
  });
  await prisma.request.update({
    where: { id: request.id },
    data: { conversationId: conversation.id },
  });
  await prisma.message.create({
    data: {
      content: "see you at 8",
      userId: fromUserId,
      conversationId: conversation.id,
    },
  });
  return { request, conversation };
};

const requestById = (id: string) =>
  prisma.request.findUnique({ where: { id } });

const messageCount = () => prisma.message.count();
const conversationCount = () => prisma.conversation.count();

describe("requests.delete against a concurrent accept", () => {
  /**
   * The ticket's sequence, end to end. The rider withdraws; the driver
   * accepts in the window; the withdrawal must not win.
   *
   * A delete that matched on the primary key alone would remove the request
   * the new group is built on and take the thread with it, leaving the group
   * surviving with nothing behind it - which `connectAction` and
   * `requests.create`'s reopen branch both read.
   */
  it("refuses a withdrawal whose accept committed after the guard's reads", async () => {
    const driver = await seedUser(
      "Driver Dana",
      "driver-dana@northeastern.edu",
      { role: Role.DRIVER, seatsAvail: 3 },
    );
    const rider = await seedUser("Rider Remy", "rider-remy@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const { request } = await seedRequestWithThread(
      rider.user.id,
      driver.user.id,
    );

    const accept = () =>
      callerFor(driver.user.id).user.groups.create({
        driverId: driver.user.id,
        riderId: rider.user.id,
      });

    await expect(
      callerFor(
        rider.user.id,
        buildDelayedClient(prisma, accept),
      ).user.requests.delete({ invitationId: request.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The request behind the live carpool, and the thread on it, both survive.
    const surviving = await requestById(request.id);
    expect(surviving).toMatchObject({ status: RequestStatus.ACCEPTED });
    expect(await conversationCount()).toBe(1);
    expect(await messageCount()).toBe(1);

    // And the group the accept built is intact, rather than left dangling.
    const riderSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: rider.user.id },
    });
    expect(riderSearch?.carpoolId).not.toBeNull();
  });

  /**
   * The same interleaving with no group at the end of it.
   *
   * The condition is grouped-and-nothing-else in SQL for the reason it is in
   * JavaScript, and this is the half that keeps it honest in the other
   * direction: refusing on status would strand a pair who have parted, and a
   * raced accept that produced no membership is not a carpool to protect.
   * Without this case the statement could be "refuse anything accepted" and
   * every other test here would still pass.
   */
  it("deletes an accepted request whose pair are not in a group together", async () => {
    const sender = await seedUser("Sender Sam", "sender-sam@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const recipient = await seedUser(
      "Recipient Ren",
      "recipient-ren@northeastern.edu",
      { role: Role.DRIVER, seatsAvail: 3 },
    );
    const { request } = await seedRequestWithThread(
      sender.user.id,
      recipient.user.id,
      RequestStatus.ACCEPTED,
    );

    await callerFor(sender.user.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(await requestById(request.id)).toBeNull();
    expect(await conversationCount()).toBe(0);
    expect(await messageCount()).toBe(0);
  });

  /**
   * The ordinary path, which is the common one by a long way and must be
   * unchanged: a PENDING withdrawal takes the request, the conversation and
   * every message with it, in one transaction.
   */
  it("still withdraws a pending request and cleans up its thread", async () => {
    const sender = await seedUser("Sender Sky", "sender-sky@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const recipient = await seedUser(
      "Recipient Rae",
      "recipient-rae@northeastern.edu",
      { role: Role.DRIVER, seatsAvail: 3 },
    );
    const { request } = await seedRequestWithThread(
      sender.user.id,
      recipient.user.id,
    );

    await callerFor(sender.user.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(await requestById(request.id)).toBeNull();
    expect(await conversationCount()).toBe(0);
    expect(await messageCount()).toBe(0);
  });

  /**
   * The second loser of the zero-match branch, and the reason it re-reads
   * with `FOR SHARE` rather than assuming the guard fired.
   *
   * A plain `findUnique` here would be served from this transaction's
   * snapshot - taken before the other participant's delete committed - and
   * would report the row still present, turning an ordinary double-clear into
   * a CONFLICT claiming a carpool that does not exist. The locking read is
   * what makes this case answerable at all, and only a real MySQL can tell
   * the two apart.
   */
  it("succeeds quietly when the other participant cleared the same request", async () => {
    const sender = await seedUser("Sender Sol", "sender-sol@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const recipient = await seedUser(
      "Recipient Rio",
      "recipient-rio@northeastern.edu",
      { role: Role.DRIVER, seatsAvail: 3 },
    );
    const { request } = await seedRequestWithThread(
      sender.user.id,
      recipient.user.id,
    );

    const decline = () =>
      callerFor(recipient.user.id).user.requests.delete({
        invitationId: request.id,
      });

    await expect(
      callerFor(
        sender.user.id,
        buildDelayedClient(prisma, decline),
      ).user.requests.delete({ invitationId: request.id }),
    ).resolves.toBeUndefined();

    expect(await requestById(request.id)).toBeNull();
    expect(await conversationCount()).toBe(0);
    expect(await messageCount()).toBe(0);
  });

  /**
   * Two riders in one group, with a PENDING request between them.
   *
   * This is the state that shows status-gating to be the wrong question:
   * `markRequestAccepted` resolves only the row between the driver and the
   * joining rider, so a group of one driver and two riders leaves the two
   * riders carpooling together with whatever request they already had
   * between them - and that request carries their conversation. A guard
   * gated on `status = ACCEPTED`, on either the read side or inside the
   * `DELETE`, would never ask whether the two were grouped, so either of
   * them could delete the thread outright.
   *
   * Against a real MySQL rather than the mock because the predicate being
   * widened lives in a raw `DELETE`, and a `WHERE` the mock agrees with is
   * not evidence that MySQL evaluates it the same way.
   */
  it("refuses a PENDING request between two riders who share a group", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });
    // The driver is seeded because a group of two riders and nobody driving
    // is not the state being described, even though the guard never reads
    // them: it compares the two parties' `carpoolId` and nothing else.
    await seedUser("Driver Del", "driver-del@northeastern.edu", {
      role: Role.DRIVER,
      seatsAvail: 1,
      carpoolId: group.id,
    });
    const riderOne = await seedUser(
      "Rider Robin",
      "rider-robin@northeastern.edu",
      { role: Role.RIDER, seatsAvail: 0, carpoolId: group.id },
    );
    const riderTwo = await seedUser("Rider Rue", "rider-rue@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: group.id,
    });

    // Between the two riders, not involving the driver at all - which is
    // precisely why accepting the driver's requests left it PENDING.
    const { request } = await seedRequestWithThread(
      riderOne.user.id,
      riderTwo.user.id,
    );

    await expect(
      callerFor(riderOne.user.id).user.requests.delete({
        invitationId: request.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await requestById(request.id)).not.toBeNull();
    expect(await conversationCount()).toBe(1);
    expect(await messageCount()).toBe(1);

    // Either party could have destroyed it, so the refusal has to hold from
    // both directions.
    await expect(
      callerFor(riderTwo.user.id).user.requests.delete({
        invitationId: request.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await messageCount()).toBe(1);
  });

  /**
   * The same state reached by timing, which is what this file exists for.
   *
   * The withdrawing rider's guard reads are taken before the transaction
   * opens and see the other rider ungrouped, so the pre-transaction check
   * passes honestly. The join then commits in the window, and by the time the
   * `DELETE` runs the two are co-members. Only the statement's own `WHERE`
   * can refuse at that point - a predicate gated on ACCEPTED could not, since
   * the row here is PENDING.
   *
   * `groups.edit` with `add: true` rather than `groups.create`: the second
   * rider joins a group the driver already has, which is the real path into
   * the two-rider state and the one `create` cannot produce, since it demands
   * an ungrouped driver.
   */
  it("refuses a PENDING withdrawal whose co-rider joined in the window", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });
    const driver = await seedUser("Driver Dru", "driver-dru@northeastern.edu", {
      role: Role.DRIVER,
      seatsAvail: 3,
      carpoolId: group.id,
    });
    const settled = await seedUser(
      "Rider Reese",
      "rider-reese@northeastern.edu",
      { role: Role.RIDER, seatsAvail: 0, carpoolId: group.id },
    );
    const joining = await seedUser(
      "Rider Rory",
      "rider-rory@northeastern.edu",
      {
        role: Role.RIDER,
        seatsAvail: 0,
      },
    );

    // The invitation the joining rider is about to accept.
    await prisma.request.create({
      data: {
        message: "room for one more",
        fromUserId: driver.user.id,
        toUserId: joining.user.id,
        status: RequestStatus.PENDING,
      },
    });

    // The thread at risk: between the two riders, from before either joined.
    const { request } = await seedRequestWithThread(
      settled.user.id,
      joining.user.id,
    );

    const join = () =>
      callerFor(joining.user.id).user.groups.edit({
        driverId: driver.user.id,
        riderId: joining.user.id,
        groupId: group.id,
        add: true,
      });

    await expect(
      callerFor(
        settled.user.id,
        buildDelayedClient(prisma, join),
      ).user.requests.delete({ invitationId: request.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await requestById(request.id)).not.toBeNull();
    expect(await conversationCount()).toBe(1);
    expect(await messageCount()).toBe(1);

    // The join that raced it is intact, rather than rolled back by the
    // refusal it caused.
    const joiningSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: joining.user.id },
    });
    expect(joiningSearch?.carpoolId).toBe(group.id);
  });

  /**
   * The control for the two above, and the common path: a PENDING withdrawal
   * between two people who are *not* co-members still succeeds and still
   * takes the thread with it.
   *
   * Without it, "refuse every PENDING request" would pass both cases above.
   * One of the two is in a group here, so this also pins that the guard
   * compares the pair's groups rather than asking whether either of them is
   * in one.
   */
  it("still withdraws a PENDING request when only one of the pair is grouped", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });
    const grouped = await seedUser(
      "Rider Quinn",
      "rider-quinn@northeastern.edu",
      { role: Role.RIDER, seatsAvail: 0, carpoolId: group.id },
    );
    const loner = await seedUser("Rider Lane", "rider-lane@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const { request } = await seedRequestWithThread(
      grouped.user.id,
      loner.user.id,
    );

    await callerFor(grouped.user.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(await requestById(request.id)).toBeNull();
    expect(await conversationCount()).toBe(0);
    expect(await messageCount()).toBe(0);
  });

  /**
   * The self-request exemption, in SQL. `fromUserId` <> `toUserId` is what
   * keeps the EXISTS from comparing one user's group against their own and
   * matching whenever they are in any group at all - which would make these
   * rows unclearable at the statement level even though the guard above
   * deliberately lets them through. Two exist in production, one ACCEPTED
   * with its owner in a real group.
   */
  it.each(Object.values(RequestStatus))(
    "clears a self-request from a user who is in a group — %s",
    async (status) => {
      // Every status is exercised here, since the guard is not gated on one.
      // Without `fromUserId` <> `toUserId`, a self-request in any status
      // would reach the degenerate EXISTS comparison; that clause is the
      // only thing holding this open.
      const group = await prisma.carpoolGroup.create({ data: {} });
      const owner = await seedUser("Owner Ola", "owner-ola@northeastern.edu", {
        role: Role.DRIVER,
        seatsAvail: 2,
        carpoolId: group.id,
      });
      const { request } = await seedRequestWithThread(
        owner.user.id,
        owner.user.id,
        status,
      );

      await callerFor(owner.user.id).user.requests.delete({
        invitationId: request.id,
      });

      expect(await requestById(request.id)).toBeNull();
      expect(await conversationCount()).toBe(0);
    },
  );
});
