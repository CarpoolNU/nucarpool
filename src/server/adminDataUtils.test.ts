import { Role, Status } from "@prisma/client";
import { addWeeks } from "date-fns";
import {
  buildLineChartData,
  countCumulativeItemsPerWeek,
  countRole,
  generateWeekLabels,
  getDaysFrequency,
  MAX_DASHBOARD_WEEKS,
  OTHER_CITIES_LABEL,
  SUPPLY_TOP_CITY_LIMIT,
  UNKNOWN_CITY_LABEL,
  summariseConversations,
  summariseSupplyByCity,
  summariseUsers,
  weeksSpanned,
} from "./adminDataUtils";
import type { AdminSupplyQueryRow, AdminUserRow } from "../utils/types";

/**
 * The admin dashboard's aggregations. These run inside the `user.admin` router
 * rather than in the browser, so the numbers asserted here are the ones that go
 * over the wire — the client only formats them.
 *
 * The interesting behaviour is the weekly bucketing, the deliberate `null` gaps
 * that keep flat stretches off the line, and the defaults applied to a user who
 * has no `CarpoolSearch`.
 */

// 2024-01-01 is a Monday, so these three Sundays are consecutive week starts.
const WEEK_0 = new Date(2024, 0, 7);
const WEEK_1 = new Date(2024, 0, 14);
const WEEK_2 = new Date(2024, 0, 21);

const on = (year: number, month: number, dayOfMonth: number) =>
  new Date(year, month - 1, dayOfMonth);

const user = (overrides: Partial<AdminUserRow> = {}): AdminUserRow => ({
  isOnboarded: true,
  role: Role.RIDER,
  status: Status.ACTIVE,
  daysWorking: "0,1,1,1,1,1,0",
  carpoolId: null,
  ...overrides,
});

describe("countCumulativeItemsPerWeek", () => {
  it("accumulates counts across the weeks and omits flat weeks with null", () => {
    const counts = countCumulativeItemsPerWeek(
      [
        { dateCreated: on(2024, 1, 8) },
        { dateCreated: on(2024, 1, 9) },
        { dateCreated: on(2024, 1, 22) },
      ],
      [WEEK_0, WEEK_1, WEEK_2],
    );

    expect(counts).toEqual([2, null, 3]);
  });

  it("always reports the first week, even when it is zero", () => {
    expect(countCumulativeItemsPerWeek([], [WEEK_0, WEEK_1])).toEqual([
      0,
      null,
    ]);
  });

  it("counts everything older than the first week label into that first week", () => {
    const counts = countCumulativeItemsPerWeek(
      [{ dateCreated: on(2020, 5, 1) }, { dateCreated: on(2024, 1, 8) }],
      [WEEK_0, WEEK_1],
    );

    expect(counts).toEqual([2, null]);
  });

  it("never decreases, since the count is cumulative", () => {
    const counts = countCumulativeItemsPerWeek(
      [
        { dateCreated: on(2024, 1, 8) },
        { dateCreated: on(2024, 1, 15) },
        { dateCreated: on(2024, 1, 22) },
      ],
      [WEEK_0, WEEK_1, WEEK_2],
    );

    expect(counts).toEqual([1, 2, 3]);
  });

  it("does not depend on the input order", () => {
    const items = [
      { dateCreated: on(2024, 1, 22) },
      { dateCreated: on(2024, 1, 8) },
      { dateCreated: on(2024, 1, 9) },
    ];

    expect(
      countCumulativeItemsPerWeek(items, [WEEK_0, WEEK_1, WEEK_2]),
    ).toEqual([2, null, 3]);
  });

  it("does not mutate the caller's array", () => {
    const items = [
      { dateCreated: on(2024, 1, 22) },
      { dateCreated: on(2024, 1, 8) },
    ];
    const order = [...items];

    countCumulativeItemsPerWeek(items, [WEEK_0, WEEK_1, WEEK_2]);

    expect(items).toEqual(order);
  });

  it("returns nothing when there are no weeks to report on", () => {
    expect(countCumulativeItemsPerWeek([{ dateCreated: WEEK_0 }], [])).toEqual(
      [],
    );
  });
});

