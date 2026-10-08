import {
  Permission,
  ReportReason,
  ReportStatus,
  RequestStatus,
  Role,
  Status,
} from "@prisma/client";
import type { Session } from "next-auth";
import { addWeeks, format, startOfWeek } from "date-fns";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";
import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildUserCountsCSV,
} from "../../../utils/adminDashboardCsv";
import { averagePerGroup, percentOf } from "../../../utils/adminQuickStats";

/**
 * The CSV export against a real database.
 *
 * `admin.test.ts` proves the query *shape* against a mocked Prisma; it cannot
 * prove that a real aggregate value survives the trip through the CSV
 * builders unchanged, because a mock returns whatever the test told it to.
 * This seeds real rows, reads them back through the same
 * `getDashboardStats`/`getDashboardSeries` procedures `AdminData` calls, and
 * checks the CSV rows carry the identical numbers — the on-screen dashboard
 * and the export are reading one query result, not two.
 *
 * Also stands in for the ticket's regression requirement: nothing here
 * touches `admin.ts`'s queries, so a passing run here is evidence they still
 * behave as `admin.test.ts` already describes.
 */

const prisma = integrationPrisma();

const managerSession = (): Session => ({
  expires: new Date(Date.now() + 60_000).toISOString(),
  user: {
    id: "manager-1",
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.MANAGER,
  },
});

const callerFor = (session: Session) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

const makeLocation = (city = "Boston") =>
  prisma.location.create({
    data: {
      city,
      state: "MA",
      street: "Main St",
      streetAddress: "1 Main St",
      coordLng: -71.05,
      coordLat: 42.36,
    },
  });

