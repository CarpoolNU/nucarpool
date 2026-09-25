import { adminRouter, router } from "../createRouter";
import { z } from "zod";
import { Permission, Prisma, ReportStatus, Role, Status } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { addWeeks, startOfWeek } from "date-fns";
import {
  buildLineChartData,
  generateWeekLabels,
  MAX_DASHBOARD_WEEKS,
  summariseConversations,
  summariseUsers,
  weeksSpanned,
} from "../../adminDataUtils";
import { AdminUserRow } from "../../../utils/types";
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
 * reports against every user it could see (SCRUM-562) pushed genuinely
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
 */
const getReportsInput = z
  .object({
    status: z.nativeEnum(ReportStatus).nullable().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(REPORT_QUEUE_PAGE_SIZE).optional(),
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
   * days-working frequency, carpool membership and conversation statistics.
   *
   * Roughly thirty numbers on the wire, from four database queries, none of which
   * selects a message body, an email address, a name or a location.
   */
  getDashboardStats: adminRouter.query(async ({ ctx }) => {
    const [users, groupCount, totalConversationCount, messageCounts] =
      await Promise.all([
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

    const { userCounts, daysFrequency, membership } = summariseUsers(rows);

    return {
      userCounts,
      daysFrequency,
      groups: { groupCount, ...membership },
      conversations: summariseConversations(
        totalConversationCount,
        messageCounts.map((group) => group._count._all),
      ),
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

      // One transaction so the permission change and its audit entry either
      // both land or neither does — SCRUM-541 exists precisely so a
      // permission change can never happen without a corresponding record.
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
   * paginated — SCRUM-541 asks for "a simple list view", and admin mutations
   * are rare enough that a static ceiling is sufficient for now.
   *
   * Returns raw `actorId`/`targetId`; the client resolves those to emails
   * through `getAllUsers`, which it already fetches for `UserManagement`,
   * rather than this procedure joining and denormalizing that itself.
   */
  getAuditLog: adminRouter.query(async ({ ctx }) => {
    return ctx.prisma.adminAuditLog.findMany({
      orderBy: { dateCreated: "desc" },
      take: AUDIT_LOG_PAGE_SIZE,
    });
  }),

  /**
   * The report queue (SCRUM-555). Read-only, most recent first, cursor-paged
   * (SCRUM-562). Resolving a report is SCRUM-552.
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

      return {
        reports: page.map(({ conversationSnapshot, ...row }) => ({
          ...row,
          conversationSnapshot: parseConversationSnapshot(conversationSnapshot),
        })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
      };
    }),
});
