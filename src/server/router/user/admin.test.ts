import { Permission, Role, Status } from "@prisma/client";
import { addWeeks, startOfWeek } from "date-fns";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";

/**
 * What the admin dashboard router asks the database for (SCRUM-246).
 *
 * These assertions are about the *shape of the query*, not about business logic:
 * which columns are selected, that the requested date window reaches the `where`
 * clause, and that messages are only ever counted. That is the part of this
 * router that regressed before, and it is the part a mocked Prisma can verify
 * honestly. Real query behaviour belongs to the database tests (SCRUM-263).
 */

/** What a `MIN`/`MAX` aggregate answers for an empty table. */
const NO_DATES = { _min: { dateCreated: null }, _max: { dateCreated: null } };

const buildPrismaMock = () => ({
  user: {
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
    update: jest.fn().mockResolvedValue({}),
  },
  carpoolGroup: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
  },
  conversation: { count: jest.fn().mockResolvedValue(0) },
  message: {
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  request: {
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
  },
  carpoolSearch: { findMany: jest.fn().mockResolvedValue([]) },
});

type PrismaMock = ReturnType<typeof buildPrismaMock>;

const adminSession = (permission: Permission = Permission.ADMIN): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id: "admin-1",
    isOnboarded: true,
    tutorialCompleted: true,
    permission,
  },
});

const callerFor = (
  session: Session = adminSession(),
  prisma = buildPrismaMock(),
) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), prisma };
};

/** Every argument object the mock was ever called with, across all delegates. */
const everyCallArgument = (prisma: PrismaMock) =>
  Object.values(prisma)
    .flatMap((delegate) => Object.values(delegate))
    .flatMap((call) => (call as jest.Mock).mock.calls)
    .flat();

/** Walks a Prisma argument object looking for `field: true` anywhere in it. */
const selectsField = (value: unknown, field: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => selectsField(entry, field));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      (key === field && nested === true) || selectsField(nested, field),
  );
};

const searchRow = (overrides: Record<string, unknown> = {}) => ({
  role: Role.RIDER,
  status: Status.ACTIVE,
  daysWorking: "0,1,1,1,1,1,0",
  carpoolId: null,
  ...overrides,
});

describe("the message body never leaves the database", () => {
  it("has no getMessages procedure at all", () => {
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).not.toContain("user.admin.getMessages");
  });

  it("does not select `content` in any admin dashboard query", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getAllUsers();
    await caller.user.admin.getDateRange();
    await caller.user.admin.getDashboardStats();
    await caller.user.admin.getDashboardSeries({
      start: new Date(2024, 0, 7),
      end: new Date(2024, 0, 21),
    });

    for (const args of everyCallArgument(prisma)) {
      expect(selectsField(args, "content")).toBe(false);
    }
  });

  it("counts messages with groupBy instead of reading their rows", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardStats();

    expect(prisma.message.groupBy).toHaveBeenCalledWith({
      by: ["conversationId"],
      _count: { _all: true },
    });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("selects no email, name or location for the charts", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardStats();
    await caller.user.admin.getDashboardSeries({
      start: new Date(2024, 0, 7),
      end: new Date(2024, 0, 21),
    });

    for (const args of everyCallArgument(prisma)) {
      for (const field of ["name", "image", "bio", "homeLocation"]) {
        expect(selectsField(args, field)).toBe(false);
      }
    }
  });
});

describe("getAllUsers", () => {
  it("asks for only what the user-management screen needs", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getAllUsers();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { email: { not: null } },
      select: { id: true, email: true, permission: true },
    });
  });

  it("no longer issues the second carpoolSearch query it used to join in JS", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getAllUsers();

    expect(prisma.carpoolSearch.findMany).not.toHaveBeenCalled();
  });
});