describe("the admin dashboard CSV export against a real database", () => {
  it("carries the same numbers the dashboard queries returned", async () => {
    const windowStart = startOfWeek(new Date(2026, 0, 1));
    const windowEnd = addWeeks(windowStart, 2);
    const midWindow = addWeeks(windowStart, 1);

    const group = await prisma.carpoolGroup.create({
      data: { dateCreated: midWindow },
    });
    const home = await makeLocation();
    const company = await makeLocation();

    const driver = await prisma.user.create({
      data: {
        name: "Driver One",
        email: "driver@northeastern.edu",
        isOnboarded: true,
        dateCreated: midWindow,
      },
    });
    await prisma.carpoolSearch.create({
      data: {
        userId: driver.id,
        role: Role.DRIVER,
        status: Status.ACTIVE,
        daysWorking: "0,1,1,1,1,1,0",
        homeLocationId: home.id,
        companyLocationId: company.id,
        carpoolId: group.id,
      },
    });

    const rider = await prisma.user.create({
      data: {
        name: "Rider One",
        email: "rider@northeastern.edu",
        isOnboarded: true,
        dateCreated: midWindow,
      },
    });
    await prisma.carpoolSearch.create({
      data: {
        userId: rider.id,
        role: Role.RIDER,
        status: Status.ACTIVE,
        daysWorking: "0,1,0,1,0,1,0",
        homeLocationId: home.id,
        companyLocationId: company.id,
        carpoolId: group.id,
      },
    });

    const request = await prisma.request.create({
      data: {
        message: "requesting a seat",
        fromUserId: rider.id,
        toUserId: driver.id,
        dateCreated: midWindow,
      },
    });
    const conversation = await prisma.conversation.create({
      data: { requestId: request.id, dateCreated: midWindow },
    });
    await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          userId: rider.id,
          content: "PRIVATE_MESSAGE_CONTENT_ONE",
        },
        {
          conversationId: conversation.id,
          userId: driver.id,
          content: "PRIVATE_MESSAGE_CONTENT_TWO",
        },
      ],
    });

    const caller = callerFor(managerSession());
    const stats = await caller.user.admin.getDashboardStats();
    const series = await caller.user.admin.getDashboardSeries({
      start: windowStart,
      end: windowEnd,
    });

    // Sanity: the fixture actually produced non-trivial aggregates, so the
    // CSV assertions below are checking real numbers rather than zeros that
    // would pass however the builders were wired.
    expect(stats.groups.groupCount).toBe(1);
    expect(stats.userCounts.driverAO).toBe(1);
    expect(stats.userCounts.riderAO).toBe(1);
    expect(stats.conversations.totalConversationCount).toBe(1);
    expect(stats.conversations.totalWithMsgCount).toBe(1);

    const quickStatsCSV = buildQuickStatsCSV({
      totalConversationCount: stats.conversations.totalConversationCount,
      totalWithMsgCount: stats.conversations.totalWithMsgCount,
      avgConvWithMsg: stats.conversations.avgConvWithMsg,
      avgMsg: stats.conversations.avgMsg,
      groupCount: stats.groups.groupCount,
      percentDriversInGroup: percentOf(
        stats.groups.driversInGroup,
        stats.groups.totalDrivers,
      ),
      percentRidersInGroup: percentOf(
        stats.groups.ridersInGroup,
        stats.groups.totalRiders,
      ),
      averageRidersPerGroup: averagePerGroup(
        stats.groups.ridersInGroup,
        stats.groups.groupCount,
      ),
    });
    const [, quickStatsRow] = quickStatsCSV.split("\n");
    expect(quickStatsRow).toBe(
      [
        stats.conversations.totalConversationCount,
        stats.conversations.totalWithMsgCount,
        stats.conversations.avgConvWithMsg,
        stats.conversations.avgMsg,
        stats.groups.groupCount,
        "100%",
        "100%",
        1,
      ].join(","),
    );

    const userCountsCSV = buildUserCountsCSV(stats.userCounts);
    expect(userCountsCSV).toContain(
      `Driver,${stats.userCounts.driverAO},${stats.userCounts.driverANO},${stats.userCounts.driverIO},${stats.userCounts.driverINO}`,
    );
    expect(userCountsCSV).toContain(
      `Rider,${stats.userCounts.riderAO},${stats.userCounts.riderANO},${stats.userCounts.riderIO},${stats.userCounts.riderINO}`,
    );

    const daysFrequencyCSV = buildDaysFrequencyCSV(stats.daysFrequency);
    const daysRows = daysFrequencyCSV.split("\n");
    // Driver worked Mon/Tue/Wed/Thu/Fri; rider worked Mon/Wed/Fri.
    expect(daysRows).toEqual([
      "Day,RiderCount,DriverCount",
      "Su,0,0",
      "M,1,1",
      "Tu,0,1",
      "W,1,1",
      "Th,0,1",
      "F,1,1",
      "S,0,0",
    ]);

    const lineChartCSV = buildLineChartCSV(series);
    const lineChartRows = lineChartCSV.split("\n");
    // One row per week label, each column lined up by index against what the
    // query actually returned — the cumulative-bucket arithmetic itself is
    // `countCumulativeItemsPerWeek`'s responsibility and is unit-tested in
    // `adminDataUtils.test.ts`; this is checking the export carries those
    // numbers through unchanged, against a real query result.
    expect(lineChartRows).toHaveLength(series.weekLabels.length + 1);
    series.weekLabels.forEach((label, index) => {
      expect(lineChartRows[index + 1]).toBe(
        [
          format(label, "MMM dd yyyy"),
          series.signupCount[index] ?? "",
          series.groupCounts[index] ?? "",
          series.requestCount[index] ?? "",
          series.driverRequestCount[index] ?? "",
          series.riderRequestCount[index] ?? "",
        ].join(","),
      );
    });
    // Sanity: the week `midWindow` falls in is where every seeded row lands,
    // so its signup bucket must be non-zero rather than the CSV round
    // trip trivially passing on all-null data.
    const midWeekIndex = series.weekLabels.findIndex(
      (label) => label.getTime() === startOfWeek(midWindow).getTime(),
    );
    expect(midWeekIndex).toBeGreaterThanOrEqual(0);
    expect(series.signupCount[midWeekIndex]).toBe(2);

    // Privacy decision: the export is aggregate-only. No message
    // body or other individual-level field can appear in any of the four
    // CSVs, because none of the builders is ever given one.
    for (const csv of [
      quickStatsCSV,
      userCountsCSV,
      daysFrequencyCSV,
      lineChartCSV,
    ]) {
      expect(csv).not.toContain("PRIVATE_MESSAGE_CONTENT");
      expect(csv).not.toContain(driver.email);
      expect(csv).not.toContain(rider.email);
    }
  });
});