describe("generateWeekLabels", () => {
  it("returns no labels for no dates", () => {
    expect(generateWeekLabels([])).toEqual([]);
  });

  it("returns a single label when every date falls in one week", () => {
    expect(generateWeekLabels([on(2024, 1, 8), on(2024, 1, 10)])).toEqual([
      WEEK_0,
    ]);
  });

  it("returns one consecutive label per week spanned, inclusive of both ends", () => {
    expect(generateWeekLabels([on(2024, 1, 8), on(2024, 1, 22)])).toEqual([
      WEEK_0,
      WEEK_1,
      WEEK_2,
    ]);
  });

  /**
   * Order-insensitive by construction — the function takes `Math.min` and
   * `Math.max` of its argument. Worth pinning, but note that
   * `getDashboardSeries` no longer leans on it: the `where` clause it builds
   * from the same two dates *is* order-sensitive, so its schema rejects a
   * reversed window before reaching here rather than quietly charting one.
   */
  it("does not depend on the input order", () => {
    expect(generateWeekLabels([on(2024, 1, 22), on(2024, 1, 8)])).toEqual([
      WEEK_0,
      WEEK_1,
      WEEK_2,
    ]);
  });

  /**
   * The loop allocates one `Date` per week and takes its bound from arithmetic
   * on the argument, so an unbounded caller exhausts the heap and kills the
   * process. `getDashboardSeries` refuses an over-wide window at its schema, but
   * this function is exported and used on its own, so it refuses too — loudly,
   * because clamping would return labels for a window nobody asked for.
   */
  it("builds a window of exactly the maximum span", () => {
    const labels = generateWeekLabels([
      WEEK_0,
      addWeeks(WEEK_0, MAX_DASHBOARD_WEEKS - 1),
    ]);

    expect(labels).toHaveLength(MAX_DASHBOARD_WEEKS);
  });

  it("refuses a window one week wider than the maximum", () => {
    expect(() =>
      generateWeekLabels([WEEK_0, addWeeks(WEEK_0, MAX_DASHBOARD_WEEKS)]),
    ).toThrow(RangeError);
  });

  it("refuses the whole representable date range instead of allocating it", () => {
    // The unbounded case in full: ±8.64e15 ms is about ±271,821 years, so this
    // window is ~1.4e13 iterations. It must reject rather than try.
    expect(() =>
      generateWeekLabels([new Date(-8.64e15), new Date(8.64e15)]),
    ).toThrow(RangeError);
  });

  it("spans the requested window, which is how the router derives the x-axis", () => {
    // `getDashboardSeries` passes the slider's two ends straight in, so the
    // labels follow the selection rather than the extent of the data.
    expect(generateWeekLabels([on(2024, 1, 8), on(2024, 1, 15)])).toEqual([
      WEEK_0,
      WEEK_1,
    ]);
  });
});

describe("weeksSpanned", () => {
  /**
   * `getDashboardSeries` sizes a window with this before accepting it, and
   * `generateWeekLabels` sizes the array it allocates with the same call. The
   * two agreeing is what makes the schema's ceiling meaningful, so it is
   * asserted rather than assumed.
   */
  it("agrees with the number of labels generateWeekLabels emits", () => {
    for (const [start, end] of [
      [WEEK_0, WEEK_0],
      [WEEK_0, WEEK_2],
      [WEEK_0, addWeeks(WEEK_0, 51)],
      [on(2024, 1, 8), on(2024, 1, 10)],
    ] as const) {
      expect(weeksSpanned(start, end)).toBe(
        generateWeekLabels([start, end]).length,
      );
    }
  });

  it("counts both ends, so a window inside one week spans one", () => {
    expect(weeksSpanned(on(2024, 1, 8), on(2024, 1, 10))).toBe(1);
  });

  it("goes negative on a reversed window, which is why callers order first", () => {
    expect(weeksSpanned(WEEK_2, WEEK_0)).toBeLessThan(0);
  });
});

