import { Permission, Role, Status } from "@prisma/client";
import { startOfWeek } from "date-fns";
import {
  countCumulativeItemsPerWeek,
  countRole,
  filterDataForLineChart,
  filterItemsByDate,
  generateWeekLabels,
  getDaysFrequency,
  getMinMaxDates,
} from "./adminDataUtils";
import type { TempGroup, TempRequest, TempUser } from "./types";

/**
 * The admin dashboard's growth chart. The interesting behaviour is the weekly
 * bucketing and the deliberate `null` gaps that keep flat stretches off the line.
 */

// 2024-01-01 is a Monday, so these three Sundays are consecutive week starts.
const WEEK_0 = new Date(2024, 0, 7);
const WEEK_1 = new Date(2024, 0, 14);
const WEEK_2 = new Date(2024, 0, 21);

const on = (year: number, month: number, dayOfMonth: number) =>
  new Date(year, month - 1, dayOfMonth);

const user = (overrides: Partial<TempUser> = {}): TempUser => ({
  id: "user-1",
  email: "ada@northeastern.edu",
  permission: Permission.USER,
  isOnboarded: true,
  dateCreated: on(2024, 1, 8),
  role: Role.RIDER,
  status: Status.ACTIVE,
  carpoolId: "",
  daysWorking: "0,1,1,1,1,1,0",
  ...overrides,
});

const group = (dateCreated: Date, id = "group-1"): TempGroup => ({
  id,
  dateCreated,
  _count: { carpoolSearches: 2 },
});

const carpoolRequest = (
  dateCreated: Date,
  role: Role = Role.RIDER,
  id = "request-1",
): TempRequest => ({ id, dateCreated, fromUser: { role } });

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

describe("filterItemsByDate", () => {
  const inRange = startOfWeek(on(2024, 1, 10)).getTime();
  const before = startOfWeek(on(2023, 12, 10)).getTime();
  const after = startOfWeek(on(2024, 3, 10)).getTime();

  it("keeps items whose week falls inside the range", () => {
    const items = [{ dateCreated: on(2024, 1, 10) }];

    expect(filterItemsByDate(items, before, after)).toEqual(items);
  });

  it("drops items whose week falls outside the range", () => {
    const items = [
      { dateCreated: on(2023, 12, 10) },
      { dateCreated: on(2024, 3, 10) },
    ];

    expect(filterItemsByDate(items, inRange, inRange)).toEqual([]);
  });

  it("includes items sitting exactly on either boundary week", () => {
    const items = [
      { dateCreated: on(2023, 12, 10) },
      { dateCreated: on(2024, 3, 10) },
    ];

    expect(filterItemsByDate(items, before, after)).toHaveLength(2);
  });

  it("buckets by the start of the week, so any day in a boundary week counts", () => {
    // 2024-01-10 is a Wednesday; its week starts on the 7th, which is the bound.
    const items = [{ dateCreated: on(2024, 1, 10) }];

    expect(
      filterItemsByDate(items, WEEK_0.getTime(), WEEK_0.getTime()),
    ).toEqual(items);
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

  it("does not depend on the input order", () => {
    expect(generateWeekLabels([on(2024, 1, 22), on(2024, 1, 8)])).toEqual([
      WEEK_0,
      WEEK_1,
      WEEK_2,
    ]);
  });
});

describe("getMinMaxDates", () => {
  it("spans the earliest and latest date across users, groups and requests", () => {
    const result = getMinMaxDates(
      [user({ dateCreated: on(2024, 2, 1) })],
      [group(on(2024, 1, 1))],
      [carpoolRequest(on(2024, 3, 1))],
    );

    expect(result).toEqual({
      minDate: on(2024, 1, 1).getTime(),
      maxDate: on(2024, 3, 1).getTime(),
    });
  });

  it("returns a zero range when there is nothing at all", () => {
    // Math.min of an empty spread would be Infinity, so this guard matters.
    expect(getMinMaxDates([], [], [])).toEqual({ minDate: 0, maxDate: 0 });
  });

  it("collapses to a single instant when only one item exists", () => {
    const result = getMinMaxDates(
      [user({ dateCreated: on(2024, 2, 1) })],
      [],
      [],
    );

    expect(result.minDate).toBe(result.maxDate);
  });
});

describe("filterDataForLineChart", () => {
  const range = [
    startOfWeek(on(2024, 1, 1)).getTime(),
    startOfWeek(on(2024, 3, 1)).getTime(),
  ];

  it("separates active from inactive users", () => {
    const active = user({ id: "a", status: Status.ACTIVE });
    const inactive = user({ id: "b", status: Status.INACTIVE });

    const result = filterDataForLineChart([active, inactive], [], [], range);

    expect(result.filteredActiveUsers).toEqual([active]);
    expect(result.filteredInactiveUsers).toEqual([inactive]);
  });

  it("separates rider requests from driver requests while keeping the combined total", () => {
    const riderRequest = carpoolRequest(on(2024, 1, 8), Role.RIDER, "r1");
    const driverRequest = carpoolRequest(on(2024, 1, 9), Role.DRIVER, "r2");

    const result = filterDataForLineChart(
      [],
      [],
      [riderRequest, driverRequest],
      range,
    );

    expect(result.filteredRiderRequests).toEqual([riderRequest]);
    expect(result.filteredDriverRequests).toEqual([driverRequest]);
    expect(result.filteredRequests).toHaveLength(2);
  });

  it("applies the slider range to every series", () => {
    const outOfRange = user({ dateCreated: on(2030, 1, 1) });

    const result = filterDataForLineChart(
      [outOfRange],
      [group(on(2030, 1, 1))],
      [carpoolRequest(on(2030, 1, 1))],
      range,
    );

    expect(result.filteredActiveUsers).toEqual([]);
    expect(result.filteredGroups).toEqual([]);
    expect(result.filteredRequests).toEqual([]);
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
      user({ id: "a", role: Role.RIDER }),
      user({ id: "b", role: Role.DRIVER }),
      user({ id: "c", role: Role.RIDER }),
    ];

    expect(countRole(users, Role.RIDER)).toBe(2);
    expect(countRole(users, Role.DRIVER)).toBe(1);
    expect(countRole(users, Role.VIEWER)).toBe(0);
  });

  it("counts nothing in an empty list", () => {
    expect(countRole([], Role.RIDER)).toBe(0);
  });
});