/**
 * The request funnel against a real database.
 *
 * `admin.test.ts` proves the three `count` calls are shaped right; only a real
 * MySQL proves they count the right *rows*. That matters most for the third
 * stage, which is a filter on role and on `carpoolId` being non-null, and for
 * the case the ticket names: a rider in a group whose request row is gone.
 *
 * The fixture is chosen so each count differs from every other and from the
 * naive alternative. Four requests, two ACCEPTED, and three riders in a group
 * - one of whom has no request at all - with two drivers also in groups, so a
 * count of every member would read 5 rather than 3.
 */
describe("the request funnel against a real database", () => {
  const seedMember = async (
    email: string,
    role: Role,
    carpoolId: string | null,
  ) => {
    const user = await prisma.user.create({
      data: { name: email, email, isOnboarded: true },
    });
    await prisma.carpoolSearch.create({
      data: {
        userId: user.id,
        role,
        status: Status.ACTIVE,
        daysWorking: "0,1,1,1,1,1,0",
        homeLocationId: (await makeLocation()).id,
        companyLocationId: (await makeLocation()).id,
        carpoolId,
      },
    });
    return user;
  };

  it("counts sent and accepted requests, and riders - not drivers - in a group", async () => {
    const groupOne = await prisma.carpoolGroup.create({ data: {} });
    const groupTwo = await prisma.carpoolGroup.create({ data: {} });

    const driverOne = await seedMember(
      "funnel-driver-1@northeastern.edu",
      Role.DRIVER,
      groupOne.id,
    );
    const driverTwo = await seedMember(
      "funnel-driver-2@northeastern.edu",
      Role.DRIVER,
      groupTwo.id,
    );
    const riderOne = await seedMember(
      "funnel-rider-1@northeastern.edu",
      Role.RIDER,
      groupOne.id,
    );
    const riderTwo = await seedMember(
      "funnel-rider-2@northeastern.edu",
      Role.RIDER,
      groupOne.id,
    );
    // In a group, but the request that put them there no longer exists.
    await seedMember(
      "funnel-rider-3@northeastern.edu",
      Role.RIDER,
      groupTwo.id,
    );
    // Not in a group, so not counted in the last stage.
    const ungroupedRider = await seedMember(
      "funnel-rider-4@northeastern.edu",
      Role.RIDER,
      null,
    );
    // A VIEWER can send a request but is never counted as a rider.
    const viewer = await seedMember(
      "funnel-viewer@northeastern.edu",
      Role.VIEWER,
      null,
    );

    await prisma.request.createMany({
      data: [
        {
          message: "accepted one",
          fromUserId: riderOne.id,
          toUserId: driverOne.id,
          status: RequestStatus.ACCEPTED,
        },
        {
          message: "accepted two",
          fromUserId: riderTwo.id,
          toUserId: driverOne.id,
          status: RequestStatus.ACCEPTED,
        },
        {
          message: "still pending",
          fromUserId: ungroupedRider.id,
          toUserId: driverTwo.id,
          status: RequestStatus.PENDING,
        },
        {
          message: "from a viewer",
          fromUserId: viewer.id,
          toUserId: driverTwo.id,
          status: RequestStatus.PENDING,
        },
      ],
    });

    const stats =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    expect(stats.requestFunnel).toEqual({
      requestsSent: 4,
      requestsAccepted: 2,
      ridersInGroup: 3,
    });
  });

  it("is all zeros with no requests and nobody grouped", async () => {
    await seedMember("funnel-lonely@northeastern.edu", Role.RIDER, null);

    const stats =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    expect(stats.requestFunnel).toEqual({
      requestsSent: 0,
      requestsAccepted: 0,
      ridersInGroup: 0,
    });
  });

  it("is refused to a plain USER", async () => {
    const userSession: Session = {
      expires: new Date(Date.now() + 60_000).toISOString(),
      user: {
        id: "plain-user",
        isOnboarded: true,
        tutorialCompleted: true,
        permission: Permission.USER,
      },
    };

    await expect(
      callerFor(userSession).user.admin.getDashboardStats(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

/**
 * `updateUserPermission`'s audit trail against a real database.
 *
 * `admin.test.ts` proves the shape against a mocked Prisma with a pass-through
 * `$transaction`; it cannot prove the two writes actually land as one
 * transaction against real MySQL. This drives the real procedure and reads
 * the row back, rather than trusting what a mock was told to return.
 */
describe("updateUserPermission's audit trail against a real database", () => {
  it("writes exactly one audit log row alongside the permission change", async () => {
    const target = await prisma.user.create({
      data: {
        name: "Target User",
        email: "target@northeastern.edu",
        isOnboarded: true,
        permission: Permission.USER,
      },
    });

    const caller = callerFor(managerSession());
    await caller.user.admin.updateUserPermission({
      userId: target.id,
      permission: Permission.ADMIN,
    });

    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(updated.permission).toBe(Permission.ADMIN);

    const logs = await prisma.adminAuditLog.findMany({
      where: { targetId: target.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: "manager-1",
      action: "user.admin.updateUserPermission",
      targetId: target.id,
      metadata: JSON.stringify({ permission: Permission.ADMIN }),
    });
  });

  it("surfaces through getAuditLog, most recent first", async () => {
    const target = await prisma.user.create({
      data: {
        name: "Second Target",
        email: "target2@northeastern.edu",
        isOnboarded: true,
        permission: Permission.USER,
      },
    });

    const caller = callerFor(managerSession());
    await caller.user.admin.updateUserPermission({
      userId: target.id,
      permission: Permission.MANAGER,
    });

    const log = await caller.user.admin.getAuditLog();
    expect(log[0]).toMatchObject({
      actorId: "manager-1",
      action: "user.admin.updateUserPermission",
      targetId: target.id,
      // A user target is its own person, so there is no second id to resolve.
      targetUserId: null,
    });
  });
});

/**
 * `getAuditLog`'s report-target resolution against a real database.
 *
 * `admin.test.ts` can only show the query's shape: its mocked `report.findMany`
 * returns whatever the test handed it, so it cannot show that a resolution
 * row's `targetId` actually finds its report, or that the id it yields is the
 * *reported* user rather than the reporter. Both are joins, which is the part
 * a mock cannot prove.
 */
describe("getAuditLog's reported-user resolution against a real database", () => {
  /** A report by one real user about another, left OPEN for `resolveReport`. */
  const seedReport = async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter", email: "audit-reporter@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported", email: "audit-reported@northeastern.edu" },
    });
    const report = await prisma.report.create({
      data: {
        reporterId: reporter.id,
        reportedUserId: reported.id,
        reason: ReportReason.HARASSMENT,
      },
    });

    return { reporter, reported, report };
  };

  it("resolves a resolution row's report id to the reported user", async () => {
    const { reporter, reported, report } = await seedReport();

    const caller = callerFor(managerSession());
    await caller.user.admin.resolveReport({
      reportId: report.id,
      status: ReportStatus.REVIEWED,
    });

    const log = await caller.user.admin.getAuditLog();
    const entry = log.find((row) => row.targetId === report.id);

    expect(entry).toMatchObject({
      action: "user.admin.resolveReport",
      targetId: report.id,
      targetUserId: reported.id,
    });
    // The person the decision was about, not the person who filed it.
    expect(entry?.targetUserId).not.toBe(reporter.id);
  });

  it("yields null once the report behind a logged resolution is gone", async () => {
    const { report } = await seedReport();

    const caller = callerFor(managerSession());
    await caller.user.admin.resolveReport({
      reportId: report.id,
      status: ReportStatus.DISMISSED,
    });
    // The audit row outlives the report it refers to — nothing cascades an
    // `AdminAuditLog` row away, by design.
    await prisma.report.delete({ where: { id: report.id } });

    const log = await caller.user.admin.getAuditLog();
    const entry = log.find((row) => row.targetId === report.id);

    expect(entry).toMatchObject({
      action: "user.admin.resolveReport",
      targetUserId: null,
    });
  });
});

/**
 * `resolveReport` against a real database.
 *
 * The property worth a real database is the one the ticket exists for: a
 * resolved report must actually stop blocking a new one. `reports.ts`'s
 * duplicate guard is a `findFirst` keyed on `status: OPEN`, which a mocked
 * Prisma cannot prove either side of — it only ever returns what the test
 * told it to, regardless of what `resolveReport` actually wrote.
 */
/**
 * The per-reported-user count in `getReports`, against a real `GROUP BY`.
 *
 * `admin.test.ts` can only show the query's shape: its mocked `groupBy`
 * returns whatever the test handed it, so it cannot show that the numbers are
 * right. The properties that need a real database are that the count spans
 * reporters (several people reporting one person is exactly the pattern the
 * column exists to surface), that it respects the status filter, and that a
 * report moving out of `OPEN` moves the count with it.
 */
describe("getReports' per-user count against a real database", () => {
  const reporterSession = (id: string): Session => ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: {
      id,
      isOnboarded: true,
      tutorialCompleted: true,
      permission: Permission.USER,
    },
  });

  /** `count` reporters, all reporting one person. */
  const seedReportsAbout = async (count: number) => {
    const reported = await prisma.user.create({
      data: { name: "Subject", email: "subject@northeastern.edu" },
    });

    const reportIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const reporter = await prisma.user.create({
        data: {
          name: `Reporter ${i}`,
          email: `reporter-${i}@northeastern.edu`,
        },
      });
      const { reportId } = await callerFor(
        reporterSession(reporter.id),
      ).user.reports.create({
        reportedUserId: reported.id,
        reason: ReportReason.HARASSMENT,
        alsoBlock: false,
      });
      reportIds.push(reportId);
    }

    return { reported, reportIds };
  };

  it("counts every reporter's report about one person, on each of their rows", async () => {
    const { reported } = await seedReportsAbout(3);
    // A fourth report about somebody else, so a count that ignored the
    // grouping entirely would read 4 and fail here.
    const other = await prisma.user.create({
      data: { name: "Other", email: "other@northeastern.edu" },
    });
    const bystander = await prisma.user.create({
      data: { name: "Bystander", email: "bystander@northeastern.edu" },
    });
    await callerFor(reporterSession(bystander.id)).user.reports.create({
      reportedUserId: other.id,
      reason: ReportReason.OTHER,
      alsoBlock: false,
    });

    const { reports, countedStatus } =
      await callerFor(managerSession()).user.admin.getReports();

    expect(reports).toHaveLength(4);
    expect(countedStatus).toBe(ReportStatus.OPEN);
    for (const row of reports) {
      expect(row.reportsAboutUser).toBe(
        row.reportedUserId === reported.id ? 3 : 1,
      );
    }
  });

  it("counts only the status being viewed", async () => {
    const { reported, reportIds } = await seedReportsAbout(3);
    await callerFor(managerSession()).user.admin.resolveReport({
      reportId: reportIds[0],
      status: ReportStatus.DISMISSED,
    });

    const open = await callerFor(managerSession()).user.admin.getReports();
    expect(open.reports).toHaveLength(2);
    // Two left open, and the count says two rather than three: the resolved
    // one is out of the slice being viewed and out of its count with it.
    expect(open.reports.map((r) => r.reportsAboutUser)).toEqual([2, 2]);

    const dismissed = await callerFor(managerSession()).user.admin.getReports({
      status: ReportStatus.DISMISSED,
    });
    expect(dismissed.reports.map((r) => r.reportsAboutUser)).toEqual([1]);

    const all = await callerFor(managerSession()).user.admin.getReports({
      status: null,
    });
    expect(all.countedStatus).toBeNull();
    expect(all.reports).toHaveLength(3);
    for (const row of all.reports) {
      expect(row.reportedUserId).toBe(reported.id);
      expect(row.reportsAboutUser).toBe(3);
    }
  });

  it("counts reports beyond the page, not merely the ones on it", async () => {
    await seedReportsAbout(3);

    // One row per page. The count must still be 3 on that single row —
    // otherwise the column would say "1" about someone with three open
    // reports, which is worse than showing nothing.
    const firstPage = await callerFor(managerSession()).user.admin.getReports({
      limit: 1,
    });

    expect(firstPage.reports).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.reports[0].reportsAboutUser).toBe(3);
  });
});

