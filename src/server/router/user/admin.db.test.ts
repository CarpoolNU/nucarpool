import {
  Permission,
  ReportReason,
  ReportStatus,
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

/**
 * SCRUM-540: the CSV export against a real database.
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

const makeLocation = () =>
  prisma.location.create({
    data: {
      city: "Boston",
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

    const percent = (part: number, whole: number) =>
      Math.round((part / whole) * 1000) / 10 + "%";
    const quickStatsCSV = buildQuickStatsCSV({
      totalConversationCount: stats.conversations.totalConversationCount,
      totalWithMsgCount: stats.conversations.totalWithMsgCount,
      avgConvWithMsg: stats.conversations.avgConvWithMsg,
      avgMsg: stats.conversations.avgMsg,
      groupCount: stats.groups.groupCount,
      percentDriversInGroup: percent(
        stats.groups.driversInGroup,
        stats.groups.totalDrivers,
      ),
      percentRidersInGroup: percent(
        stats.groups.ridersInGroup,
        stats.groups.totalRiders,
      ),
      averageRidersPerGroup:
        Math.round(
          (stats.groups.ridersInGroup / stats.groups.groupCount) * 10,
        ) / 10,
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

    // Privacy decision (SCRUM-540): the export is aggregate-only. No message
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
 * SCRUM-541: `updateUserPermission`'s audit trail against a real database.
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
    });
  });
});

/**
 * SCRUM-574: `resolveReport` against a real database.
 *
 * The property worth a real database is the one the ticket exists for: a
 * resolved report must actually stop blocking a new one. `reports.ts`'s
 * duplicate guard is a `findFirst` keyed on `status: OPEN`, which a mocked
 * Prisma cannot prove either side of — it only ever returns what the test
 * told it to, regardless of what `resolveReport` actually wrote.
 */
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
