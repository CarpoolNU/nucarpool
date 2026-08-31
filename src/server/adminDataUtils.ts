import { addWeeks, differenceInWeeks, startOfWeek } from "date-fns";
import { Role, Status } from "@prisma/client";
import {
  AdminUserCounts,
  AdminUserRow,
  ConversationStats,
} from "../utils/types";

/**
 * Pure aggregation for the admin dashboard.
 *
 * These run on the server, inside `user.admin.getDashboardStats`
 * and `getDashboardSeries`, rather than in the browser: the dashboard used to
 * download whole tables and reduce them client-side. They stay here, free of
 * Prisma and of React, so they remain unit-testable — see `adminDataUtils.test.ts`.
 *
 * Week bucketing uses `startOfWeek`, which is timezone-sensitive. Running on the
 * server means the buckets follow the server's timezone rather than each admin's,
 * so the chart is now the same for every viewer instead of shifting per browser.
 */

interface ItemWithDate {
  dateCreated: Date;
}

export const countCumulativeItemsPerWeek = (
  items: ItemWithDate[],
  weekLabels: Date[],
): (number | null)[] => {
  const counts: (number | null)[] = [];
  let cumulativeCount = 0;
  let prevCount = 0;
  let itemIndex = 0;
  const sortedItems = items
    .slice()
    .sort(
      (a, b) =>
        new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime(),
    );

  weekLabels.forEach((weekStart, index) => {
    const weekEnd = addWeeks(weekStart, 1);
    while (
      itemIndex < sortedItems.length &&
      new Date(sortedItems[itemIndex].dateCreated) < weekEnd
    ) {
      cumulativeCount++;
      itemIndex++;
    }

    if (index === 0 || cumulativeCount > prevCount) {
      counts.push(cumulativeCount);
    } else {
      counts.push(null);
    }
    prevCount = cumulativeCount;
  });

  return counts;
};

export function generateWeekLabels(allDates: Date[]): Date[] {
  let weekLabels: Date[] = [];

  if (allDates.length > 0) {
    const minWeekDate = startOfWeek(
      new Date(Math.min(...allDates.map((date) => date.getTime()))),
    );
    const maxWeekDate = startOfWeek(
      new Date(Math.max(...allDates.map((date) => date.getTime()))),
    );

    const weeksDifference = differenceInWeeks(maxWeekDate, minWeekDate) + 1;

    for (let i = 0; i < weeksDifference; i++) {
      const weekStart = addWeeks(minWeekDate, i);
      weekLabels.push(weekStart);
    }
  }

  return weekLabels;
}

export function buildLineChartData(
  activeUsers: ItemWithDate[],
  inactiveUsers: ItemWithDate[],
  groups: ItemWithDate[],
  requests: ItemWithDate[],
  driverRequests: ItemWithDate[],
  riderRequests: ItemWithDate[],
  weekLabels: Date[],
) {
  return {
    activeUserCount: countCumulativeItemsPerWeek(activeUsers, weekLabels),
    inactiveUserCount: countCumulativeItemsPerWeek(inactiveUsers, weekLabels),
    groupCounts: countCumulativeItemsPerWeek(groups, weekLabels),
    requestCount: countCumulativeItemsPerWeek(requests, weekLabels),
    driverRequestCount: countCumulativeItemsPerWeek(driverRequests, weekLabels),
    riderRequestCount: countCumulativeItemsPerWeek(riderRequests, weekLabels),
  };
}

/**
 * `daysWorking` is a seven-character comma-separated bitmask, so this one cannot
 * be pushed into SQL without a raw query — it is aggregated in Node instead, over
 * a projection that selects only `role` and `daysWorking`.
 */
export function getDaysFrequency(
  riders: { daysWorking: string }[],
  drivers: { daysWorking: string }[],
) {
  const riderDayCount = [0, 0, 0, 0, 0, 0, 0];
  const driverDayCount = [0, 0, 0, 0, 0, 0, 0];

  riders.forEach((rider) => {
    rider.daysWorking.split(",").forEach((day, index) => {
      if (day === "1") {
        riderDayCount[index] += 1;
      }
    });
  });
  drivers.forEach((driver) => {
    driver.daysWorking.split(",").forEach((day, index) => {
      if (day === "1") {
        driverDayCount[index] += 1;
      }
    });
  });
  return {
    riderDayCount,
    driverDayCount,
  };
}

