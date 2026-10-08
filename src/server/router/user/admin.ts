import { adminRouter, router } from "../createRouter";
import { z } from "zod";
import {
  Permission,
  Prisma,
  ReportStatus,
  RequestStatus,
  Role,
  Status,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { addWeeks, startOfWeek } from "date-fns";
import {
  buildLineChartData,
  generateWeekLabels,
  MAX_DASHBOARD_WEEKS,
  summariseConversations,
  summariseSupplyByCity,
  summariseUsers,
  weeksSpanned,
} from "../../adminDataUtils";
import { AdminSupplyQueryRow, AdminUserRow } from "../../../utils/types";
import { AdminAuditAction, buildAuditLogEntry } from "../../adminAuditLog";
import { parseConversationSnapshot } from "../../reportSnapshot";

/** How many rows the audit log's list view reads back. Static — there is no
 * client-supplied window here, unlike `dashboardWindow` above, so a fixed
 * ceiling is sufficient rather than a validated one. */
const AUDIT_LOG_PAGE_SIZE = 500;

/**
 * The default and maximum number of reports one `getReports` page carries.
 * The worst case is 500 reports each carrying a full 50-message snapshot, a
 * few megabytes.
 *
 * Used to be the whole of the queue - unpaginated, so a script filing OPEN
 * reports against every user it could see pushed genuinely
 * unresolved reports past the newest 500 and out of what an admin could ever
 * see. `getReports` now pages with a cursor, so a flood makes the queue
 * longer rather than making the rest of it invisible; the per-reporter rate
 * limit in `reports.ts` is what keeps the flood itself from being free.
 */
const REPORT_QUEUE_PAGE_SIZE = 500;

/**
 * The input `getReports` accepts. All optional, so the existing bare call
 * (`getReports()`) keeps working: `status` defaults to OPEN, matching the
 * queue an admin actually needs to act on, and `null` is the explicit way to
 * ask for every status instead. `cursor`/`limit` follow `messages.conversation`
 * and `getReports`'s own `dateCreated, id` ordering below.
 *
 * `direction` is not something any caller writes, and the resolver never reads
 * it. It is declared because tRPC's `useInfiniteQuery` client adds it to the
 * input of every infinite query it sends - `getClientArgs` merges
 * `direction: "forward"` in on the very first page, before a cursor exists -
 * and nothing between there and here strips it. Under `.strict()` that made
 * the report queue fail to load for every admin with a BAD_REQUEST
 * (`Unrecognized key: "direction"`), which the UI can only show as "we could
 * not load the reports".
 *
 * Declaring it beats dropping `.strict()`, which is load-bearing here for the
 * reason the router README gives: unknown keys are rejected rather than
 * silently ignored, so a field cannot creep back into the resolver. Paging is
 * forward-only - the component sets no `getPreviousPageParam` - so
 * `"backward"` is accepted and ignored rather than being a second code path.
 */
const getReportsInput = z
  .object({
    status: z.nativeEnum(ReportStatus).nullable().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(REPORT_QUEUE_PAGE_SIZE).optional(),
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict()
  .optional();

/**
 * Admin dashboard queries. `adminRouter` already restricts these to ADMIN and
 * MANAGER; `updateUserPermission` additionally requires MANAGER.
 *
 * This router is shaped around one rule: the browser gets aggregates, not
 * tables. The dashboard used to download every user, group, request,
 * conversation and message — `getMessages` selected `content`, so the full text
 * of every private message on the platform was transferred to an admin's browser
 * in order to draw a line chart — and then filtered it with a client-side date
 * slider, so narrowing the window never reduced the data fetched.
 *
 * What that means for the read profile:
 *
 * - Message rows never leave MySQL. `getDashboardStats` aggregates them with
 *   `groupBy`, returning one row per conversation rather than one per message,
 *   and `content` is not selected anywhere in this file.
 * - The line-chart series are bounded by the requested date range, pushed into
 *   the `where` clause, and select `dateCreated` plus at most one enum.
 * - The user table is read once per query with a handful of narrow columns,
 *   through a nested `select` instead of the second `findMany` plus O(n^2)
 *   `.find()` join this router used to do.
 *
 * Two aggregations still finish in Node rather than in SQL, deliberately: the
 * weekly bucketing (a Sunday-start week boundary needs a raw query, and the
 * `null` gap logic is shared with the chart) and the days-working frequency
 * (`daysWorking` is a comma-separated bitmask string). Both run over projections
 * that are already narrow, and both emit O(weeks) or O(1) numbers on the wire.
 */

/**
 * A "carpool" for dashboard purposes: a group with at least one driver and at
 * least one rider. Every such group necessarily has two or more members, which
 * is why `groupCount` can be a plain `count` rather than a filter over rows.
 */
const MIXED_ROLE_GROUP: Prisma.CarpoolGroupWhereInput = {
  AND: [
    { carpoolSearches: { some: { role: Role.DRIVER } } },
    { carpoolSearches: { some: { role: Role.RIDER } } },
  ],
};

/** The code assumes one CarpoolSearch per user, as the rest of the app does. */
const FIRST_SEARCH = { take: 1 } as const;

/** Reported when a dashboard window runs backwards. */
export const DASHBOARD_WINDOW_ORDER_MESSAGE =
  "End date cannot be before the start date";

/** Reported when a dashboard window is too wide to chart. Names the ceiling. */
export const DASHBOARD_WINDOW_SPAN_MESSAGE = `Date range cannot span more than ${MAX_DASHBOARD_WEEKS} weeks`;

/** What `resolveReport` is refused with when `reportId` names no report. */
export const REPORT_NOT_FOUND_MESSAGE = "Report not found.";

/**
 * What `resolveReport` is refused with when the report is no longer `OPEN` —
 * already resolved, whether by this admin or by another one racing it.
 */
export const REPORT_ALREADY_RESOLVED_MESSAGE =
  "This report has already been resolved.";

/** The only two statuses `resolveReport` may transition a report to. */
const resolveReportInput = z
  .object({
    reportId: z.string().min(1),
    status: z.enum([ReportStatus.REVIEWED, ReportStatus.DISMISSED]),
  })
  .strict();

/**
 * The window `getDashboardSeries` accepts.
 *
 * `z.object({ start: z.date(), end: z.date() })` was the whole of it, which
 * left two holes.
 *
 * The serious one is the span. The handler turns the window into one array
 * element per week *before* any database work — `generateWeekLabels` computes
 * the week count from the two dates and loops — so the iteration count comes
 * straight from client input with no relation to how much data exists.
 * `superjson` carries a `Date` intact and JavaScript dates run to roughly
 * ±271,821 years, so a single request can ask for ~2.84e7 allocations —
 * measured, that exhausts a 2 GB heap in about eleven seconds. It is not a slow
 * query: the loop runs in-process before any I/O, so the process dies and takes
 * every other request the instance was serving with it. An admin mistyping a
 * year is enough; the input does not have to be hostile.
 *
 * The quieter one is ordering. `generateWeekLabels` takes `Math.min`/`Math.max`
 * internally so it accepts a reversed pair, but the `where` clause below is
 * built from the same two dates and is *not* order-insensitive: reversed, it
 * asks for `gte: <later>, lt: <earlier>` and matches nothing. The result was a
 * chart with axis labels and flat zero series — indistinguishable from a
 * genuinely quiet window, and reported as success.
 *
 * Bounded at the schema rather than inside `generateWeekLabels` so the caller
 * is told what was wrong; clamping downstream would draw a chart for a window
 * nobody asked for. This is also where every comparable input in the codebase
 * is bounded — `limit` in `messages.conversation`, `points` in
 * `mapbox.getDirections`, `contentLength` in `getPresignedUrl`.
 */
const dashboardWindow = z
  .object({ start: z.date(), end: z.date() })
  .strict()
  .superRefine((data, ctx) => {
    // Strict inversion only, matching `isReversedCoopRange`: a window whose
    // ends fall in the same week is a legitimate one-bucket chart.
    if (data.end.getTime() < data.start.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: DASHBOARD_WINDOW_ORDER_MESSAGE,
      });
      // A span computed from a reversed window is negative and meaningless;
      // reporting it too would bury the issue the admin can act on.
      return;
    }

    // `Number.isFinite` first, and not merely for tidiness: `weeksSpanned`
    // returns NaN within six days of the `Date` minimum, where `startOfWeek`
    // walks back past the representable range. `NaN > MAX_DASHBOARD_WEEKS` is
    // false, so a bare ceiling comparison would admit the single widest window
    // that exists — measured at ~2.84e7 weeks, which exhausts a 2 GB heap in
    // about eleven seconds.
    const weeks = weeksSpanned(data.start, data.end);
    if (!Number.isFinite(weeks) || weeks > MAX_DASHBOARD_WEEKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: DASHBOARD_WINDOW_SPAN_MESSAGE,
      });
    }
  });