describe("getDashboardSeries", () => {
  const start = new Date(2024, 0, 10);
  const end = new Date(2024, 0, 17);
  const expectedWindow = {
    gte: startOfWeek(start),
    lt: addWeeks(startOfWeek(end), 1),
  };

  it("pushes the requested window into every series query", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardSeries({ start, end });

    for (const findMany of [
      prisma.user.findMany,
      prisma.carpoolGroup.findMany,
      prisma.request.findMany,
    ]) {
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dateCreated: expectedWindow }),
        }),
      );
    }
  });

  it("labels the weeks of the requested window, not of the whole dataset", async () => {
    const { caller } = callerFor();

    const series = await caller.user.admin.getDashboardSeries({ start, end });

    expect(series.weekLabels).toEqual([startOfWeek(start), startOfWeek(end)]);
  });

  it("splits users on their first search's status, defaulting to inactive", async () => {
    const { caller, prisma } = callerFor();
    prisma.user.findMany.mockResolvedValue([
      { dateCreated: start, carpoolSearches: [{ status: Status.ACTIVE }] },
      { dateCreated: start, carpoolSearches: [{ status: Status.INACTIVE }] },
      { dateCreated: start, carpoolSearches: [] },
    ]);

    const series = await caller.user.admin.getDashboardSeries({ start, end });

    expect(series.activeUserCount[0]).toBe(1);
    expect(series.inactiveUserCount[0]).toBe(2);
  });

  it("splits requests on the sender's role, defaulting to viewer", async () => {
    const { caller, prisma } = callerFor();
    prisma.request.findMany.mockResolvedValue([
      {
        dateCreated: start,
        fromUser: { carpoolSearches: [{ role: Role.DRIVER }] },
      },
      {
        dateCreated: start,
        fromUser: { carpoolSearches: [{ role: Role.RIDER }] },
      },
      { dateCreated: start, fromUser: { carpoolSearches: [] } },
    ]);

    const series = await caller.user.admin.getDashboardSeries({ start, end });

    expect(series.requestCount[0]).toBe(3);
    expect(series.driverRequestCount[0]).toBe(1);
    expect(series.riderRequestCount[0]).toBe(1);
  });
});

describe("getDateRange", () => {
  it("spans the earliest and latest date across the three tables", async () => {
    const { caller, prisma } = callerFor();
    prisma.user.aggregate.mockResolvedValue({
      _min: { dateCreated: new Date(2024, 1, 1) },
      _max: { dateCreated: new Date(2024, 1, 1) },
    });
    prisma.carpoolGroup.aggregate.mockResolvedValue({
      _min: { dateCreated: new Date(2024, 0, 1) },
      _max: { dateCreated: new Date(2024, 0, 1) },
    });
    prisma.request.aggregate.mockResolvedValue({
      _min: { dateCreated: new Date(2024, 2, 1) },
      _max: { dateCreated: new Date(2024, 2, 1) },
    });

    const range = await caller.user.admin.getDateRange();

    expect(range).toEqual({
      minDate: new Date(2024, 0, 1),
      maxDate: new Date(2024, 2, 1),
    });
  });

  it("reads bounds with MIN/MAX rather than by listing rows", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDateRange();

    expect(prisma.user.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        _min: { dateCreated: true },
        _max: { dateCreated: true },
      }),
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.request.findMany).not.toHaveBeenCalled();
  });

  it("answers null on an empty platform rather than an impossible range", async () => {
    const { caller } = callerFor();

    await expect(caller.user.admin.getDateRange()).resolves.toEqual({
      minDate: null,
      maxDate: null,
    });
  });
});

describe("getDashboardStats", () => {
  it("returns finished counts, applying the defaults for a user with no search", async () => {
    const { caller, prisma } = callerFor();
    prisma.user.findMany.mockResolvedValue([
      {
        isOnboarded: true,
        carpoolSearches: [searchRow({ role: Role.DRIVER })],
      },
      { isOnboarded: false, carpoolSearches: [] },
    ]);
    prisma.carpoolGroup.count.mockResolvedValue(3);
    prisma.conversation.count.mockResolvedValue(4);
    prisma.message.groupBy.mockResolvedValue([
      { conversationId: "c1", _count: { _all: 1 } },
      { conversationId: "c2", _count: { _all: 3 } },
    ]);

    const stats = await caller.user.admin.getDashboardStats();

    // The search-less user lands in the inactive, not-onboarded viewer cell.
    expect(stats.userCounts.totalAO).toBe(1);
    expect(stats.userCounts.driverAO).toBe(1);
    expect(stats.userCounts.viewerINO).toBe(1);
    expect(stats.groups.groupCount).toBe(3);
    expect(stats.conversations).toEqual({
      totalConversationCount: 4,
      totalWithMsgCount: 1,
      avgConvWithMsg: 3,
      avgMsg: 1,
    });
  });

  it("counts mixed-role groups in the database rather than filtering rows", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardStats();

    expect(prisma.carpoolGroup.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { carpoolSearches: { some: { role: Role.DRIVER } } },
          { carpoolSearches: { some: { role: Role.RIDER } } },
        ],
      },
    });
    expect(prisma.carpoolGroup.findMany).not.toHaveBeenCalled();
  });
});

describe("updateUserPermission", () => {
  it("refuses a non-manager with FORBIDDEN rather than an opaque 500", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));

    await expect(
      caller.user.admin.updateUserPermission({
        userId: "someone-else",
        permission: Permission.MANAGER,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a self-edit with FORBIDDEN", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.MANAGER));

    await expect(
      caller.user.admin.updateUserPermission({
        userId: "admin-1",
        permission: Permission.USER,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
