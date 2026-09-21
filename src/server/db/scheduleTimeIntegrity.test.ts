import dayjs from "dayjs";
import {
  findWallClockScheduleRows,
  isOnCoopAt,
  isWallClockSchedule,
  toCanonicalScheduleTime,
  type ScheduleTimeRow,
} from "./scheduleTimeIntegrity";
import { toStoredScheduleTime } from "../../utils/scheduleTime";

/**
 * A stored `@db.Time(0)` as Prisma hands it back: epoch-dated, in UTC.
 *
 * Written with an explicit `Z` rather than `new Date(1970, 0, 1, h, m)`, which
 * would be a *local* construction and would therefore make every expectation
 * below depend on the runner's zone. CI runs this suite twice, once at UTC and
 * once at America/New_York, so a local construction here would pass one leg
 * and fail the other.
 */
const stored = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (overrides: Partial<ScheduleTimeRow> = {}): ScheduleTimeRow => ({
  id: "search-1",
  userId: "user-1",
  role: "RIDER",
  status: "ACTIVE",
  startTime: stored("09:00"),
  endTime: stored("17:00"),
  startDate: day("2026-07-10"),
  endDate: day("2026-12-10"),
  ...overrides,
});

describe("isOnCoopAt", () => {
  const asOf = day("2026-09-21");

  it("is true while the co-op is running", () => {
    expect(isOnCoopAt(row(), asOf)).toBe(true);
  });

  it("is inclusive of both endpoints", () => {
    expect(
      isOnCoopAt(
        row({ startDate: day("2026-09-21"), endDate: day("2026-09-21") }),
        asOf,
      ),
    ).toBe(true);
  });

  it("is false before the co-op starts and after it ends", () => {
    expect(
      isOnCoopAt(
        row({ startDate: day("2026-10-01"), endDate: day("2027-03-01") }),
        asOf,
      ),
    ).toBe(false);
    expect(
      isOnCoopAt(
        row({ startDate: day("2025-01-01"), endDate: day("2025-06-01") }),
        asOf,
      ),
    ).toBe(false);
  });

  it("is false when either date is missing", () => {
    expect(isOnCoopAt(row({ startDate: null }), asOf)).toBe(false);
    expect(isOnCoopAt(row({ endDate: null }), asOf)).toBe(false);
  });
});

describe("isWallClockSchedule", () => {
  it("accepts an ordinary unconverted working day", () => {
    expect(isWallClockSchedule(stored("09:00"), stored("17:00"))).toBe(true);
    expect(isWallClockSchedule(stored("08:00"), stored("16:00"))).toBe(true);
  });

  it("accepts both edges of the band", () => {
    expect(isWallClockSchedule(stored("06:00"), stored("14:00"))).toBe(true);
    expect(isWallClockSchedule(stored("10:30"), stored("19:00"))).toBe(true);
  });

  it("rejects a converted row, which is the population it must not touch", () => {
    // 9-5 written under EST, and the same written under EDT. Telling these two
    // apart is the open question on SCRUM-376; neither is this repair's
    // business, and misreading either as wall clock would write a five-hour
    // error into a row that is at worst one hour out.
    expect(isWallClockSchedule(stored("14:00"), stored("22:00"))).toBe(false);
    expect(isWallClockSchedule(stored("13:00"), stored("21:00"))).toBe(false);
  });

  it("rejects rows just outside either edge", () => {
    expect(isWallClockSchedule(stored("05:59"), stored("14:00"))).toBe(false);
    expect(isWallClockSchedule(stored("11:00"), stored("19:00"))).toBe(false);
    expect(isWallClockSchedule(stored("09:00"), stored("13:59"))).toBe(false);
    expect(isWallClockSchedule(stored("09:00"), stored("20:00"))).toBe(false);
  });

  it("rejects a missing time rather than guessing", () => {
    expect(isWallClockSchedule(null, stored("17:00"))).toBe(false);
    expect(isWallClockSchedule(stored("09:00"), null)).toBe(false);
    expect(isWallClockSchedule(null, null)).toBe(false);
  });
});