export function countRole(arr: { role: Role }[], role: Role) {
  return arr.filter((u) => u.role === role).length;
}

/** The four "onboarding" quadrants the user-counts bar chart is built from. */
const quadrants = (rows: AdminUserRow[]) => ({
  AO: rows.filter((u) => u.status === Status.ACTIVE && u.isOnboarded),
  ANO: rows.filter((u) => u.status === Status.ACTIVE && !u.isOnboarded),
  IO: rows.filter((u) => u.status !== Status.ACTIVE && u.isOnboarded),
  INO: rows.filter((u) => u.status !== Status.ACTIVE && !u.isOnboarded),
});

/**
 * Reduces one narrow row per user into the ~25 numbers the dashboard renders.
 *
 * A user with no `CarpoolSearch` arrives here as `VIEWER`/`INACTIVE`, matching the
 * defaults the flattening in `user.me` applies. Only the first search is read, in
 * line with the one-search-per-user assumption the rest of the codebase makes.
 */
export function summariseUsers(rows: AdminUserRow[]) {
  const { AO, ANO, IO, INO } = quadrants(rows);

  const totalAO = AO.length;
  const totalANO = ANO.length;
  const totalIO = IO.length;
  const totalINO = INO.length;

  const driverAO = countRole(AO, Role.DRIVER);
  const driverANO = countRole(ANO, Role.DRIVER);
  const driverIO = countRole(IO, Role.DRIVER);
  const driverINO = countRole(INO, Role.DRIVER);

  const riderAO = countRole(AO, Role.RIDER);
  const riderANO = countRole(ANO, Role.RIDER);
  const riderIO = countRole(IO, Role.RIDER);
  const riderINO = countRole(INO, Role.RIDER);

  const userCounts: AdminUserCounts = {
    totalAO,
    totalANO,
    totalIO,
    totalINO,
    driverAO,
    driverANO,
    driverIO,
    driverINO,
    riderAO,
    riderANO,
    riderIO,
    riderINO,
    viewerAO: totalAO - driverAO - riderAO,
    viewerANO: totalANO - driverANO - riderANO,
    viewerIO: totalIO - driverIO - riderIO,
    viewerINO: totalINO - driverINO - riderINO,
  };

  const activeUsers = [...AO, ...ANO];
  const drivers = activeUsers.filter((u) => u.role === Role.DRIVER);
  const riders = activeUsers.filter((u) => u.role === Role.RIDER);
  const inGroup = (u: AdminUserRow) => !!u.carpoolId && u.carpoolId !== "";

  return {
    userCounts,
    // Previously `getDaysFrequency(drivers, riders)` against a `(riders, drivers)`
    // signature, which swapped the two series in the chart.
    daysFrequency: getDaysFrequency(riders, drivers),
    membership: {
      driversInGroup: drivers.filter(inGroup).length,
      ridersInGroup: riders.filter(inGroup).length,
      totalDrivers: drivers.length,
      // Mirrors the dashboard's long-standing definition: every active user who
      // is not a driver, so VIEWERs are counted here too.
      totalRiders: activeUsers.length - drivers.length,
    },
  };
}

/**
 * `messageCountsPerConversation` comes from a `message.groupBy` on the database,
 * so no message row — and no message body — ever leaves MySQL. Conversations with
 * no messages are absent from it, which is why the totals are passed separately.
 */
export function summariseConversations(
  totalConversationCount: number,
  messageCountsPerConversation: number[],
): ConversationStats {
  const sum = (counts: number[]) => counts.reduce((acc, n) => acc + n, 0);
  const withMoreThanOne = messageCountsPerConversation.filter((n) => n > 1);

  return {
    totalConversationCount,
    totalWithMsgCount: withMoreThanOne.length,
    avgConvWithMsg: withMoreThanOne.length
      ? sum(withMoreThanOne) / withMoreThanOne.length
      : 0,
    avgMsg: totalConversationCount
      ? sum(messageCountsPerConversation) / totalConversationCount
      : 0,
  };
}
