/**
 * The DST-era schedule repair's selection rule and repaired value.
 *
 * Every instant here is built with an explicit `Z` or `Date.UTC`, and every
 * stored time is read back through the module rather than with a local
 * accessor. CI runs this suite twice, under `UTC` and `America/New_York`, and
 * a selection rule that moved with the runner's zone would pick a different
 * set of production rows on a laptop than on a CI box — which for an
 * irreversible repair is the whole ballgame.
 *
 * Daylight saving in the years used below, for anyone checking the fixtures:
 * 2024 ran 10 Mar to 3 Nov, 2025 ran 9 Mar to 2 Nov, 2026 runs 8 Mar to 1 Nov.
 */

import {
  BULK_LOAD_DAY,
  CONVERTING_ERA_BEGAN_AT,
  SCHEDULE_FIX_DEPLOYED_AT,
  findDstWrittenScheduleRows,
  isProvablyDstWritten,
  toCanonicalFromEdtScheduleTime,
  type ScheduleTimeAuditRow,
} from "./dstScheduleIntegrity";

/** A stored `@db.Time(0)`, as Prisma hands it back: epoch-dated, UTC. */
const storedAt = (hour: number, minute = 0) =>
  new Date(Date.UTC(1970, 0, 1, hour, minute, 0));

/** The UTC hour and minute of a stored time, read without a local accessor. */
const hhmm = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;

const ON_COOP = new Date("2026-11-16T12:00:00.000Z");

/** EDT instants well inside their windows, and an EST one for contrast. */
const EDT_2026_JULY = new Date("2026-07-15T12:00:00.000Z");
const EDT_2026_AUGUST = new Date("2026-08-20T12:00:00.000Z");
const EDT_2025_JULY = new Date("2025-07-15T12:00:00.000Z");
const EST_2026_JANUARY = new Date("2026-01-15T12:00:00.000Z");

const auditRow = (
  overrides: Partial<ScheduleTimeAuditRow> = {},
): ScheduleTimeAuditRow => ({
  id: "cs_1",
  userId: "u_1",
  role: "DRIVER",
  status: "ACTIVE",
  // A 9-to-5 as the pre-fix path stored it in summer: an hour below the
  // 14:00-22:00 the anchor now produces.
  startTime: storedAt(13),
  endTime: storedAt(21),
  startDate: new Date("2026-09-01T00:00:00.000Z"),
  endDate: new Date("2026-12-31T00:00:00.000Z"),
  dateCreated: EDT_2026_JULY,
  dateModified: EDT_2026_JULY,
  ...overrides,
});

describe("toCanonicalFromEdtScheduleTime", () => {
  it("moves an EDT-written time onto the EST anchor", () => {
    // 13:00Z read at EDT is the 9:00 AM the user typed; stored against the
    // anchor, 9:00 AM is 14:00Z.
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(13)))).toBe("14:00");
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(21)))).toBe("22:00");
  });

  it("keeps the minutes", () => {
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(13, 30)))).toBe(
      "14:30",
    );
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(12, 45)))).toBe(
      "13:45",
    );
  });

  it("wraps a value that crosses midnight UTC", () => {
    // 02:00Z is a 10:00 PM finish in EDT, which stores as 03:00Z.
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(2)))).toBe("03:00");
    // 23:00Z is 7:00 PM EDT; the anchor puts 7:00 PM at 00:00Z the next day,
    // and the column keeps only the time of day.
    expect(hhmm(toCanonicalFromEdtScheduleTime(storedAt(23)))).toBe("00:00");
  });
});

