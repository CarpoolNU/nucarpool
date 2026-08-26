import { adminRouter, router } from "../createRouter";
import { z } from "zod";
import { Permission, Prisma, Role, Status } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { addWeeks, startOfWeek } from "date-fns";
import {
  buildLineChartData,
  generateWeekLabels,
  summariseConversations,
  summariseUsers,
} from "../../../utils/adminDataUtils";
import { AdminUserRow } from "../../../utils/types";

/**
 * Admin dashboard queries. `adminRouter` already restricts these to ADMIN and
 * MANAGER; `updateUserPermission` additionally requires MANAGER.
 *
 * SCRUM-246 reshaped this router around one rule: the browser gets aggregates,
 * not tables. Before, the dashboard downloaded every user, group, request,
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
    .input(z.object({ start: z.date(), end: z.date() }))
    .query(async ({ ctx, input }) => {
      const weekLabels = generateWeekLabels([input.start, input.end]);
      const dateCreated = {
        gte: startOfWeek(input.start),
        lt: addWeeks(startOfWeek(input.end), 1),
      };

      const [users, groups, requests] = await Promise.all([
        ctx.prisma.user.findMany({
          where: { email: { not: null }, dateCreated },
          select: {
            dateCreated: true,
            carpoolSearches: { select: { status: true }, ...FIRST_SEARCH },
          },
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

      // A user with no CarpoolSearch counts as inactive, matching the defaults
      // the rest of the app applies when it flattens a user.
      const activeUsers = users.filter(
        (user) => user.carpoolSearches[0]?.status === Status.ACTIVE,
      );
      const inactiveUsers = users.filter(
        (user) => user.carpoolSearches[0]?.status !== Status.ACTIVE,
      );

      const requestsByRole = (role: Role) =>
        requests.filter(
          (request) =>
            (request.fromUser.carpoolSearches[0]?.role ?? Role.VIEWER) === role,
        );

      return {
        weekLabels,
        ...buildLineChartData(
          activeUsers,
          inactiveUsers,
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
      // rather than as a refusal the UI could report (SCRUM-246).
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

      return ctx.prisma.user.update({
        where: {
          id: input.userId,
        },
        data: {
          permission: input.permission,
        },
      });
    }),
});
