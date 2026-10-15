import {
  ReportReason,
  ReportStatus,
  Role,
  Status,
  RequestStatus,
} from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";
import { pairingRetentionCutoff } from "../../db/carpoolPairing";

/**
 * Reporting a former groupmate, against a real MySQL (SCRUM-623).
 *
 * `carpoolPairings.test.ts` pins the query's rules on a mocked Prisma, and
 * that is where the window, the dedupe and the payload shape are asserted.
 * This file exists for the one property a fake cannot reproduce honestly:
 * **the behaviour after the rows are actually deleted.**
 *
 * The whole premise of this ticket is that by the time someone wants to
 * report a person they rode with, every row that used to connect them is
 * gone - the `CarpoolGroup`, the `carpoolId`, the `ACCEPTED` request and the
 * conversation with its messages. A mocked Prisma deletes nothing and
 * emulates no relation, so it can only show that the procedure reads a list
 * someone handed it. Only a real database can show that the list still exists
 * when everything it describes does not, and that a report filed from it
 * lands.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

const callerFor = (userId: string) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

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

const FORMED_AT = new Date("2026-02-03T08:30:00.000Z");

const seedGroupedDriver = async (
  name: string,
  email: string,
  seatsAvail: number,
) => {
  const driver = await seedUser(name, email, { role: Role.DRIVER, seatsAvail });
  const group = await prisma.carpoolGroup.create({
    data: { dateCreated: FORMED_AT },
  });
  await prisma.carpoolSearch.update({
    where: { id: driver.search.id },
    data: { carpoolId: group.id },
  });
  return { ...driver, group };
};

const seedRider = (
  name: string,
  email: string,
  carpoolId: string | null = null,
) => seedUser(name, email, { role: Role.RIDER, seatsAvail: 0, carpoolId });

const seedAcceptedRequestWithConversation = async (
  fromUserId: string,
  toUserId: string,
) => {
  const request = await prisma.request.create({
    data: {
      message: "Want to carpool?",
      fromUserId,
      toUserId,
      status: RequestStatus.ACCEPTED,
    },
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
      conversationId: conversation.id,
      userId: fromUserId,
      content: "See you at 8.",
    },
  });
  return { request, conversation };
};

/**
 * A driver and a rider who carpooled and have since parted, with every trace
 * of the arrangement deleted - the group by `groups.delete`, and the request
 * and conversation by the rider, which the app allows once the pair is no
 * longer grouped.
 *
 * This is the state the whole ticket is about, so it is built once here
 * rather than repeated per test.
 */
const seedPartedPair = async (slug: string) => {
  const driver = await seedGroupedDriver(
    `Driver ${slug}`,
    `past-driver-${slug}@northeastern.edu`,
    1,
  );
  const rider = await seedRider(
    `Rider ${slug}`,
    `past-rider-${slug}@northeastern.edu`,
    driver.group.id,
  );
  const { request, conversation } = await seedAcceptedRequestWithConversation(
    rider.user.id,
    driver.user.id,
  );

  await callerFor(driver.user.id).user.groups.delete({
    groupId: driver.group.id,
  });
  await callerFor(rider.user.id).user.requests.delete({
    invitationId: request.id,
  });

  return { driver, rider, request, conversation };
};