describe("resolveReport against a real database", () => {
  const reporterSession = (id: string): Session => ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: {
      id,
      isOnboarded: true,
      tutorialCompleted: true,
      permission: Permission.USER,
    },
  });

  it("unblocks a new report from the same reporter against the same person", async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter", email: "reporter@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported", email: "reported@northeastern.edu" },
    });

    const { reportId } = await callerFor(
      reporterSession(reporter.id),
    ).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.HARASSMENT,
      alsoBlock: false,
    });

    // Still OPEN: the existing duplicate guard keeps refusing, unchanged.
    await expect(
      callerFor(reporterSession(reporter.id)).user.reports.create({
        reportedUserId: reported.id,
        reason: ReportReason.OTHER,
        alsoBlock: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await callerFor(managerSession()).user.admin.resolveReport({
      reportId,
      status: ReportStatus.DISMISSED,
    });

    expect(
      await prisma.report.findUniqueOrThrow({ where: { id: reportId } }),
    ).toMatchObject({ status: ReportStatus.DISMISSED });

    // Now unblocked: the same reporter can file a new report against the
    // same person, which is the whole point of resolving the first one.
    const second = await callerFor(
      reporterSession(reporter.id),
    ).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.SAFETY_CONCERN,
      alsoBlock: false,
    });

    expect(await prisma.report.count()).toBe(2);
    expect(
      await prisma.report.findUnique({ where: { id: second.reportId } }),
    ).toMatchObject({ status: ReportStatus.OPEN });
  });

  it("writes exactly one audit log row alongside the status change", async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter Two", email: "reporter2@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported Two", email: "reported2@northeastern.edu" },
    });
    const { reportId } = await callerFor(
      reporterSession(reporter.id),
    ).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.FAKE_PROFILE,
      alsoBlock: false,
    });

    await callerFor(managerSession()).user.admin.resolveReport({
      reportId,
      status: ReportStatus.REVIEWED,
    });

    const logs = await prisma.adminAuditLog.findMany({
      where: { targetId: reportId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: "manager-1",
      action: "user.admin.resolveReport",
      targetId: reportId,
      metadata: JSON.stringify({ status: ReportStatus.REVIEWED }),
    });
  });

  it("refuses to resolve a report a second time, leaving its status and audit log alone", async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter Three", email: "reporter3@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported Three", email: "reported3@northeastern.edu" },
    });
    const { reportId } = await callerFor(
      reporterSession(reporter.id),
    ).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.NO_SHOW,
      alsoBlock: false,
    });

    await callerFor(managerSession()).user.admin.resolveReport({
      reportId,
      status: ReportStatus.DISMISSED,
    });

    await expect(
      callerFor(managerSession()).user.admin.resolveReport({
        reportId,
        status: ReportStatus.REVIEWED,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      await prisma.report.findUniqueOrThrow({ where: { id: reportId } }),
    ).toMatchObject({ status: ReportStatus.DISMISSED });
    expect(
      await prisma.adminAuditLog.findMany({ where: { targetId: reportId } }),
    ).toHaveLength(1);
  });
});

