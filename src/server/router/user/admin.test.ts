import { Permission, ReportStatus, Role, Status } from "@prisma/client";
import { addWeeks, startOfWeek } from "date-fns";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import {
  DASHBOARD_WINDOW_ORDER_MESSAGE,
  DASHBOARD_WINDOW_SPAN_MESSAGE,
} from "./admin";
import { MAX_DASHBOARD_WEEKS } from "../../adminDataUtils";

/**
 * What the admin dashboard router asks the database for.
 *
 * These assertions are about the *shape of the query*, not about business logic:
 * which columns are selected, that the requested date window reaches the `where`
 * clause, and that messages are only ever counted. That is the part of this
 * router most likely to regress silently, and it is the part a mocked Prisma
 * can verify honestly. Real query behaviour belongs to the database tests.
 */

/** What a `MIN`/`MAX` aggregate answers for an empty table. */
const NO_DATES = { _min: { dateCreated: null }, _max: { dateCreated: null } };

const buildPrismaMock = () => {
  const client = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue(NO_DATES),
      update: jest.fn().mockResolvedValue({}),
      // The target-exists read `updateUserPermission` makes before it opens
      // its transaction. Answers "found" by default so the tests about the
      // write itself are unaffected; the NOT_FOUND test overrides it with
      // `null`, which is what Prisma returns for a row that is not there.
      findUnique: jest.fn().mockResolvedValue({ id: "someone-else" }),
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
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue(NO_DATES),
    },
    carpoolSearch: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    report: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      // The per-reported-user count beside each `getReports` row. Empty by
      // default, which the resolver reads as "one report about this user" —
      // see the `?? 1` there.
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };

  // `updateUserPermission` and `resolveReport` each write inside
  // `ctx.prisma.$transaction(async (tx) => ...)`. A pass-through is enough
  // here: this file asserts query *shape*, and `tx.user.update` /
  // `tx.adminAuditLog.create` / `tx.$executeRaw` are the same jest.fn()s as
  // `mock.user.update` / `mock.adminAuditLog.create` / `mock.$executeRaw`, so
  // assertions on those see the calls made inside a transaction too.
  // Atomicity itself is proven for real in `admin.db.test.ts`.
  //
  // Both defined non-enumerable so `everyCallArgument`'s `Object.values(prisma)`
  // still walks only real delegate objects — a plain spread would hand it a
  // bare jest.fn() as one of those "delegates" and it would fail reading
  // `.mock.calls` off jest's own internal mock-state object.
  //
  // `$executeRaw` is set on `client` itself first, so `tx.$executeRaw` inside
  // `$transaction`'s callback (`tx` is `client`) is the same jest.fn() as the
  // one below, and a test can assert on either.
  const executeRaw = jest.fn().mockResolvedValue(1); // 1 row changed: success.
  Object.defineProperty(client, "$executeRaw", {
    value: executeRaw,
    enumerable: false,
  });

  // `Object.defineProperties` types its return as the input's own type, so a
  // cast is what actually exposes `$transaction`/`$executeRaw` to callers —
  // both exist at runtime regardless.
  return Object.defineProperties(
    { ...client },
    {
      $transaction: {
        value: jest.fn((fn: (tx: typeof client) => unknown) => fn(client)),
        enumerable: false,
      },
      $executeRaw: { value: executeRaw, enumerable: false },
      // `getDashboardStats` groups its per-city counts with a raw query,
      // because Prisma's `groupBy` cannot group by a related table's column.
      // Non-enumerable for the same reason as the other two: a bare jest.fn()
      // is not a delegate for the walkers below to read `.mock.calls` off.
      $queryRaw: { value: jest.fn().mockResolvedValue([]), enumerable: false },
    },
  ) as typeof client & {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
  };
};

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

  it("issues no second carpoolSearch query to join in JS", async () => {
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

  it("counts every signup as one series, whatever its status today", async () => {
    // A user's status history is not recorded, so splitting past signups by
    // today's status would draw every lapsed user as inactive, regardless of
    // when they actually lapsed.
    const { caller, prisma } = callerFor();
    prisma.user.findMany.mockResolvedValue([
      { dateCreated: start },
      { dateCreated: start },
      { dateCreated: start },
    ]);

    const series = await caller.user.admin.getDashboardSeries({ start, end });

    expect(series.signupCount[0]).toBe(3);
    expect(series).not.toHaveProperty("activeUserCount");
    expect(series).not.toHaveProperty("inactiveUserCount");
  });

  it("reads no status for the signup series", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardSeries({ start, end });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { dateCreated: true } }),
    );
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

  /**
   * A bare `z.object({ start: z.date(), end: z.date() })`, with nothing else,
   * would let the number of week buckets the handler allocates come straight
   * from client input. The widest representable window is ~2.84e7 weeks;
   * allocating it exhausts a 2 GB heap in about eleven seconds, which kills
   * the Node process and every co-located request with it rather than just
   * returning slowly.
   *
   * `expect(everyCallArgument(prisma)).toEqual([])` is the assertion that
   * matters in each rejection: validation has to refuse *before* the handler
   * runs, since the allocation happens ahead of any database work.
   */
  const rejectedWindow = async (window: unknown) => {
    const { caller, prisma } = callerFor();

    const error = await caller.user.admin
      .getDashboardSeries(window as { start: Date; end: Date })
      .then(
        () => null,
        (thrown) => thrown as any,
      );

    return { error, prisma };
  };

  /** The Zod issues behind a tRPC input rejection. */
  const issuesOf = (error: any) => error?.cause?.issues ?? [];

  it("refuses a window whose end precedes its start, without querying", async () => {
    // Without this check: `generateWeekLabels` takes Math.min/Math.max so it
    // would chart the axis anyway, while the order-sensitive `where` clause
    // becomes `gte: <later>, lt: <earlier>` and matches nothing. An admin
    // would see labels over flat zeroes — indistinguishable from a genuinely
    // quiet week.
    const { error, prisma } = await rejectedWindow({ start: end, end: start });

    expect(error.code).toBe("BAD_REQUEST");
    expect(issuesOf(error)).toContainEqual(
      expect.objectContaining({
        path: ["end"],
        message: DASHBOARD_WINDOW_ORDER_MESSAGE,
      }),
    );
    expect(everyCallArgument(prisma)).toEqual([]);
  });

  it("refuses a window wider than the maximum, naming the limit", async () => {
    const { error, prisma } = await rejectedWindow({
      start,
      end: addWeeks(start, MAX_DASHBOARD_WEEKS),
    });

    expect(error.code).toBe("BAD_REQUEST");
    expect(issuesOf(error)).toContainEqual(
      expect.objectContaining({
        path: ["end"],
        message: DASHBOARD_WINDOW_SPAN_MESSAGE,
      }),
    );
    expect(DASHBOARD_WINDOW_SPAN_MESSAGE).toContain(
      String(MAX_DASHBOARD_WEEKS),
    );
    expect(everyCallArgument(prisma)).toEqual([]);
  });

  it("refuses the widest representable window, where the span is not a number", async () => {
    // The trap this case exists for: `startOfWeek` on a date within six days of
    // the `Date` minimum walks past the representable range and returns an
    // invalid date, so the span is NaN. `NaN > MAX_DASHBOARD_WEEKS` is false, so
    // a ceiling comparison alone would admit precisely the worst input there is.
    const { error, prisma } = await rejectedWindow({
      start: new Date(-8.64e15),
      end: new Date(8.64e15),
    });

    expect(error.code).toBe("BAD_REQUEST");
    expect(everyCallArgument(prisma)).toEqual([]);
  });

  it("refuses an unrecognised field rather than ignoring it", async () => {
    const { error, prisma } = await rejectedWindow({ start, end, weeks: 1e9 });

    expect(error.code).toBe("BAD_REQUEST");
    expect(everyCallArgument(prisma)).toEqual([]);
  });

  it("accepts a window of exactly the maximum span", async () => {
    // The ceiling is inclusive, so the boundary is asserted from both sides.
    const { caller, prisma } = callerFor();

    const series = await caller.user.admin.getDashboardSeries({
      start,
      end: addWeeks(start, MAX_DASHBOARD_WEEKS - 1),
    });

    expect(series.weekLabels).toHaveLength(MAX_DASHBOARD_WEEKS);
    expect(prisma.user.findMany).toHaveBeenCalled();
  });

  it("accepts a window that starts and ends in the same week", async () => {
    // Equal ends are a legitimate one-bucket chart, not a degenerate range.
    const { caller } = callerFor();

    const series = await caller.user.admin.getDashboardSeries({
      start,
      end: start,
    });

    expect(series.weekLabels).toEqual([startOfWeek(start)]);
  });

  it("still accepts the window the dashboard itself asks for", async () => {
    // `AdminData` sends startOfWeek(minDate) to startOfWeek(maxDate) from
    // `getDateRange`, which is derived from real row timestamps. A few years of
    // data must stay far inside the ceiling.
    const { caller, prisma } = callerFor();

    await caller.user.admin.getDashboardSeries({
      start: startOfWeek(new Date(2022, 0, 1)),
      end: startOfWeek(new Date(2026, 8, 4)),
    });

    expect(prisma.user.findMany).toHaveBeenCalled();
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

  describe("requestFunnel", () => {
    it("returns the three counts the database gave it", async () => {
      const { caller, prisma } = callerFor();
      prisma.request.count
        .mockResolvedValueOnce(12) // every request
        .mockResolvedValueOnce(5); // ACCEPTED only
      prisma.carpoolSearch.count.mockResolvedValue(4);

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.requestFunnel).toEqual({
        requestsSent: 12,
        requestsAccepted: 5,
        ridersInGroup: 4,
      });
    });

    it("is all zeros on an empty platform, with nothing to divide", async () => {
      const { caller } = callerFor();

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.requestFunnel).toEqual({
        requestsSent: 0,
        requestsAccepted: 0,
        ridersInGroup: 0,
      });
    });

    it("counts in the database, asking for accepted requests and grouped riders by filter", async () => {
      const { caller, prisma } = callerFor();

      await caller.user.admin.getDashboardStats();

      expect(prisma.request.count).toHaveBeenCalledWith();
      expect(prisma.request.count).toHaveBeenCalledWith({
        where: { status: "ACCEPTED" },
      });
      expect(prisma.carpoolSearch.count).toHaveBeenCalledWith({
        where: { role: Role.RIDER, carpoolId: { not: null } },
      });
      expect(prisma.request.findMany).not.toHaveBeenCalled();
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

  describe("daysByWeekday", () => {
    it("is built from the user query's `daysWorking`, with no query of its own", async () => {
      const { caller, prisma } = callerFor();
      prisma.user.findMany.mockResolvedValue([
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({ role: Role.RIDER, daysWorking: "1,1,0,0,0,0,0" }),
          ],
        },
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({ role: Role.DRIVER, daysWorking: "0,1,0,0,0,0,0" }),
          ],
        },
      ]);

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.daysByWeekday.days.map((row) => row.riders)).toEqual([
        1, 1, 0, 0, 0, 0, 0,
      ]);
      expect(stats.daysByWeekday.days.map((row) => row.drivers)).toEqual([
        0, 1, 0, 0, 0, 0, 0,
      ]);
      // The one user query is still the only one, and it still asks only for
      // the columns it asked for before.
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.carpoolSearch.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("counts a search with an empty `daysWorking` as unspecified, not dropped", async () => {
      const { caller, prisma } = callerFor();
      prisma.user.findMany.mockResolvedValue([
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({ role: Role.RIDER, daysWorking: "" }),
            // Only the first search is read; see `FIRST_SEARCH`.
          ],
        },
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({ role: Role.DRIVER, daysWorking: "garbage" }),
          ],
        },
      ]);

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.daysByWeekday.unspecified).toEqual({
        drivers: 1,
        riders: 1,
      });
    });

    it("leaves out viewers and the inactive, like the days-per-week chart beside it", async () => {
      const { caller, prisma } = callerFor();
      prisma.user.findMany.mockResolvedValue([
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({ role: Role.VIEWER, daysWorking: "1,1,1,1,1,1,1" }),
          ],
        },
        {
          isOnboarded: true,
          carpoolSearches: [
            searchRow({
              role: Role.RIDER,
              status: Status.INACTIVE,
              daysWorking: "1,1,1,1,1,1,1",
            }),
          ],
        },
      ]);

      const stats = await caller.user.admin.getDashboardStats();

      expect(
        stats.daysByWeekday.days.every((row) => row.drivers + row.riders === 0),
      ).toBe(true);
      expect(stats.daysByWeekday.unspecified).toEqual({
        drivers: 0,
        riders: 0,
      });
      // The unchanged neighbour, as a regression control.
      expect(stats.daysFrequency.riderDayCount).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("asks the database for no schedule time, and returns none", async () => {
      const { caller, prisma } = callerFor();

      const stats = await caller.user.admin.getDashboardStats();

      // Schedule times were written under four picker conventions, so a
      // time-of-day figure would be wrong. The chart must not be able to
      // draw one, which starts with never selecting the column.
      for (const args of everyCallArgument(prisma)) {
        expect(selectsField(args, "startTime")).toBe(false);
        expect(selectsField(args, "endTime")).toBe(false);
      }
      const [strings] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
      ];
      expect(strings.join("?")).not.toMatch(/start_time|end_time/);
      expect(JSON.stringify(stats.daysByWeekday)).not.toMatch(
        /startTime|endTime|hour/i,
      );
    });
  });

  describe("supplyByCity", () => {
    /** The SQL a tagged-template call carried, with each `${}` shown as `?`. */
    const supplySql = (prisma: PrismaMock) => {
      const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      return { sql: strings.join("?"), values };
    };

    it("groups by city in MySQL rather than reading location rows", async () => {
      const { caller, prisma } = callerFor();

      await caller.user.admin.getDashboardStats();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const { sql } = supplySql(prisma);
      expect(sql).toMatch(/GROUP BY LOWER\(TRIM\(COALESCE\(l\.city, ''\)\)\)/);
      // Rows with no location or no city stay in the totals as "Unknown".
      expect(sql).toMatch(/LEFT JOIN location/);
      expect(prisma.carpoolSearch.findMany).not.toHaveBeenCalled();
    });

    it("counts the population `userCounts` calls drivers and riders", async () => {
      const { caller, prisma } = callerFor();

      await caller.user.admin.getDashboardStats();

      const { sql, values } = supplySql(prisma);
      // ACTIVE drivers and riders with an email, and nobody else: no VIEWER,
      // no INACTIVE, and the same `email IS NOT NULL` gate `getDashboardStats`
      // puts on its user query, so the totals reconcile.
      expect(values).toEqual(
        expect.arrayContaining([Role.DRIVER, Role.RIDER, Status.ACTIVE]),
      );
      expect(values).not.toContain(Role.VIEWER);
      expect(values).not.toContain(Status.INACTIVE);
      expect(sql).toMatch(/u\.email IS NOT NULL/);
    });

    it("selects the city and counts, and no street, coordinate or person", async () => {
      const { caller, prisma } = callerFor();

      await caller.user.admin.getDashboardStats();

      // Raw SQL is not a delegate call, so the `selectsField` sweeps above
      // cannot see it. Read the SELECT clause itself: everything before FROM.
      const { sql } = supplySql(prisma);
      const selected = sql.slice(0, sql.indexOf("FROM"));
      for (const column of [
        "street",
        "coord",
        "email",
        "name",
        "bio",
        "image",
        "content",
        "userId",
      ]) {
        expect(selected).not.toContain(column);
      }
    });

    it("turns MySQL's BigInt counts into the plain numbers a client can read", async () => {
      const { caller, prisma } = callerFor();
      prisma.$queryRaw.mockResolvedValue([
        {
          city: "boston",
          drivers: BigInt(3),
          riders: BigInt(9),
          openSeats: BigInt(7),
        },
        {
          city: "",
          drivers: BigInt(0),
          riders: BigInt(2),
          openSeats: BigInt(0),
        },
      ]);

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.supplyByCity).toEqual([
        {
          city: "Boston",
          kind: "city",
          drivers: 3,
          riders: 9,
          openSeats: 7,
          ridersPerDriver: 3,
          stranded: false,
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

    it("is empty on an empty platform", async () => {
      const { caller } = callerFor();

      const stats = await caller.user.admin.getDashboardStats();

      expect(stats.supplyByCity).toEqual([]);
    });
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

  it("writes exactly one audit log entry naming the actor, action and target", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.MANAGER));

    await caller.user.admin.updateUserPermission({
      userId: "someone-else",
      permission: Permission.ADMIN,
    });

    expect(prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "admin-1",
        action: "user.admin.updateUserPermission",
        targetId: "someone-else",
        metadata: JSON.stringify({ permission: Permission.ADMIN }),
      },
    });
  });

  it("writes no audit entry when the permission change itself is refused", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));

    await expect(
      caller.user.admin.updateUserPermission({
        userId: "someone-else",
        permission: Permission.MANAGER,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a userId naming nobody, instead of an opaque 500", async () => {
    // Prisma throws P2025 for an update whose `where` matches no row. That is
    // not a TRPCError, so without this check it would reach the manager as
    // INTERNAL_SERVER_ERROR with the message replaced — the very masking the
    // FORBIDDEN checks above exist to avoid, on the one branch they don't
    // cover.
    const { caller, prisma } = callerFor(adminSession(Permission.MANAGER));
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      caller.user.admin.updateUserPermission({
        userId: "no-such-user",
        permission: Permission.ADMIN,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Refused before the transaction opens, so neither write was attempted —
    // a permission change and its audit entry must never diverge.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("checks the target against the id from the input, not the actor", async () => {
    // Guards against a check that reads `ctx.session.user.id` and so passes
    // for every target as long as the manager themselves exists.
    const { caller, prisma } = callerFor(adminSession(Permission.MANAGER));

    await caller.user.admin.updateUserPermission({
      userId: "someone-else",
      permission: Permission.ADMIN,
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "someone-else" },
      select: { id: true },
    });
  });

  it("writes both the update and its audit entry through the same transaction", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.MANAGER));

    await caller.user.admin.updateUserPermission({
      userId: "someone-else",
      permission: Permission.USER,
    });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe("getAuditLog", () => {
  it("reads the most recent entries first, bounded rather than paginated", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getAuditLog();

    expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith({
      orderBy: { dateCreated: "desc" },
      take: 500,
    });
  });

  it("asks for no report at all when the page holds no resolution row", async () => {
    const { caller, prisma } = callerFor();
    prisma.adminAuditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.updateUserPermission",
        targetId: "user-2",
        metadata: null,
        dateCreated: new Date(),
      },
    ]);

    const log = await caller.user.admin.getAuditLog();

    expect(prisma.report.findMany).not.toHaveBeenCalled();
    // A permission row's target is a user already, so there is no second id.
    expect(log[0].targetUserId).toBeNull();
  });

  it("resolves every report target in one read, of two columns", async () => {
    const { caller, prisma } = callerFor();
    prisma.adminAuditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "report-a",
        metadata: null,
        dateCreated: new Date(),
      },
      {
        id: "log-2",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "report-b",
        metadata: null,
        dateCreated: new Date(),
      },
      // The same report resolved twice contributes one id, not two.
      {
        id: "log-3",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "report-a",
        metadata: null,
        dateCreated: new Date(),
      },
    ]);
    prisma.report.findMany.mockResolvedValue([
      { id: "report-a", reportedUserId: "user-a" },
      { id: "report-b", reportedUserId: "user-b" },
    ]);

    const log = await caller.user.admin.getAuditLog();

    expect(prisma.report.findMany).toHaveBeenCalledTimes(1);
    // The select is the privacy-relevant part: no `conversationSnapshot`, no
    // `reason`, nothing from `message`.
    expect(prisma.report.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["report-a", "report-b"] } },
      select: { id: true, reportedUserId: true },
    });
    expect(log.map((entry) => entry.targetUserId)).toEqual([
      "user-a",
      "user-b",
      "user-a",
    ]);
  });

  it("leaves targetUserId null for a report that no longer exists", async () => {
    const { caller, prisma } = callerFor();
    prisma.adminAuditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "report-gone",
        metadata: null,
        dateCreated: new Date(),
      },
    ]);
    prisma.report.findMany.mockResolvedValue([]);

    const log = await caller.user.admin.getAuditLog();

    expect(log[0].targetUserId).toBeNull();
  });
});