export const adminDataRouter = router({
  /**
   * The user list behind `UserManagement`. Deliberately only what that screen
   * needs — the dashboard's charts no longer read this endpoint, so it no longer
   * carries role, status, schedule or group membership.
   */
  getAllUsers: adminRouter.query(async ({ ctx }) => {
    return ctx.prisma.user.findMany({
      where: {
        email: {
          not: null,
        },
      },
      select: {
        id: true,
        email: true,
        permission: true,
      },
    });
  }),

  /**
   * Bounds for the dashboard's date slider, as `MIN`/`MAX` aggregates per table.
   * Returns `null` when there is nothing to plot.
   */
  getDateRange: adminRouter.query(async ({ ctx }) => {
    const bounds = {
      _min: { dateCreated: true },
      _max: { dateCreated: true },
    } as const;

    const [users, groups, requests] = await Promise.all([
      ctx.prisma.user.aggregate({ where: { email: { not: null } }, ...bounds }),
      ctx.prisma.carpoolGroup.aggregate({ where: MIXED_ROLE_GROUP, ...bounds }),
      ctx.prisma.request.aggregate(bounds),
    ]);

    const present = (dates: (Date | null)[]): Date[] =>
      dates.filter((date): date is Date => date !== null);

    const minDates = present([
      users._min.dateCreated,
      groups._min.dateCreated,
      requests._min.dateCreated,
    ]);
    const maxDates = present([
      users._max.dateCreated,
      groups._max.dateCreated,
      requests._max.dateCreated,
    ]);

    if (minDates.length === 0 || maxDates.length === 0) {
      return { minDate: null, maxDate: null };
    }

    return {
      minDate: new Date(Math.min(...minDates.map((date) => date.getTime()))),
      maxDate: new Date(Math.max(...maxDates.map((date) => date.getTime()))),
    };
  }),

  /**
   * Cumulative weekly counts for the growth chart, over the requested window.
   *
   * The window is widened to whole weeks so the buckets line up with the labels,
   * then applied in the database. Unlike the client-side slider this replaced,
   * the x-axis now follows the selection rather than always spanning every user's
   * lifetime, and a narrower selection reads fewer rows.
   */
  getDashboardSeries: adminRouter
    .input(dashboardWindow)
    .query(async ({ ctx, input }) => {
      const weekLabels = generateWeekLabels([input.start, input.end]);
      const dateCreated = {
        gte: startOfWeek(input.start),
        lt: addWeeks(startOfWeek(input.end), 1),
      };

      const [users, groups, requests] = await Promise.all([
        ctx.prisma.user.findMany({
          where: { email: { not: null }, dateCreated },
          select: { dateCreated: true },
        }),
        ctx.prisma.carpoolGroup.findMany({
          where: { ...MIXED_ROLE_GROUP, dateCreated },
          select: { dateCreated: true },
        }),
        ctx.prisma.request.findMany({
          where: { dateCreated },
          select: {
            dateCreated: true,
            fromUser: {
              select: {
                carpoolSearches: { select: { role: true }, ...FIRST_SEARCH },
              },
            },
          },
        }),
      ]);

      // The sender's role *today*: a Request row does not record the role it
      // was sent under. See `buildLineChartData`.
      const requestsByRole = (role: Role) =>
        requests.filter(
          (request) =>
            (request.fromUser.carpoolSearches[0]?.role ?? Role.VIEWER) === role,
        );

      return {
        weekLabels,
        ...buildLineChartData(
          users,
          groups,
          requests,
          requestsByRole(Role.DRIVER),
          requestsByRole(Role.RIDER),
          weekLabels,
        ),
      };
    }),

  /**
   * The dashboard's date-independent aggregates: the user-counts matrix, the
   * days-working frequency, the drivers and riders available on each weekday,
   * carpool membership, conversation statistics and the
   * request funnel.
   *
   * Roughly thirty numbers plus one row per city on the wire, from eight database
   * queries, none of which selects a message body, an email address, a name or
   * a street address. The city query reads `location.city` and returns it only
   * as a group label with counts beside it.
   *
   * **`requestFunnel` is a snapshot of now, not a history.** A `Request` row and
   * its group are erased when a pair parts, so the counts describe current
   * pairings and a weekly series of them would silently shrink. The third stage
   * counts riders only, because one accepted request joins a rider to a group
   * whose driver has no request of their own; see `RequestFunnel`.
   */
  getDashboardStats: adminRouter.query(async ({ ctx }) => {
    const [
      users,
      groupCount,
      totalConversationCount,
      messageCounts,
      requestsSent,
      requestsAccepted,
      ridersInGroup,
      supplyByCity,
    ] = await Promise.all([
      ctx.prisma.user.findMany({
        where: { email: { not: null } },
        select: {
          isOnboarded: true,
          carpoolSearches: {
            select: {
              role: true,
              status: true,
              daysWorking: true,
              carpoolId: true,
            },
            ...FIRST_SEARCH,
          },
        },
      }),
      ctx.prisma.carpoolGroup.count({ where: MIXED_ROLE_GROUP }),
      ctx.prisma.conversation.count(),
      // Aggregated in MySQL: one row per conversation that has messages, and
      // no message row or body crosses the client boundary.
      ctx.prisma.message.groupBy({
        by: ["conversationId"],
        _count: { _all: true },
      }),
      ctx.prisma.request.count(),
      ctx.prisma.request.count({
        where: { status: RequestStatus.ACCEPTED },
      }),
      // One `CarpoolSearch` per user, so this counts distinct users.
      ctx.prisma.carpoolSearch.count({
        where: { role: Role.RIDER, carpoolId: { not: null } },
      }),
      // Grouped in MySQL, one row per distinct city, because Prisma's
      // `groupBy` cannot group by a column on a related table.
      //
      // The population is `summariseUsers`' `drivers` and `riders`: a user
      // with an email whose search is ACTIVE and whose role is DRIVER or
      // RIDER, so the rows sum to `driverAO + driverANO` and
      // `riderAO + riderANO`. VIEWERs are about a third of production and
      // are not demand. `LEFT JOIN location` and `COALESCE` keep a search
      // whose home location is missing or has no city in the totals as
      // `Unknown` rather than dropping it.
      //
      // `seats_avail` is what is left of the driver's seats - `reserveSeat`
      // decrements it - so the sum is open seats already, and `> 0` only
      // guards against a negative value pulling a city's total down. The
      // counts are cast to SIGNED because MySQL returns COUNT as a BigInt and
      // SUM as a Decimal, neither of which is a plain number.
      //
      // Raw SQL bypasses Prisma's field mapping: `seats_avail` is mapped,
      // `userId`, `homeLocationId`, `role` and `status` are not.
      ctx.prisma.$queryRaw<
        {
          city: string;
          drivers: bigint;
          riders: bigint;
          openSeats: bigint;
        }[]
      >`
          SELECT
            LOWER(TRIM(COALESCE(l.city, ''))) AS city,
            CAST(SUM(cs.role = ${Role.DRIVER}) AS SIGNED) AS drivers,
            CAST(SUM(cs.role = ${Role.RIDER}) AS SIGNED) AS riders,
            CAST(
              SUM(CASE WHEN cs.role = ${Role.DRIVER} AND cs.seats_avail > 0
                THEN cs.seats_avail ELSE 0 END) AS SIGNED
            ) AS openSeats
          FROM carpool_search cs
          INNER JOIN user u ON u.id = cs.userId AND u.email IS NOT NULL
          LEFT JOIN location l ON l.id = cs.homeLocationId
          WHERE cs.status = ${Status.ACTIVE}
            AND cs.role IN (${Role.DRIVER}, ${Role.RIDER})
          GROUP BY LOWER(TRIM(COALESCE(l.city, '')))
        `,
    ]);

    const rows: AdminUserRow[] = users.map((user) => {
      const search = user.carpoolSearches[0];
      return {
        isOnboarded: user.isOnboarded,
        role: search?.role ?? Role.VIEWER,
        status: search?.status ?? Status.INACTIVE,
        daysWorking: search?.daysWorking ?? "",
        carpoolId: search?.carpoolId ?? null,
      };
    });

    const { userCounts, daysFrequency, daysByWeekday, membership } =
      summariseUsers(rows);

    const supplyRows: AdminSupplyQueryRow[] = supplyByCity.map((row) => ({
      city: row.city,
      drivers: Number(row.drivers),
      riders: Number(row.riders),
      openSeats: Number(row.openSeats),
    }));

    return {
      userCounts,
      daysFrequency,
      daysByWeekday,
      supplyByCity: summariseSupplyByCity(supplyRows),
      groups: { groupCount, ...membership },
      conversations: summariseConversations(
        totalConversationCount,
        messageCounts.map((group) => group._count._all),
      ),
      requestFunnel: { requestsSent, requestsAccepted, ridersInGroup },
    };
  }),

  updateUserPermission: adminRouter
    .input(
      z.object({
        userId: z.string(),
        permission: z.nativeEnum(Permission),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // These were bare `Error`s, which reached the client as an opaque 500
      // rather than as a refusal the UI could report.
      const permission = ctx.session.user?.permission;
      if (permission !== "MANAGER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Unauthorized access.",
        });
      }
      if (input.userId === ctx.session.user?.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot change own permission.",
        });
      }

      // The audit log names an actor, and `ctx.session.user.id` is optional
      // only in its type (a session predating some field's introduction) —
      // `isAdmin` middleware already guarantees a session exists here, so a
      // missing id means something is unexpectedly wrong rather than that
      // this caller lacks permission, hence UNAUTHORIZED rather than FORBIDDEN.
      const actorId = ctx.session.user?.id;
      if (!actorId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      // A `userId` naming nobody is a manager's typo or a stale row in the
      // table they clicked from, not a fault. It used to run straight into
      // `tx.user.update`, where Prisma throws `P2025` for a record it cannot
      // find — not a `TRPCError`, so it left the same masked 500 the FORBIDDEN
      // checks above were written to remove, and the manager was told nothing
      // about which part went wrong.
      //
      // Outside the transaction deliberately: it is a read, it commits
      // nothing, and failing before the transaction opens keeps the atomic
      // section to the two writes that genuinely belong together.
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });

      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found.",
        });
      }

      // One transaction so the permission change and its audit entry either
      // both land or neither does — a permission change must never happen
      // without a corresponding record.
      return ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: {
            id: input.userId,
          },
          data: {
            permission: input.permission,
          },
        });

        await tx.adminAuditLog.create({
          data: buildAuditLogEntry({
            actorId,
            action: AdminAuditAction.UPDATE_USER_PERMISSION,
            targetId: input.userId,
            metadata: { permission: input.permission },
          }),
        });

        return updated;
      });
    }),

  /**
   * The audit log's list view. Most recent first, and bounded rather than
   * paginated — a simple list view is all that's needed here, and admin
   * mutations are rare enough that a static ceiling is sufficient for now.
   *
   * Returns raw ids; the client resolves them to emails through
   * `getAllUsers`, which it already fetches for `UserManagement`, rather than
   * this procedure denormalizing an email onto every row.
   *
   * **`targetId` is not always a user**, which is why each row also carries
   * `targetUserId`. `resolveReport` writes a report id, and the person an
   * admin's decision concerned is that report's reported user — an id the
   * client cannot reach, since the only other query it holds is
   * `getAllUsers`. Resolving it here is what lets the Target column name a
   * person on every row instead of printing a cuid.
   *
   * The reported user is read as two columns, deliberately not by reusing
   * `getReports`: that query carries a full conversation snapshot per report,
   * and nothing about naming a user needs message text. One `findMany` over
   * the page's report ids, so the query count does not grow with the number
   * of resolution rows.
   */
  getAuditLog: adminRouter.query(async ({ ctx }) => {
    const entries = await ctx.prisma.adminAuditLog.findMany({
      orderBy: { dateCreated: "desc" },
      take: AUDIT_LOG_PAGE_SIZE,
    });

    const reportIds = [
      ...new Set(
        entries
          .filter((entry) => entry.action === AdminAuditAction.RESOLVE_REPORT)
          .map((entry) => entry.targetId),
      ),
    ];

    // `in: []` is a statement with no possible match, so a page with no
    // resolution rows asks nothing.
    const reportedUserByReport = new Map<string, string>(
      reportIds.length === 0
        ? []
        : (
            await ctx.prisma.report.findMany({
              where: { id: { in: reportIds } },
              select: { id: true, reportedUserId: true },
            })
          ).map((report) => [report.id, report.reportedUserId]),
    );

    return entries.map((entry) => ({
      ...entry,
      /*
       * `null` for a row whose target is a user already — the client reads
       * `targetId` for those — and for a report id with no surviving row,
       * which the Target column renders differently from a user it cannot
       * name.
       */
      targetUserId: reportedUserByReport.get(entry.targetId) ?? null,
    }));
  }),

  /**
   * The report queue. Most recent first, cursor-paged. Resolving a report is
   * `resolveReport` below.
   *
   * **This is the one admin read that returns message text**, and it is the
   * exception the header's rule allows for. A snapshot is a copy of a thread
   * that one of its two parties chose to submit for review, made when they
   * filed the report. Nothing here reads the `message` table.
   *
   * Like `getAuditLog`, it returns raw user ids, and the client resolves them
   * through `getAllUsers`. The snapshot is parsed here, so the client gets
   * typed messages rather than a JSON string.
   *
   * **Defaults to OPEN.** An admin working the queue wants what still needs
   * review; a reviewed or dismissed report competing for the same page pushes
   * that further away for no reason. Pass `status: null` for every status,
   * or a specific one to look at what was already resolved.
   *
   * Ordered by `(dateCreated, id)`, not `dateCreated` alone, for the same
   * reason as `messages.conversation`: two reports filed in the same request
   * can share a timestamp, and a cursor over a non-total order can skip or
   * repeat a row across pages.
   *
   * **Each row carries `reportsAboutUser`**, how many reports concern the same
   * `reportedUserId`. Without it the queue is a flat list of rows and a
   * repeat offender reads as several unrelated reports: recency is the only
   * thing the ordering surfaces, and repetition — the other signal that
   * should escalate a report — was invisible unless an admin read the whole
   * queue and remembered names.
   *
   * **The count is scoped to the status being viewed**, and `countedStatus`
   * says which that was so the client can label it rather than leaving the
   * reader to guess. "Three open reports about this person" and "three
   * reports ever, two already dismissed" call for different things from an
   * admin, so a number without its scope is worse than no number. Viewing
   * `All` counts every status, which is the same statement with a wider
   * scope.
   *
   * It is deliberately only a count. Naming the other reporters, or carrying
   * any of their text, would hand each admin a second copy of content the
   * queue already shows one row at a time — and the point here is to rank the
   * queue, not to widen what one read discloses.
   */
  getReports: adminRouter
    .input(getReportsInput)
    .query(async ({ ctx, input }) => {
      // `??` would coalesce `null` (explicitly "every status") into OPEN along
      // with `undefined` (the field omitted) - the two have to read as
      // different requests, so only `undefined` falls through to the default.
      const status =
        input?.status === undefined ? ReportStatus.OPEN : input.status;
      const limit = input?.limit ?? REPORT_QUEUE_PAGE_SIZE;

      // One extra row, to learn whether another page exists without a second
      // round trip or a `count` over the whole queue.
      const rows = await ctx.prisma.report.findMany({
        where: status === null ? undefined : { status },
        orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input?.cursor
          ? { cursor: { id: input.cursor }, skip: 1 }
          : undefined),
        select: {
          id: true,
          reporterId: true,
          reportedUserId: true,
          reason: true,
          message: true,
          requestId: true,
          conversationSnapshot: true,
          status: true,
          dateCreated: true,
        },
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // One `GROUP BY` over the reported users *on this page*, not over the
      // whole table: the `in` bounds the scan the way the page bounds the
      // read, while each group still counts every report about that user and
      // not merely the ones that fit on the page. An empty page needs no
      // query at all — `in: []` is a statement with no possible match.
      //
      // A plain aggregate, so `relationMode = "prisma"` has nothing to do
      // here: there is no relation to traverse and no join to emulate.
      const reportedUserIds = [...new Set(page.map((r) => r.reportedUserId))];
      const countsByUser = new Map<string, number>(
        reportedUserIds.length === 0
          ? []
          : (
              await ctx.prisma.report.groupBy({
                by: ["reportedUserId"],
                where: {
                  reportedUserId: { in: reportedUserIds },
                  // The same slice the page is showing, so the number beside
                  // a row and the rows an admin can reach by paging are
                  // answers to one question. `countedStatus` below reports
                  // which slice that was.
                  ...(status === null ? undefined : { status }),
                },
                _count: { _all: true },
              })
            ).map((group) => [group.reportedUserId, group._count._all]),
      );

      return {
        reports: page.map(({ conversationSnapshot, ...row }) => ({
          ...row,
          conversationSnapshot: parseConversationSnapshot(conversationSnapshot),
          // The row itself is always in its own group, so the floor is 1 and
          // the `?? 1` is for a report deleted between the two queries rather
          // than for a missing group.
          reportsAboutUser: countsByUser.get(row.reportedUserId) ?? 1,
        })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
        /** Which statuses `reportsAboutUser` counted. `null` is every one. */
        countedStatus: status,
      };
    }),

  /**
   * Transitions a `Report` out of `OPEN`. Before this procedure existed,
   * nothing ever moved a report to `REVIEWED` or `DISMISSED`, so the
   * duplicate-report guard in `reports.ts` — keyed on `OPEN` — made a user's
   * first report against someone also their last.
   *
   * The `WHERE … AND status = 'OPEN'` check and the write are one
   * `$executeRaw` statement rather than a `findFirst` followed by `update`,
   * for the reason `claimRequestNotification` in `email.ts` documents:
   * `relationMode = "prisma"` makes a filtered `updateMany` read matching ids
   * and then update by id, so two admins racing to resolve the same report
   * would both see a match and the second write would silently overwrite the
   * first with no error. A single `UPDATE` is atomic in InnoDB, so only one
   * of two concurrent calls can ever affect a row.
   *
   * The write and its audit entry are one transaction, matching
   * `updateUserPermission`: a report can never end up resolved with no
   * corresponding `AdminAuditLog` row.
   */
  resolveReport: adminRouter
    .input(resolveReportInput)
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.session.user?.id;
      if (!actorId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      return ctx.prisma.$transaction(async (tx) => {
        const changed = await tx.$executeRaw`
          UPDATE \`report\` SET \`status\` = ${input.status}
          WHERE \`id\` = ${input.reportId} AND \`status\` = ${ReportStatus.OPEN}
        `;

        if (changed !== 1) {
          // Either the id names no report, or it is no longer OPEN. A second
          // read tells the caller which, rather than one message covering
          // both.
          const existing = await tx.report.findUnique({
            where: { id: input.reportId },
            select: { id: true },
          });
          throw new TRPCError({
            code: existing ? "CONFLICT" : "NOT_FOUND",
            message: existing
              ? REPORT_ALREADY_RESOLVED_MESSAGE
              : REPORT_NOT_FOUND_MESSAGE,
          });
        }

        await tx.adminAuditLog.create({
          data: buildAuditLogEntry({
            actorId,
            action: AdminAuditAction.RESOLVE_REPORT,
            targetId: input.reportId,
            metadata: { status: input.status },
          }),
        });

        return { id: input.reportId, status: input.status };
      });
    }),
});