describe("isProvablyDstWritten", () => {
  it("accepts a span wholly inside one daylight-saving window", () => {
    expect(
      isProvablyDstWritten(
        auditRow({
          dateCreated: EDT_2026_JULY,
          dateModified: EDT_2026_AUGUST,
        }),
      ),
    ).toBe(true);
  });

  it("accepts a row never edited since creation", () => {
    expect(
      isProvablyDstWritten(
        auditRow({ dateCreated: EDT_2025_JULY, dateModified: EDT_2025_JULY }),
      ),
    ).toBe(true);
  });

  it("rejects a span crossing a winter, where the schedule could have been retyped under EST", () => {
    expect(
      isProvablyDstWritten(
        auditRow({
          dateCreated: EDT_2025_JULY,
          dateModified: EDT_2026_JULY,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a row created outside daylight saving", () => {
    expect(
      isProvablyDstWritten(
        auditRow({
          dateCreated: EST_2026_JANUARY,
          dateModified: EDT_2026_JULY,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a row that might have been saved through the fixed path", () => {
    const afterTheFix = new Date(SCHEDULE_FIX_DEPLOYED_AT.getTime() + 1000);

    expect(
      isProvablyDstWritten(
        auditRow({ dateCreated: EDT_2026_JULY, dateModified: afterTheFix }),
      ),
    ).toBe(false);
  });

  it("rejects a wall-clock-era row, which is five hours out rather than one", () => {
    // Inside daylight saving 2024, but before the era that converted at all.
    const beforeTheEra = new Date(CONVERTING_ERA_BEGAN_AT.getTime() - 1000);

    expect(
      isProvablyDstWritten(
        auditRow({ dateCreated: beforeTheEra, dateModified: beforeTheEra }),
      ),
    ).toBe(false);

    expect(
      isProvablyDstWritten(
        auditRow({
          dateCreated: new Date("2024-07-15T12:00:00.000Z"),
          dateModified: new Date("2024-08-15T12:00:00.000Z"),
        }),
      ),
    ).toBe(false);
  });

  it("rejects a bulk-loaded row, whose timestamps record the import", () => {
    const bulk = new Date(`${BULK_LOAD_DAY}T18:24:00.000Z`);

    expect(
      isProvablyDstWritten(auditRow({ dateCreated: bulk, dateModified: bulk })),
    ).toBe(false);
  });

  it("rejects a row modified before it was created", () => {
    expect(
      isProvablyDstWritten(
        auditRow({
          dateCreated: EDT_2026_AUGUST,
          dateModified: EDT_2026_JULY,
        }),
      ),
    ).toBe(false);
  });
});

describe("findDstWrittenScheduleRows", () => {
  it("selects a provable row on a running co-op and pairs it with its repair", () => {
    const row = auditRow();

    const found = findDstWrittenScheduleRows([row], ON_COOP);

    expect(found).toHaveLength(1);
    expect(found[0].row.id).toBe("cs_1");
    expect(hhmm(found[0].repairStartTime)).toBe("14:00");
    expect(hhmm(found[0].repairEndTime)).toBe("22:00");
  });

  it("leaves a co-op that is not running alone", () => {
    const finished = auditRow({
      startDate: new Date("2025-01-01T00:00:00.000Z"),
      endDate: new Date("2025-06-30T00:00:00.000Z"),
      dateCreated: EDT_2025_JULY,
      dateModified: EDT_2025_JULY,
    });

    expect(findDstWrittenScheduleRows([finished], ON_COOP)).toHaveLength(0);
  });

  it("leaves a wall-clock value alone however its timestamps read", () => {
    // 09:00-17:00 is the unconverted wall clock the other repair owns. Its
    // timestamps here are provably EDT, so only the value check excludes it.
    const wallClock = auditRow({
      startTime: storedAt(9),
      endTime: storedAt(17),
    });

    expect(findDstWrittenScheduleRows([wallClock], ON_COOP)).toHaveLength(0);
  });

  it("leaves a row with no schedule alone", () => {
    expect(
      findDstWrittenScheduleRows(
        [auditRow({ startTime: null, endTime: null })],
        ON_COOP,
      ),
    ).toHaveLength(0);

    expect(
      findDstWrittenScheduleRows([auditRow({ endTime: null })], ON_COOP),
    ).toHaveLength(0);
  });

  it("never selects a row already on the anchor, given a post-fix save", () => {
    // The shape of an already-correct row: 14:00-22:00, saved through the
    // fixed path. Both the value and the timestamp keep it out.
    const correct = auditRow({
      startTime: storedAt(14),
      endTime: storedAt(22),
      dateCreated: EDT_2026_JULY,
      dateModified: new Date("2026-10-01T12:00:00.000Z"),
    });

    expect(findDstWrittenScheduleRows([correct], ON_COOP)).toHaveLength(0);
  });
});