describe("getReports", () => {
  it("reads the most recent OPEN reports first by default, one page at a time", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports();

    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "OPEN" },
        orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
        take: 501,
      }),
    );
  });

  it("reads every status when status is explicitly null", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports({ status: null });

    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("reads a specific status when asked for one", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports({ status: "DISMISSED" });

    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "DISMISSED" } }),
    );
  });

  it("pages with a cursor, and reports whether another page exists", async () => {
    const { caller, prisma } = callerFor();
    const row = (id: string) => ({
      id,
      reporterId: "user-1",
      reportedUserId: "user-2",
      reason: "HARASSMENT",
      message: null,
      requestId: null,
      conversationSnapshot: null,
      status: "OPEN",
      dateCreated: new Date(2026, 8, 1),
    });

    prisma.report.findMany.mockResolvedValueOnce([
      row("report-1"),
      row("report-2"),
    ]);
    const firstPage = await caller.user.admin.getReports({ limit: 1 });
    expect(firstPage.reports.map((r) => r.id)).toEqual(["report-1"]);
    expect(firstPage.nextCursor).toBe("report-1");

    prisma.report.findMany.mockResolvedValueOnce([row("report-2")]);
    await caller.user.admin.getReports({ limit: 1, cursor: "report-1" });
    expect(prisma.report.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 2,
        cursor: { id: "report-1" },
        skip: 1,
      }),
    );

    prisma.report.findMany.mockResolvedValueOnce([row("report-3")]);
    const lastPage = await caller.user.admin.getReports({ limit: 1 });
    expect(lastPage.nextCursor).toBeNull();
  });

  /**
   * `AdminReports` reaches this through `useInfiniteQuery`, and tRPC's client
   * does not send the input the component wrote. `getClientArgs` merges
   * `direction` into every infinite-query input - `"forward"` on the first
   * page, before any cursor exists - and the server never strips it, so the
   * schema is what has to accept it.
   *
   * Every other test in this block calls the caller with a hand-written
   * input, so a `.strict()` schema would pass all of them even though the
   * queue cannot load for any admin without this case: real traffic always
   * carries `direction`. The literal below is the wire input, cast because
   * the procedure's own types describe what the component passes rather than
   * what the client sends.
   */
  it("accepts the input tRPC's useInfiniteQuery actually sends", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports({
      status: "OPEN",
      direction: "forward",
    } as Parameters<typeof caller.user.admin.getReports>[0]);

    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "OPEN" } }),
    );
  });

  it("accepts it on a later page too, alongside the cursor", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports({
      status: "OPEN",
      cursor: "report-1",
      direction: "forward",
    } as Parameters<typeof caller.user.admin.getReports>[0]);

    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "report-1" }, skip: 1 }),
    );
  });

  it("never reads the message table, only the copy the report kept", async () => {
    const { caller, prisma } = callerFor();

    await caller.user.admin.getReports();

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    for (const args of everyCallArgument(prisma)) {
      expect(selectsField(args, "content")).toBe(false);
    }
  });

  it("returns the snapshot parsed, and null where it cannot be", async () => {
    const { caller, prisma } = callerFor();
    const base = {
      reporterId: "user-1",
      reportedUserId: "user-2",
      reason: "HARASSMENT",
      message: null,
      requestId: "req-1",
      status: "OPEN",
      dateCreated: new Date(2026, 8, 1),
    };
    prisma.report.findMany.mockResolvedValue([
      {
        ...base,
        id: "report-1",
        conversationSnapshot: JSON.stringify([
          {
            senderId: "user-2",
            content: "hello",
            sentAt: "2026-09-01T12:00:00.000Z",
          },
        ]),
      },
      { ...base, id: "report-2", conversationSnapshot: "not json" },
    ]);

    const { reports } = await caller.user.admin.getReports();

    expect(reports[0].conversationSnapshot).toEqual([
      {
        senderId: "user-2",
        content: "hello",
        sentAt: new Date("2026-09-01T12:00:00.000Z"),
      },
    ]);
    expect(reports[1].conversationSnapshot).toBeNull();
  });

  /**
   * The per-reported-user count. Query *shape* here; that the numbers are
   * right across several reports and several statuses needs a real GROUP BY
   * and is in `admin.db.test.ts`.
   */
  describe("reportsAboutUser", () => {
    const reportRow = (id: string, reportedUserId: string) => ({
      id,
      reporterId: "reporter-1",
      reportedUserId,
      reason: "HARASSMENT",
      message: null,
      requestId: null,
      conversationSnapshot: null,
      status: "OPEN",
      dateCreated: new Date(2026, 8, 1),
    });

    it("groups over only the reported users on this page", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([
        reportRow("report-1", "user-a"),
        reportRow("report-2", "user-b"),
        // A second report about user-a: the `in` list must not repeat it.
        reportRow("report-3", "user-a"),
      ]);

      await caller.user.admin.getReports();

      expect(prisma.report.groupBy).toHaveBeenCalledWith({
        by: ["reportedUserId"],
        where: {
          reportedUserId: { in: ["user-a", "user-b"] },
          status: "OPEN",
        },
        _count: { _all: true },
      });
    });

    it("counts the status being viewed, and says which that was", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([
        reportRow("report-1", "user-a"),
      ]);

      const dismissed = await caller.user.admin.getReports({
        status: "DISMISSED",
      });

      expect(prisma.report.groupBy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "DISMISSED" }),
        }),
      );
      expect(dismissed.countedStatus).toBe("DISMISSED");
    });

    it("counts every status when asked for every status", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([
        reportRow("report-1", "user-a"),
      ]);

      const all = await caller.user.admin.getReports({ status: null });

      expect(prisma.report.groupBy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { reportedUserId: { in: ["user-a"] } },
        }),
      );
      expect(all.countedStatus).toBeNull();
    });

    it("puts each group's count on every row about that user", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([
        reportRow("report-1", "user-a"),
        reportRow("report-2", "user-b"),
        reportRow("report-3", "user-a"),
      ]);
      prisma.report.groupBy.mockResolvedValue([
        { reportedUserId: "user-a", _count: { _all: 3 } },
        { reportedUserId: "user-b", _count: { _all: 1 } },
      ]);

      const { reports } = await caller.user.admin.getReports();

      expect(reports.map((r) => [r.id, r.reportsAboutUser])).toEqual([
        ["report-1", 3],
        ["report-2", 1],
        ["report-3", 3],
      ]);
    });

    it("spends no query on an empty page", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([]);

      const { reports } = await caller.user.admin.getReports();

      expect(reports).toEqual([]);
      expect(prisma.report.groupBy).not.toHaveBeenCalled();
    });

    /**
     * The count is an aggregate and must stay one. A `select` or `include`
     * reaching the other reporters would hand every admin reading one row a
     * copy of other people's reports, which is the thing this column was
     * deliberately kept narrow to avoid.
     */
    it("reads no column but the one it groups by", async () => {
      const { caller, prisma } = callerFor();
      prisma.report.findMany.mockResolvedValue([
        reportRow("report-1", "user-a"),
      ]);

      await caller.user.admin.getReports();

      const args = prisma.report.groupBy.mock.calls[0][0];
      expect(Object.keys(args).sort()).toEqual(["_count", "by", "where"]);
      expect(selectsField(args, "message")).toBe(false);
      expect(selectsField(args, "conversationSnapshot")).toBe(false);
    });
  });
});