describe("toCanonicalScheduleTime", () => {
  it("re-stores the wall clock the way the app would write it today", () => {
    // 9:00 AM Boston, anchored at 1970-01-01 which is EST, is 14:00 UTC.
    expect(toCanonicalScheduleTime(stored("09:00"))).toEqual(stored("14:00"));
    expect(toCanonicalScheduleTime(stored("08:00"))).toEqual(stored("13:00"));
  });

  it("keeps the minutes", () => {
    expect(toCanonicalScheduleTime(stored("10:30"))).toEqual(stored("15:30"));
  });

  it("wraps past midnight rather than overflowing", () => {
    // A 7:00 PM Boston finish is 00:00 UTC. `@db.Time(0)` holds a time of day
    // and the read side converts back from the epoch anchor, so this round
    // trips to 7:00 PM rather than to a day-late instant.
    expect(toCanonicalScheduleTime(stored("19:00"))).toEqual(stored("00:00"));
  });

  it("agrees with the write path the profile form uses", () => {
    // The guarantee that matters: a repaired row is byte-identical to what the
    // user would have stored by retyping the same digits into the picker.
    // Asserted against the real writer rather than a re-derived offset, so
    // this fails if the two ever drift.
    for (const hhmm of ["06:00", "09:00", "10:30", "17:00", "19:00"]) {
      const [h, m] = hhmm.split(":").map(Number);
      expect(toCanonicalScheduleTime(stored(hhmm))).toEqual(
        toStoredScheduleTime(dayjs().hour(h).minute(m).second(0)),
      );
    }
  });
});

describe("findWallClockScheduleRows", () => {
  const asOf = day("2026-09-21");

  it("pairs each candidate with the value the repair would write", () => {
    const found = findWallClockScheduleRows([row()], asOf);

    expect(found).toHaveLength(1);
    expect(found[0].row.id).toBe("search-1");
    expect(found[0].repairStartTime).toEqual(stored("14:00"));
    expect(found[0].repairEndTime).toEqual(stored("22:00"));
  });

  it("ignores wall-clock rows whose co-op is not running", () => {
    // The scope decision on SCRUM-376: a student between co-ops re-enters
    // their schedule when they come back, so their row is not worth an
    // irreversible write.
    const past = row({
      id: "search-past",
      startDate: day("2024-01-01"),
      endDate: day("2024-06-01"),
    });

    expect(findWallClockScheduleRows([past], asOf)).toEqual([]);
  });

  it("ignores converted rows whose co-op is running", () => {
    const converted = row({
      id: "search-converted",
      startTime: stored("13:00"),
      endTime: stored("21:00"),
    });

    expect(findWallClockScheduleRows([converted], asOf)).toEqual([]);
  });

  it("ignores rows with no schedule at all", () => {
    expect(
      findWallClockScheduleRows(
        [row({ startTime: null, endTime: null })],
        asOf,
      ),
    ).toEqual([]);
  });

  it("selects on the data, not on role or status", () => {
    // A VIEWER or an INACTIVE row is invisible to matching, but it is still
    // displayed to its own owner on their profile, and it becomes visible the
    // moment they switch role. Repairing it costs nothing and skipping it
    // would leave a row that breaks later.
    const found = findWallClockScheduleRows(
      [
        row({ id: "a", role: "VIEWER" }),
        row({ id: "b", status: "INACTIVE" }),
        row({ id: "c", role: "DRIVER", status: "INACTIVE" }),
      ],
      asOf,
    );

    expect(found.map((candidate) => candidate.row.id)).toEqual(["a", "b", "c"]);
  });

  it("is idempotent: a repaired row is no longer a candidate", () => {
    const [candidate] = findWallClockScheduleRows([row()], asOf);

    const repaired = row({
      startTime: candidate.repairStartTime,
      endTime: candidate.repairEndTime,
    });

    expect(findWallClockScheduleRows([repaired], asOf)).toEqual([]);
  });

  it("is idempotent for the row that wraps past midnight", () => {
    // 10:30-19:00 repairs to 15:30-00:00, and hour 0 must not read as a fresh
    // wall-clock start on a second run.
    const wrapping = row({
      startTime: stored("10:30"),
      endTime: stored("19:00"),
    });
    const [candidate] = findWallClockScheduleRows([wrapping], asOf);

    expect(candidate.repairEndTime).toEqual(stored("00:00"));

    const repaired = row({
      startTime: candidate.repairStartTime,
      endTime: candidate.repairEndTime,
    });

    expect(findWallClockScheduleRows([repaired], asOf)).toEqual([]);
  });
});