describe("buildLineChartData", () => {
  it("keeps each series on its own key", () => {
    const result = buildLineChartData(
      [
        { dateCreated: on(2024, 1, 8) },
        { dateCreated: on(2024, 1, 8) },
        { dateCreated: on(2024, 1, 9) },
      ],
      [{ dateCreated: on(2024, 1, 15) }],
      [{ dateCreated: on(2024, 1, 8) }, { dateCreated: on(2024, 1, 15) }],
      [{ dateCreated: on(2024, 1, 8) }],
      [{ dateCreated: on(2024, 1, 15) }],
      [WEEK_0, WEEK_1],
    );

    expect(result).toEqual({
      signupCount: [3, null],
      groupCounts: [0, 1],
      requestCount: [1, 2],
      driverRequestCount: [1, null],
      riderRequestCount: [0, 1],
    });
  });
});

describe("getDaysFrequency", () => {
  it("tallies each weekday separately for riders and drivers", () => {
    const result = getDaysFrequency(
      [
        user({ daysWorking: "0,1,1,0,0,0,0" }),
        user({ daysWorking: "0,1,0,0,0,0,0" }),
      ],
      [user({ daysWorking: "0,0,0,0,0,1,1" })],
    );

    expect(result.riderDayCount).toEqual([0, 2, 1, 0, 0, 0, 0]);
    expect(result.driverDayCount).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it("reports all zeroes when nobody works any day", () => {
    expect(getDaysFrequency([], [])).toEqual({
      riderDayCount: [0, 0, 0, 0, 0, 0, 0],
      driverDayCount: [0, 0, 0, 0, 0, 0, 0],
    });
  });

  it("ignores a truncated daysWorking string rather than throwing", () => {
    expect(
      getDaysFrequency([user({ daysWorking: "0,1" })], []).riderDayCount,
    ).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });
});

describe("countRole", () => {
  it("counts only users in the requested role", () => {
    const users = [
      user({ role: Role.RIDER }),
      user({ role: Role.DRIVER }),
      user({ role: Role.RIDER }),
    ];

    expect(countRole(users, Role.RIDER)).toBe(2);
    expect(countRole(users, Role.DRIVER)).toBe(1);
    expect(countRole(users, Role.VIEWER)).toBe(0);
  });

  it("counts nothing in an empty list", () => {
    expect(countRole([], Role.RIDER)).toBe(0);
  });
});

describe("summariseUsers", () => {
  it("splits the counts across the four onboarding quadrants", () => {
    const { userCounts } = summariseUsers([
      user({ role: Role.DRIVER, status: Status.ACTIVE, isOnboarded: true }),
      user({ role: Role.RIDER, status: Status.ACTIVE, isOnboarded: true }),
      user({ role: Role.VIEWER, status: Status.ACTIVE, isOnboarded: false }),
      user({ role: Role.RIDER, status: Status.INACTIVE, isOnboarded: true }),
      user({ role: Role.DRIVER, status: Status.INACTIVE, isOnboarded: false }),
    ]);

    expect(userCounts).toEqual({
      totalAO: 2,
      totalANO: 1,
      totalIO: 1,
      totalINO: 1,
      driverAO: 1,
      driverANO: 0,
      driverIO: 0,
      driverINO: 1,
      riderAO: 1,
      riderANO: 0,
      riderIO: 1,
      riderINO: 0,
      viewerAO: 0,
      viewerANO: 1,
      viewerIO: 0,
      viewerINO: 0,
    });
  });

  it("derives the viewer counts as whatever is neither driver nor rider", () => {
    const { userCounts } = summariseUsers([
      user({ role: Role.VIEWER, status: Status.ACTIVE, isOnboarded: true }),
      user({ role: Role.VIEWER, status: Status.ACTIVE, isOnboarded: true }),
    ]);

    expect(userCounts.viewerAO).toBe(2);
    expect(userCounts.totalAO).toBe(2);
  });

  it("tallies the days-working frequency under the role that worked them", () => {
    // The call site used to pass (drivers, riders) to a (riders, drivers)
    // signature, so the two series were swapped in the chart.
    const { daysFrequency } = summariseUsers([
      user({ role: Role.RIDER, daysWorking: "1,0,0,0,0,0,0" }),
      user({ role: Role.DRIVER, daysWorking: "0,0,0,0,0,0,1" }),
    ]);

    expect(daysFrequency.riderDayCount).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(daysFrequency.driverDayCount).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it("counts only active users towards the days-working frequency", () => {
    const { daysFrequency } = summariseUsers([
      user({
        role: Role.RIDER,
        status: Status.INACTIVE,
        daysWorking: "1,1,1,1,1,1,1",
      }),
    ]);

    expect(daysFrequency.riderDayCount).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("treats an empty carpoolId as not being in a group, the same as null", () => {
    const { membership } = summariseUsers([
      user({ role: Role.DRIVER, carpoolId: "group-1" }),
      user({ role: Role.DRIVER, carpoolId: "" }),
      user({ role: Role.DRIVER, carpoolId: null }),
      user({ role: Role.RIDER, carpoolId: "group-1" }),
    ]);

    expect(membership).toEqual({
      driversInGroup: 1,
      ridersInGroup: 1,
      totalDrivers: 3,
      totalRiders: 1,
    });
  });

  it("counts only RIDERs towards totalRiders, leaving viewers out", () => {
    // This used to be "every active user who is not a driver", so
    // VIEWERs - a third of production - roughly halved "Riders In a Group".
    const { membership } = summariseUsers([
      user({ role: Role.DRIVER }),
      user({ role: Role.RIDER, carpoolId: "group-1" }),
      user({ role: Role.RIDER }),
      user({ role: Role.VIEWER }),
      user({ role: Role.VIEWER }),
      user({ role: Role.RIDER, status: Status.INACTIVE }),
    ]);

    expect(membership.ridersInGroup).toBe(1);
    expect(membership.totalRiders).toBe(2);
  });

  it("defines totalDrivers and totalRiders the same way, by role", () => {
    // The two percentages sit side by side on one card, so they must share a
    // definition. The driver side was already right and must stay unchanged.
    const { membership } = summariseUsers([
      user({ role: Role.DRIVER, carpoolId: "group-1" }),
      user({ role: Role.DRIVER }),
      user({ role: Role.RIDER, carpoolId: "group-1" }),
      user({ role: Role.RIDER }),
      user({ role: Role.VIEWER }),
      user({ role: Role.DRIVER, status: Status.INACTIVE }),
    ]);

    expect(membership).toEqual({
      driversInGroup: 1,
      ridersInGroup: 1,
      totalDrivers: 2,
      totalRiders: 2,
    });
  });

  it("reports zeroes for an empty platform rather than throwing", () => {
    const { userCounts, membership, daysFrequency } = summariseUsers([]);

    expect(userCounts.totalAO).toBe(0);
    expect(membership.totalDrivers).toBe(0);
    expect(daysFrequency.riderDayCount).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("summariseConversations", () => {
  it("averages messages over every conversation, including silent ones", () => {
    // Four conversations exist; only three of them have any messages at all.
    const stats = summariseConversations(4, [1, 3, 4]);

    expect(stats.totalConversationCount).toBe(4);
    expect(stats.avgMsg).toBe(2);
  });

  it("counts and averages only the conversations with more than one message", () => {
    const stats = summariseConversations(4, [1, 3, 5]);

    expect(stats.totalWithMsgCount).toBe(2);
    expect(stats.avgConvWithMsg).toBe(4);
  });

  it("returns zero rather than NaN when there is nothing to average", () => {
    expect(summariseConversations(0, [])).toEqual({
      totalConversationCount: 0,
      totalWithMsgCount: 0,
      avgConvWithMsg: 0,
      avgMsg: 0,
    });
  });

  it("returns zero for the >1 average when every conversation has one message", () => {
    const stats = summariseConversations(2, [1, 1]);

    expect(stats.avgConvWithMsg).toBe(0);
    expect(stats.avgMsg).toBe(1);
  });
});

describe("summariseSupplyByCity", () => {
  const city = (
    name: string,
    drivers: number,
    riders: number,
    openSeats = 0,
  ): AdminSupplyQueryRow => ({ city: name, drivers, riders, openSeats });

  const sum = (
    rows: { drivers: number; riders: number; openSeats: number }[],
  ) =>
    rows.reduce(
      (acc, row) => ({
        drivers: acc.drivers + row.drivers,
        riders: acc.riders + row.riders,
        openSeats: acc.openSeats + row.openSeats,
      }),
      { drivers: 0, riders: 0, openSeats: 0 },
    );

  it("returns nothing for an empty platform rather than an empty bucket", () => {
    expect(summariseSupplyByCity([])).toEqual([]);
  });

  it("carries drivers, riders and open seats, and divides riders by drivers to one decimal", () => {
    expect(summariseSupplyByCity([city("boston", 3, 10, 4)])).toEqual([
      {
        city: "Boston",
        kind: "city",
        drivers: 3,
        riders: 10,
        openSeats: 4,
        ridersPerDriver: 3.3,
        stranded: false,
      },
    ]);
  });

  describe("a city with riders and no driver", () => {
    const [row] = summariseSupplyByCity([city("worcester", 0, 5)]);

    it("is marked stranded", () => {
      expect(row.stranded).toBe(true);
    });

    it("has no ratio, not Infinity or NaN", () => {
      // `Infinity` becomes `null` in JSON anyway; `null` says it on purpose.
      expect(row.ridersPerDriver).toBeNull();
    });
  });

  it("does not mark a city stranded when it has drivers, or has no riders", () => {
    const rows = summariseSupplyByCity([
      city("boston", 1, 5),
      city("salem", 2, 0),
    ]);

    expect(rows.map((row) => row.stranded)).toEqual([false, false]);
    // Zero riders over two drivers is a real 0, not a missing figure.
    expect(rows.find((row) => row.city === "Salem")?.ridersPerDriver).toBe(0);
  });

  describe("city names", () => {
    it("merges case variants, and whitespace variants SQL's TRIM leaves apart", () => {
      const rows = summariseSupplyByCity([
        city("boston", 1, 2, 3),
        city("BOSTON", 2, 3, 1),
        city("new  york", 1, 1),
        city("new york", 1, 1),
      ]);

      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.city === "Boston")).toMatchObject({
        drivers: 3,
        riders: 5,
        openSeats: 4,
      });
      expect(rows.find((row) => row.city === "New York")).toMatchObject({
        drivers: 2,
        riders: 2,
      });
    });

    it("title-cases the label", () => {
      const [row] = summariseSupplyByCity([city("new york", 1, 1)]);

      expect(row.city).toBe("New York");
    });

    it("caps a very long name rather than drawing it", () => {
      const [row] = summariseSupplyByCity([city("x".repeat(500), 1, 1)]);

      expect(row.city.length).toBeLessThanOrEqual(40);
    });
  });

  describe("an empty city", () => {
    it("is counted as Unknown, and not dropped", () => {
      const rows = summariseSupplyByCity([
        city("", 1, 2, 3),
        city(" \t", 0, 1),
      ]);

      expect(rows).toEqual([
        {
          city: UNKNOWN_CITY_LABEL,
          kind: "unknown",
          drivers: 1,
          riders: 3,
          openSeats: 3,
          ridersPerDriver: 3,
          stranded: false,
        },
      ]);
    });

    it("stays its own bar, after the named cities, whatever its size", () => {
      const rows = summariseSupplyByCity([
        city("", 0, 100),
        city("boston", 1, 1),
      ]);

      expect(rows.map((row) => row.city)).toEqual(["Boston", "Unknown"]);
    });

    it("is not counted against the limit, and is never folded into Other", () => {
      const rows = summariseSupplyByCity(
        [city("", 1, 50), city("a", 1, 3), city("b", 1, 2), city("c", 1, 1)],
        2,
      );

      expect(rows.map((row) => [row.kind, row.city])).toEqual([
        ["city", "A"],
        ["city", "B"],
        ["unknown", "Unknown"],
        ["other", "Other"],
      ]);
    });
  });

  describe("the top-N cut", () => {
    const many = Array.from({ length: SUPPLY_TOP_CITY_LIMIT + 3 }, (_, i) =>
      // Riders 1..11, so the three smallest are the ones folded away.
      city(`city ${String.fromCharCode(97 + i)}`, 1, i + 1, 1),
    );

    it("keeps the cities with the most riders, most first", () => {
      const rows = summariseSupplyByCity(many);
      const named = rows.filter((row) => row.kind === "city");

      expect(named).toHaveLength(SUPPLY_TOP_CITY_LIMIT);
      expect(named.map((row) => row.riders)).toEqual(
        Array.from({ length: SUPPLY_TOP_CITY_LIMIT }, (_, i) => 11 - i),
      );
    });

    it("folds the rest into one Other row, last", () => {
      const rows = summariseSupplyByCity(many);

      expect(rows[rows.length - 1]).toEqual({
        city: OTHER_CITIES_LABEL,
        kind: "other",
        drivers: 3,
        riders: 1 + 2 + 3,
        openSeats: 3,
        ridersPerDriver: 2,
        stranded: false,
      });
    });

    it("adds no Other row when everything fits", () => {
      const rows = summariseSupplyByCity(many.slice(0, SUPPLY_TOP_CITY_LIMIT));

      expect(rows.some((row) => row.kind === "other")).toBe(false);
    });

    it("can mark Other stranded, when every folded city has no driver", () => {
      const rows = summariseSupplyByCity(
        [city("a", 1, 5), city("b", 0, 2), city("c", 0, 1)],
        1,
      );

      expect(rows[rows.length - 1]).toMatchObject({
        kind: "other",
        drivers: 0,
        riders: 3,
        ridersPerDriver: null,
        stranded: true,
      });
    });

    it("breaks a tie on riders by name, so the order does not move between requests", () => {
      const one = summariseSupplyByCity([city("b", 1, 2), city("a", 1, 2)]);
      const two = summariseSupplyByCity([city("a", 1, 2), city("b", 1, 2)]);

      expect(one.map((row) => row.city)).toEqual(["A", "B"]);
      expect(two).toEqual(one);
    });
  });

  it("sums to the same totals whatever the cut, so nothing is lost to it", () => {
    const rows = [
      city("a", 1, 9, 2),
      city("b", 2, 8, 3),
      city("c", 0, 7),
      city("", 1, 1, 1),
      city("d", 4, 0, 4),
    ];
    const expected = sum(rows);

    for (const limit of [0, 1, 2, 3, 100]) {
      expect(sum(summariseSupplyByCity(rows, limit))).toEqual(expected);
    }
  });

  it("reconciles with `summariseUsers`: active drivers and riders, and no one else", () => {
    // Everyone `summariseUsers` counts, with the city each would be grouped
    // under. The VIEWER and the INACTIVE rider are what it excludes from
    // `driverAO`/`riderAO` and what the SQL excludes from its groups.
    const users = [
      {
        role: Role.DRIVER,
        status: Status.ACTIVE,
        isOnboarded: true,
        city: "Boston",
      },
      {
        role: Role.DRIVER,
        status: Status.ACTIVE,
        isOnboarded: false,
        city: "boston",
      },
      {
        role: Role.RIDER,
        status: Status.ACTIVE,
        isOnboarded: true,
        city: "Boston",
      },
      { role: Role.RIDER, status: Status.ACTIVE, isOnboarded: false, city: "" },
      {
        role: Role.RIDER,
        status: Status.ACTIVE,
        isOnboarded: true,
        city: "Salem",
      },
      {
        role: Role.RIDER,
        status: Status.INACTIVE,
        isOnboarded: true,
        city: "Salem",
      },
      {
        role: Role.VIEWER,
        status: Status.ACTIVE,
        isOnboarded: true,
        city: "Salem",
      },
    ];
    const { userCounts } = summariseUsers(
      users.map((u) => ({
        ...u,
        daysWorking: "",
        carpoolId: null,
      })),
    );

    // What the GROUP BY would return for exactly that population.
    const grouped = new Map<string, AdminSupplyQueryRow>();
    for (const u of users) {
      if (u.status !== Status.ACTIVE || u.role === Role.VIEWER) continue;
      const key = u.city.toLowerCase();
      const row = grouped.get(key) ?? {
        city: key,
        drivers: 0,
        riders: 0,
        openSeats: 0,
      };
      if (u.role === Role.DRIVER) row.drivers += 1;
      else row.riders += 1;
      grouped.set(key, row);
    }

    const totals = sum(summariseSupplyByCity(Array.from(grouped.values())));

    expect(totals.drivers).toBe(userCounts.driverAO + userCounts.driverANO);
    expect(totals.riders).toBe(userCounts.riderAO + userCounts.riderANO);
    // Sanity: the fixture has something to reconcile.
    expect(totals).toMatchObject({ drivers: 2, riders: 3 });
  });
});