/**
 * `getDashboardStats.supplyByCity`, whose grouping is the one part of the
 * dashboard the mocked suite cannot check: `admin.test.ts` sees the SQL text
 * and is handed whatever rows the test wrote, so it cannot say that MySQL
 * groups, joins, casts or filters the way the text claims.
 */
describe("supplyByCity against a real database", () => {
  let seeded = 0;

  /**
   * One user with one search, in the city named. `city: null` is a search
   * whose home location names no row - possible because `relationMode =
   * "prisma"` emulates the foreign key - which the `LEFT JOIN` has to keep.
   */
  const seedUser = async (options: {
    role: Role;
    status?: Status;
    city?: string | null;
    seatsAvail?: number;
    email?: string | null;
  }) => {
    seeded += 1;
    const company = await makeLocation();
    const home =
      options.city === null ? null : await makeLocation(options.city);
    const user = await prisma.user.create({
      data: {
        name: `Supply User ${seeded}`,
        email:
          options.email === undefined
            ? `supply${seeded}@northeastern.edu`
            : options.email,
      },
    });
    await prisma.carpoolSearch.create({
      data: {
        userId: user.id,
        role: options.role,
        status: options.status ?? Status.ACTIVE,
        seatsAvail: options.seatsAvail ?? 0,
        homeLocationId: home ? home.id : "no-such-location",
        companyLocationId: company.id,
      },
    });
  };

  it("groups active drivers and riders by city, and only them", async () => {
    // Boston: two drivers (one spelled differently), three riders.
    await seedUser({ role: Role.DRIVER, city: "Boston", seatsAvail: 3 });
    await seedUser({ role: Role.DRIVER, city: "  boston ", seatsAvail: 1 });
    await seedUser({ role: Role.RIDER, city: "Boston" });
    await seedUser({ role: Role.RIDER, city: "BOSTON" });
    await seedUser({ role: Role.RIDER, city: "Boston" });
    // Worcester: riders and no driver at all.
    await seedUser({ role: Role.RIDER, city: "Worcester" });
    await seedUser({ role: Role.RIDER, city: "Worcester" });
    // No city, and no location row at all: both counted, as Unknown.
    await seedUser({ role: Role.RIDER, city: "" });
    await seedUser({ role: Role.RIDER, city: null });
    // None of these is demand or supply, in any city.
    await seedUser({ role: Role.VIEWER, city: "Worcester" });
    await seedUser({
      role: Role.RIDER,
      status: Status.INACTIVE,
      city: "Worcester",
    });
    await seedUser({
      role: Role.DRIVER,
      status: Status.INACTIVE,
      city: "Worcester",
      seatsAvail: 4,
    });
    // `getDashboardStats` counts only users with an email, so this one is out.
    await seedUser({ role: Role.RIDER, city: "Worcester", email: null });

    const stats =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    expect(stats.supplyByCity).toEqual([
      {
        city: "Boston",
        kind: "city",
        drivers: 2,
        riders: 3,
        openSeats: 4,
        ridersPerDriver: 1.5,
        stranded: false,
      },
      {
        city: "Worcester",
        kind: "city",
        drivers: 0,
        riders: 2,
        openSeats: 0,
        ridersPerDriver: null,
        stranded: true,
      },
      {
        city: "Unknown",
        kind: "unknown",
        drivers: 0,
        riders: 2,
        openSeats: 0,
        ridersPerDriver: null,
        stranded: true,
      },
    ]);
  });

  it("reconciles with `userCounts`, whatever else is on the platform", async () => {
    await seedUser({ role: Role.DRIVER, city: "Boston", seatsAvail: 2 });
    await seedUser({ role: Role.RIDER, city: "Salem" });
    await seedUser({ role: Role.RIDER, city: "Salem" });
    await seedUser({ role: Role.VIEWER, city: "Salem" });
    await seedUser({
      role: Role.RIDER,
      status: Status.INACTIVE,
      city: "Salem",
    });

    const { supplyByCity, userCounts } =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    const total = (field: "drivers" | "riders") =>
      supplyByCity.reduce((sum, row) => sum + row[field], 0);
    expect(total("drivers")).toBe(userCounts.driverAO + userCounts.driverANO);
    expect(total("riders")).toBe(userCounts.riderAO + userCounts.riderANO);
    // Sanity: something to reconcile, so this is not zero equals zero.
    expect(total("drivers")).toBe(1);
    expect(total("riders")).toBe(2);
  });

  it("returns plain numbers, which a BigInt or Decimal would not survive", async () => {
    await seedUser({ role: Role.DRIVER, city: "Boston", seatsAvail: 2 });

    const stats =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    for (const row of stats.supplyByCity) {
      expect(typeof row.drivers).toBe("number");
      expect(typeof row.riders).toBe("number");
      expect(typeof row.openSeats).toBe("number");
    }
    expect(stats.supplyByCity[0].openSeats).toBe(2);
  });

  it("is empty when nobody has signed up", async () => {
    const stats =
      await callerFor(managerSession()).user.admin.getDashboardStats();

    expect(stats.supplyByCity).toEqual([]);
  });
});
