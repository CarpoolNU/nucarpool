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
import { contactRetentionCutoff } from "../../db/messageContact";

/**
 * Reporting a former groupmate, against a real MySQL (SCRUM-623).
 *
 * `pastConnections.test.ts` pins the query's rules on a mocked Prisma, and
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

describe("user.pastConnections.me after everything else is deleted", () => {
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

    const listed = await callerFor(rider.user.id).user.pastConnections.me();

    expect(listed).toEqual([
      {
        userId: driver.user.id,
        name: "Driver listed",
        endedAt: expect.any(Date),
        kind: "CARPOOLED",
      },
    ]);
  });

  /**
   * These two carpooled **and** corresponded, so both records hold a row for
   * them — the deletion of the request in `seedPartedPair` writes a
   * `MessageContact` as well as the `CarpoolPairing` the teardown wrote.
   *
   * The merge has to collapse that to one entry, and it has to be the carpool
   * one. Worth asserting against a real database rather than only in the
   * mocked test, because here the second row arrives as a genuine side effect
   * of the delete rather than as a fixture somebody wrote down.
   */
  it("records both kinds for a pair who carpooled and corresponded, and lists one", async () => {
    const { driver, rider } = await seedPartedPair("both");

    expect(
      await prisma.carpoolPairing.count({
        where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      }),
    ).toBe(1);
    expect(
      await prisma.messageContact.count({
        where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      }),
    ).toBe(1);

    const listed = await callerFor(rider.user.id).user.pastConnections.me();

    expect(listed).toEqual([
      {
        userId: driver.user.id,
        name: "Driver both",
        endedAt: expect.any(Date),
        kind: "CARPOOLED",
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
    ).user.pastConnections.me();

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

    const riderSees = await callerFor(rider.user.id).user.pastConnections.me();
    const driverSees = await callerFor(
      driver.user.id,
    ).user.pastConnections.me();
    const strangerSees = await callerFor(
      stranger.user.id,
    ).user.pastConnections.me();

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

    const listed = await callerFor(rider.user.id).user.pastConnections.me();
    expect(listed.map((row) => row.userId)).toEqual([driver.user.id]);
  });

  it("keeps listing a counterpart who has blocked the caller", async () => {
    const { driver, rider } = await seedPartedPair("blocked-by");

    await callerFor(driver.user.id).user.blocks.block({
      userId: rider.user.id,
    });

    const listed = await callerFor(rider.user.id).user.pastConnections.me();
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
    // **Both records have to be aged, not just the pairing.** These two
    // corresponded as well as carpooled, so deleting the request wrote a
    // `MessageContact` too; ageing only the pairing would leave the
    // counterpart listed as MESSAGED and this assertion would be measuring
    // the wrong thing. The case where exactly one of the two has expired is
    // its own test below.
    await prisma.messageContact.updateMany({
      where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      data: {
        endedAt: new Date(contactRetentionCutoff(new Date()).getTime() - 1),
      },
    });

    expect(await callerFor(rider.user.id).user.pastConnections.me()).toEqual(
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

  /**
   * The two windows are independent, and a counterpart can fall out of one
   * while staying inside the other.
   *
   * The entry then changes kind rather than disappearing, which is correct:
   * the record of the shared ride has expired, the record of the
   * correspondence has not, and the reader can still act on the person the
   * second record names.
   */
  it("falls back to the messaged entry when only the pairing has expired", async () => {
    const { driver, rider } = await seedPartedPair("half-expired");

    await prisma.carpoolPairing.updateMany({
      where: { OR: [{ userAId: rider.user.id }, { userBId: rider.user.id }] },
      data: {
        endedAt: new Date(pairingRetentionCutoff(new Date()).getTime() - 1),
      },
    });

    const listed = await callerFor(rider.user.id).user.pastConnections.me();

    expect(listed).toEqual([
      {
        userId: driver.user.id,
        name: "Driver half-expired",
        endedAt: expect.any(Date),
        kind: "MESSAGED",
      },
    ]);
  });
});

/**
 * **The gap this ticket exists to close (SCRUM-676).**
 *
 * Two users exchange a request and messages, never form a carpool, and then
 * either party deletes the request. `requests.delete` takes the conversation
 * and every message with it, and no `CarpoolPairing` row is written because
 * they never shared a group - so before this record, nothing durable said the
 * two had ever interacted, and there was no `userId` for `reports.create` or
 * `blocks.block` to receive.
 *
 * A real database is the only honest place to assert this: the premise is
 * entirely about which rows survive a delete, which a fake cannot reproduce.
 */
describe("user.pastConnections.me for a pair who only ever messaged", () => {
  /**
   * A pair who corresponded and never carpooled, with the request then
   * deleted by the party named in `deletedBy`.
   *
   * Both parties are seeded ungrouped, so nothing here can produce a
   * `CarpoolPairing` - the tests below assert that, rather than assuming it.
   */
  const seedCorrespondedPair = async (
    slug: string,
    deletedBy: "sender" | "recipient" = "sender",
  ) => {
    const sender = await seedRider(
      `Sender ${slug}`,
      `msg-sender-${slug}@northeastern.edu`,
    );
    const recipient = await seedRider(
      `Recipient ${slug}`,
      `msg-recipient-${slug}@northeastern.edu`,
    );

    const request = await prisma.request.create({
      data: {
        message: "Are you driving this term?",
        fromUserId: sender.user.id,
        toUserId: recipient.user.id,
        status: RequestStatus.PENDING,
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
        userId: sender.user.id,
        content: "Are you driving this term?",
      },
    });

    await callerFor(
      deletedBy === "sender" ? sender.user.id : recipient.user.id,
    ).user.requests.delete({ invitationId: request.id });

    return { sender, recipient, request, conversation };
  };

  it("lists the counterpart although no carpool pairing exists", async () => {
    const { sender, recipient, request, conversation } =
      await seedCorrespondedPair("listed");

    // The premise, asserted rather than assumed.
    expect(
      await prisma.request.findUnique({ where: { id: request.id } }),
    ).toBeNull();
    expect(
      await prisma.conversation.findUnique({ where: { id: conversation.id } }),
    ).toBeNull();
    expect(
      await prisma.carpoolPairing.count({
        where: {
          OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
        },
      }),
    ).toBe(0);

    const listed = await callerFor(recipient.user.id).user.pastConnections.me();

    expect(listed).toEqual([
      {
        userId: sender.user.id,
        name: "Sender listed",
        endedAt: expect.any(Date),
        kind: "MESSAGED",
      },
    ]);
  });

  /**
   * The specific scenario the ticket names: *"the person who sent them can
   * delete the request themselves, which removes the evidence and the only
   * route to reporting them."*
   */
  it("still reaches the sender when the sender is the one who deleted", async () => {
    const { sender, recipient } = await seedCorrespondedPair(
      "sender-deleted",
      "sender",
    );

    const listed = await callerFor(recipient.user.id).user.pastConnections.me();

    expect(listed.map((row) => row.userId)).toEqual([sender.user.id]);
  });

  it("records the pair once whichever party deletes", async () => {
    const { sender } = await seedCorrespondedPair(
      "recipient-deleted",
      "recipient",
    );

    expect(
      await prisma.messageContact.count({
        where: {
          OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
        },
      }),
    ).toBe(1);
  });

  /** AC #2, end to end: the report has to actually file. */
  it("lets the recipient report that counterpart after the request is gone", async () => {
    const { sender, recipient } = await seedCorrespondedPair("report");

    const [connection] = await callerFor(
      recipient.user.id,
    ).user.pastConnections.me();

    await callerFor(recipient.user.id).user.reports.create({
      reportedUserId: connection.userId,
      reason: ReportReason.HARASSMENT,
      message: "Messages were abusive; they then deleted the request.",
      alsoBlock: false,
    });

    const reports = await prisma.report.findMany({
      where: { reporterId: recipient.user.id },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].reportedUserId).toBe(sender.user.id);
    expect(reports[0].status).toBe(ReportStatus.OPEN);
    // No conversation survived to snapshot, which `reports.create` allows.
    expect(reports[0].requestId).toBeNull();
    expect(reports[0].conversationSnapshot).toBeNull();
  });

  it("lets the recipient block that counterpart after the request is gone", async () => {
    const { sender, recipient } = await seedCorrespondedPair("block");

    const [connection] = await callerFor(
      recipient.user.id,
    ).user.pastConnections.me();

    await callerFor(recipient.user.id).user.blocks.block({
      userId: connection.userId,
    });

    expect(
      await prisma.block.count({
        where: { blockerId: recipient.user.id, blockedId: sender.user.id },
      }),
    ).toBe(1);
  });

  /** AC #3: the record names two users and nobody else may read it. */
  it("shows the contact to its two participants and to nobody else", async () => {
    const { sender, recipient } = await seedCorrespondedPair("scoped");
    const stranger = await seedRider(
      "Stranger Sidney",
      "msg-stranger@northeastern.edu",
    );

    expect(
      (await callerFor(recipient.user.id).user.pastConnections.me()).map(
        (row) => row.userId,
      ),
    ).toEqual([sender.user.id]);
    expect(
      (await callerFor(sender.user.id).user.pastConnections.me()).map(
        (row) => row.userId,
      ),
    ).toEqual([recipient.user.id]);
    expect(await callerFor(stranger.user.id).user.pastConnections.me()).toEqual(
      [],
    );
  });

  /** The block exception, carried over from SCRUM-623 deliberately. */
  it("keeps listing a counterpart the caller has blocked", async () => {
    const { sender, recipient } = await seedCorrespondedPair("blocked");

    await callerFor(recipient.user.id).user.blocks.block({
      userId: sender.user.id,
    });

    expect(
      (await callerFor(recipient.user.id).user.pastConnections.me()).map(
        (row) => row.userId,
      ),
    ).toEqual([sender.user.id]);
  });

  /**
   * The unique index doing its job against a real MySQL.
   *
   * The same pair requesting and deleting repeatedly must not accumulate
   * rows - that bounding property is the reason this record upserts where
   * `CarpoolPairing` inserts, and an index is not something a fake can
   * demonstrate.
   */
  it("keeps one row per pair however many times they correspond and part", async () => {
    const { sender, recipient } = await seedCorrespondedPair("repeat");

    const first = await prisma.messageContact.findFirstOrThrow({
      where: {
        OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
      },
    });

    // A second request between the same two, deleted by the other party, so
    // the canonical ordering is exercised rather than only repeated.
    const again = await prisma.request.create({
      data: {
        message: "Changed my mind.",
        fromUserId: recipient.user.id,
        toUserId: sender.user.id,
        status: RequestStatus.PENDING,
      },
    });
    await callerFor(sender.user.id).user.requests.delete({
      invitationId: again.id,
    });

    const rows = await prisma.messageContact.findMany({
      where: {
        OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
      },
    });

    expect(rows).toHaveLength(1);
    // The same row, with the clock moved forward rather than a second row.
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].endedAt.getTime()).toBeGreaterThanOrEqual(
      first.endedAt.getTime(),
    );
    expect(rows[0].dateCreated.getTime()).toBe(first.dateCreated.getTime());
  });

  it("stops listing a contact once it falls outside the retention window", async () => {
    const { sender, recipient } = await seedCorrespondedPair("expired");

    await prisma.messageContact.updateMany({
      where: {
        OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
      },
      data: {
        endedAt: new Date(contactRetentionCutoff(new Date()).getTime() - 1),
      },
    });

    expect(
      await callerFor(recipient.user.id).user.pastConnections.me(),
    ).toEqual([]);
    // Hidden, not deleted: only `scripts/expire-message-contacts.ts` deletes.
    expect(
      await prisma.messageContact.count({
        where: {
          OR: [{ userAId: sender.user.id }, { userBId: sender.user.id }],
        },
      }),
    ).toBe(1);
  });
});
