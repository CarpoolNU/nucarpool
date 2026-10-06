/**
 * The Monday-to-Sunday reporting window, and the schedule that names it.
 *
 * Every expected value here was measured against the real `America/New_York`
 * zone rather than reasoned about, because the DST cases are the ones most
 * easily got backwards — and a window test that asserts the implementation's
 * own output would pass whatever it did.
 *
 * **The suite runs twice in CI**, under `UTC` and `America/New_York`
 * (`test.yml`), so a window that accidentally depended on the host zone fails
 * in one arm. That is the real coverage of the "deterministic regardless of
 * where it runs" requirement; a local `yarn test` only exercises the first.
 * `jest.shared.config.js` overwrites `TZ`, so `NUCARPOOL_TEST_TZ` is the only
 * way to run the second arm by hand.
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  formatReportingWindow,
  previousCompletedWeek,
  REPORT_DIGEST_SCHEDULE,
  weekContaining,
} from "./reportDigestWindow";
import { SCHEDULE_TIMEZONE } from "../utils/scheduleTime";

dayjs.extend(utc);
dayjs.extend(timezone);

/** A zone-local wall clock as an instant, so a test can name a Boston time. */
const et = (wallClock: string): Date =>
  dayjs.tz(wallClock, SCHEDULE_TIMEZONE).toDate();

/** A window as two readable Boston wall clocks, for failure messages worth reading. */
const describeWindow = (window: {
  start: Date;
  end: Date;
}): { start: string; end: string; hours: number } => ({
  start: dayjs(window.start)
    .tz(SCHEDULE_TIMEZONE)
    .format("ddd YYYY-MM-DD HH:mm"),
  end: dayjs(window.end).tz(SCHEDULE_TIMEZONE).format("ddd YYYY-MM-DD HH:mm"),
  hours: (window.end.getTime() - window.start.getTime()) / 3_600_000,
});