describe("resolveReport", () => {
  it("issues one atomic UPDATE guarded on OPEN, then writes an audit entry", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));

    const result = await caller.user.admin.resolveReport({
      reportId: "report-1",
      status: ReportStatus.REVIEWED,
    });

    expect(result).toEqual({ id: "report-1", status: ReportStatus.REVIEWED });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "admin-1",
        action: "user.admin.resolveReport",
        targetId: "report-1",
        metadata: JSON.stringify({ status: ReportStatus.REVIEWED }),
      },
    });
  });

  it("rejects a status other than REVIEWED or DISMISSED", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));

    await expect(
      caller.user.admin.resolveReport({
        reportId: "report-1",
        status: ReportStatus.OPEN as never,
      }),
    ).rejects.toThrow();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND when the id names no report, writing no audit entry", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));
    prisma.$executeRaw.mockResolvedValueOnce(0);
    prisma.report.findUnique.mockResolvedValueOnce(null);

    await expect(
      caller.user.admin.resolveReport({
        reportId: "missing",
        status: ReportStatus.DISMISSED,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("answers CONFLICT when the report exists but is no longer OPEN", async () => {
    const { caller, prisma } = callerFor(adminSession(Permission.ADMIN));
    prisma.$executeRaw.mockResolvedValueOnce(0);
    prisma.report.findUnique.mockResolvedValueOnce({ id: "report-1" });

    await expect(
      caller.user.admin.resolveReport({
        reportId: "report-1",
        status: ReportStatus.DISMISSED,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