describe("user.carpoolPairings.me after everything else is deleted", () => {
  it("still lists the counterpart once the group, request and conversation are gone", async () => {
    const { driver, rider, request, conversation } =
      await seedPartedPair("listed");

    // The premise, asserted rather than assumed: there is nothing else left
    // that could have produced this list.
    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).toBeNull();
    expect(
      await prisma.request.findUnique({ where: { id: request.id } }),
    ).toBeNull();
    expect(
      await prisma.conversation.findUnique({ where: { id: conversation.id } }),
    ).toBeNull();

    const listed = await callerFor(rider.user.id).user.carpoolPairings.me();

    expect(listed).toEqual([
      {
        userId: driver.user.id,
        name: "Driver listed",
        endedAt: expect.any(Date),
      },
    ]);
  });

  /**
   * AC #2, and the reason this ticket exists: the report has to actually be
   * fileable, not merely the button rendered.
   */
  it("lets the rider report that counterpart, with no conversation to attach", async () => {
    const { driver, rider } = await seedPartedPair("report");

    const [connection] = await callerFor(
      rider.user.id,
    ).user.carpoolPairings.me();

    // `HARASSMENT` rather than `SAFETY_CONCERN`: the latter is the one reason
    // `REPORT_URGENCY` marks IMMEDIATE, which mails every admin. The mail
    // client is a stub here, but the digest path is the one that needs no
    // stub to be correct.
    await callerFor(rider.user.id).user.reports.create({
      reportedUserId: connection.userId,
      reason: ReportReason.HARASSMENT,
      message: "Noticed after the carpool ended.",
      alsoBlock: false,
    });

    const reports = await prisma.report.findMany({
      where: { reporterId: rider.user.id },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].reportedUserId).toBe(driver.user.id);
    expect(reports[0].status).toBe(ReportStatus.OPEN);
    // No conversation survived to snapshot, and that is allowed rather than
    // an error: `requestId` is optional on `reports.create`.
    expect(reports[0].requestId).toBeNull();
    expect(reports[0].conversationSnapshot).toBeNull();
  });

  /**
   * AC #3. The pairing row names two users, and either of them reading it is
   * reading their own history. Nobody else is.
   */
  it("shows a pairing to its two participants and to nobody else", async () => {
    const { driver, rider } = await seedPartedPair("scoped");
    const stranger = await seedRider(
      "Stranger Sam",
      "past-stranger@northeastern.edu",
    );

    const riderSees = await callerFor(rider.user.id).user.carpoolPairings.me();
    const driverSees = await callerFor(
      driver.user.id,
    ).user.carpoolPairings.me();
    const strangerSees = await callerFor(
      stranger.user.id,
    ).user.carpoolPairings.me();

    expect(riderSees.map((row) => row.userId)).toEqual([driver.user.id]);
    expect(driverSees.map((row) => row.userId)).toEqual([rider.user.id]);
    expect(strangerSees).toEqual([]);
  });

  /**
   * The deliberate exception to the block rule, decided on this ticket.
   *
   * Every other multi-user surface excludes `blockedCounterpartIds`. This one
   * does not, because filtering here would mean someone could harass a
   * passenger, block them, and become unreportable - the very defect the
   * ticket exists to close. A real database is the honest place to assert it,
   * since the block is a real row the query simply never consults.
   */
  it("keeps listing a counterpart the caller has blocked", async () => {
    const { driver, rider } = await seedPartedPair("blocked");

    await callerFor(rider.user.id).user.blocks.block({
      userId: driver.user.id,
    });

    const listed = await callerFor(rider.user.id).user.carpoolPairings.me();
    expect(listed.map((row) => row.userId)).toEqual([driver.user.id]);
  });

  it("keeps listing a counterpart who has blocked the caller", async () => {
    const { driver, rider } = await seedPartedPair("blocked-by");

    await callerFor(driver.user.id).user.blocks.block({
      userId: rider.user.id,
    });

    const listed = await callerFor(rider.user.id).user.carpoolPairings.me();
    expect(listed.map((row) => row.userId)).toEqual([driver.user.id]);
  });

  /**
   * The retention window against the real column rather than a fake's
   * filter. The row is aged past the cutoff by writing `endedAt` directly,
   * which is what the passage of time would have done to it.
   */
  it("stops listing a pairing once it falls outside the retention window", async () => {
    const { rider } = await seedPartedPair("expired");

    const expired = new Date(pairingRetentionCutoff(new Date()).getTime() - 1);
    await prisma.carpoolPairing.updateMany({
      where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      data: { endedAt: expired },
    });

    expect(await callerFor(rider.user.id).user.carpoolPairings.me()).toEqual(
      [],
    );
    // The row is still there - this list hides it, and only
    // `scripts/expire-carpool-pairings.ts` deletes it.
    expect(
      await prisma.carpoolPairing.count({
        where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      }),
    ).toBe(1);
  });
});