describe("weekContaining", () => {
  it("opens on Monday midnight Boston time and closes on the next one", () => {
    expect(describeWindow(weekContaining(et("2026-09-30 12:00:00")))).toEqual({
      start: "Mon 2026-09-28 00:00",
      end: "Mon 2026-10-05 00:00",
      hours: 168,
    });
  });

  /**
   * Monday is the first day of the week, not the last. A Sunday therefore
   * belongs to the window that opened six days earlier — the off-by-one that
   * `startOf("week")` would introduce, since dayjs's default week begins on
   * Sunday.
   */
  it("puts a Sunday in the week that opened six days earlier", () => {
    expect(
      describeWindow(weekContaining(et("2026-10-04 23:59:59.999"))).start,
    ).toBe("Mon 2026-09-28 00:00");
  });

  it.each([
    ["Monday 00:00 exactly", "2026-09-28 00:00:00", "Mon 2026-09-28 00:00"],
    ["one ms before Monday", "2026-09-27 23:59:59.999", "Mon 2026-09-21 00:00"],
    ["Monday 00:00:00.001", "2026-09-28 00:00:00.001", "Mon 2026-09-28 00:00"],
  ])("is half-open at the boundary: %s", (_label, instant, expectedStart) => {
    expect(describeWindow(weekContaining(et(instant))).start).toBe(
      expectedStart,
    );
  });

  /**
   * The two weeks that are not 168 hours long. These are the measured values —
   * a week is 167 hours across the March transition and 169 across the
   * November one — and they are the reason no boundary in this module is
   * computed by adding a week's worth of milliseconds to another.
   *
   * DST in 2026 begins Sunday 8 March and ends Sunday 1 November.
   */
  it("is 167 hours across the spring transition", () => {
    expect(describeWindow(weekContaining(et("2026-03-04 12:00:00")))).toEqual({
      start: "Mon 2026-03-02 00:00",
      end: "Mon 2026-03-09 00:00",
      hours: 167,
    });
  });

  it("is 169 hours across the autumn transition", () => {
    expect(describeWindow(weekContaining(et("2026-10-28 12:00:00")))).toEqual({
      start: "Mon 2026-10-26 00:00",
      end: "Mon 2026-11-02 00:00",
      hours: 169,
    });
  });

  /**
   * The specific instant that breaks raw-millisecond arithmetic. Subtracting
   * six days of elapsed time from here lands on Tuesday 27 October; the
   * correct Monday is the 26th. Measured, and the reason the implementation
   * does its day arithmetic on a UTC-anchored plain date.
   */
  it("finds the right Monday from the last evening of a 169-hour week", () => {
    expect(
      describeWindow(weekContaining(et("2026-11-01 23:00:00"))).start,
    ).toBe("Mon 2026-10-26 00:00");
  });

  it("crosses a year boundary without losing the Monday", () => {
    expect(describeWindow(weekContaining(et("2026-01-01 12:00:00")))).toEqual({
      start: "Mon 2025-12-29 00:00",
      end: "Mon 2026-01-05 00:00",
      hours: 168,
    });
  });

  /**
   * Both boundaries have to be midnight in Boston whatever the season, which
   * is the single property that makes the window "deterministic" rather than
   * "usually right". Swept across a whole year so a transition cannot hide.
   */
  it("opens and closes at Boston midnight on every Monday of 2026", () => {
    const offenders: string[] = [];

    for (let day = 0; day < 365; day += 1) {
      const window = weekContaining(
        new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + day * 86_400_000),
      );

      for (const [edge, instant] of [
        ["start", window.start],
        ["end", window.end],
      ] as const) {
        const local = dayjs(instant).tz(SCHEDULE_TIMEZONE);
        if (local.hour() !== 0 || local.minute() !== 0 || local.day() !== 1) {
          offenders.push(`${edge} ${local.format("ddd YYYY-MM-DD HH:mm")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("previousCompletedWeek", () => {
  /**
   * The ordinary case: the job runs on Monday morning and reports on the seven
   * days that ended at the midnight just gone, never on the week in progress.
   */
  it("covers the week that just ended, not the one in progress", () => {
    expect(
      describeWindow(previousCompletedWeek(et("2026-10-05 08:00:00"))),
    ).toEqual({
      start: "Mon 2026-09-28 00:00",
      end: "Mon 2026-10-05 00:00",
      hours: 168,
    });
  });

  /**
   * Stepping back a week by subtracting 168 hours from Monday 2026-11-02 00:00
   * EST gives Monday 2026-10-26 01:00 EDT — an hour inside the week it should
   * open. This asserts the measured, correct boundary instead.
   */
  it("opens at midnight when the previous week was 169 hours", () => {
    expect(
      describeWindow(previousCompletedWeek(et("2026-11-02 08:00:00"))),
    ).toEqual({
      start: "Mon 2026-10-26 00:00",
      end: "Mon 2026-11-02 00:00",
      hours: 169,
    });
  });

  it("opens at midnight when the previous week was 167 hours", () => {
    expect(
      describeWindow(previousCompletedWeek(et("2026-03-09 08:00:00"))),
    ).toEqual({
      start: "Mon 2026-03-02 00:00",
      end: "Mon 2026-03-09 00:00",
      hours: 167,
    });
  });

  /**
   * Determinism is the property the delivery claim depends on: two runs of the
   * job in the same week must compute the same window, or they would claim
   * different rows and both send. Anything from the Monday midnight to the
   * Sunday midnight-less-a-millisecond has to agree.
   */
  it("gives one window for every instant in the week it runs", () => {
    const expected = previousCompletedWeek(et("2026-10-05 00:00:00"));

    for (const instant of [
      "2026-10-05 00:00:00",
      "2026-10-05 08:00:00",
      "2026-10-07 13:37:00",
      "2026-10-11 23:59:59.999",
    ]) {
      const actual = previousCompletedWeek(et(instant));
      expect(actual.start.getTime()).toBe(expected.start.getTime());
      expect(actual.end.getTime()).toBe(expected.end.getTime());
    }
  });

  /**
   * A run a week late reports the week just gone and leaves the missed one
   * alone, rather than widening to cover both. The missed week stays an
   * unclaimed row and can be sent with `--week`; folding it in would report
   * fourteen days of reports under a seven-day heading.
   */
  it("does not widen to swallow a week the job missed", () => {
    expect(
      describeWindow(previousCompletedWeek(et("2026-10-12 08:00:00"))),
    ).toEqual({
      start: "Mon 2026-10-05 00:00",
      end: "Mon 2026-10-12 00:00",
      hours: 168,
    });
  });

  it("ends exactly where the running week begins", () => {
    const now = et("2026-10-07 09:00:00");

    expect(previousCompletedWeek(now).end.getTime()).toBe(
      weekContaining(now).start.getTime(),
    );
  });
});

describe("formatReportingWindow", () => {
  /**
   * The label names the Sunday a reader would call the last day, not the
   * exclusive Monday bound — otherwise it would describe eight days and send
   * someone looking for a Monday's reports to the wrong digest.
   */
  it("names the inclusive last day, not the exclusive bound", () => {
    expect(
      formatReportingWindow(weekContaining(et("2026-09-30 12:00:00"))),
    ).toBe("28 Sep – 4 Oct 2026");
  });

  it("gives both years when a week straddles one", () => {
    expect(
      formatReportingWindow(weekContaining(et("2026-01-01 12:00:00"))),
    ).toBe("29 Dec 2025 – 4 Jan 2026");
  });

  it("labels a 169-hour week with its real last day", () => {
    expect(
      formatReportingWindow(weekContaining(et("2026-10-28 12:00:00"))),
    ).toBe("26 Oct – 1 Nov 2026");
  });
});

describe("REPORT_DIGEST_SCHEDULE", () => {
  it("names Monday", () => {
    expect(REPORT_DIGEST_SCHEDULE.weekday).toBe(1);
  });

  /**
   * The crontab spelling and `utcHour` are two statements of one fact, and the
   * cron is the one a scheduler reads. Parsed rather than compared as a string
   * so that changing one without the other fails here.
   */
  it("spells the same hour and weekday in its cron", () => {
    const [minute, hour, dayOfMonth, month, weekday] =
      REPORT_DIGEST_SCHEDULE.cron.split(" ");

    expect(minute).toBe("0");
    expect(Number(hour)).toBe(REPORT_DIGEST_SCHEDULE.utcHour);
    expect(dayOfMonth).toBe("*");
    expect(month).toBe("*");
    expect(Number(weekday)).toBe(REPORT_DIGEST_SCHEDULE.weekday);
  });

  /**
   * The requirement is "Monday morning ET", and a UTC cron cannot hold a fixed
   * Boston hour — so the honest test is that both of the hours it does land on
   * are morning ones, and that `etHours` says which they are rather than
   * leaving a reader to work it out.
   *
   * Derived from the real zone on a Monday in each regime, so this fails if
   * `utcHour` is changed without updating `etHours`, and also if the US ever
   * changes its DST rules under a future `tzdata`.
   */
  it("lands on a Monday morning in Boston in both DST regimes", () => {
    const etHourOnMonday = (mondayDate: string): number => {
      const instant = new Date(
        `${mondayDate}T${String(REPORT_DIGEST_SCHEDULE.utcHour).padStart(
          2,
          "0",
        )}:00:00Z`,
      );
      const local = dayjs(instant).tz(SCHEDULE_TIMEZONE);

      // Guards the fixture rather than the code: a date that is not a Monday
      // would make the hour assertions meaningless.
      expect(local.day()).toBe(REPORT_DIGEST_SCHEDULE.weekday);

      return local.hour();
    };

    // 6 July 2026 is a Monday in daylight time; 5 January 2026 is a Monday in
    // standard time.
    expect(etHourOnMonday("2026-07-06")).toBe(
      REPORT_DIGEST_SCHEDULE.etHours.daylight,
    );
    expect(etHourOnMonday("2026-01-05")).toBe(
      REPORT_DIGEST_SCHEDULE.etHours.standard,
    );

    for (const hour of Object.values(REPORT_DIGEST_SCHEDULE.etHours)) {
      expect(hour).toBeGreaterThanOrEqual(6);
      expect(hour).toBeLessThan(12);
    }
  });

  /**
   * The window a Monday run covers must be the week that has just finished at
   * the moment the cron fires — which is the join between the schedule and the
   * derivation, and the thing a reader of either file alone cannot check.
   */
  it("covers the week that ended hours earlier when the cron fires", () => {
    const fired = new Date("2026-10-05T12:00:00Z");

    expect(describeWindow(previousCompletedWeek(fired))).toEqual({
      start: "Mon 2026-09-28 00:00",
      end: "Mon 2026-10-05 00:00",
      hours: 168,
    });
  });
});
