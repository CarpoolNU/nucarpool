/**
 * `send-report-digest.ts`'s argument parsing and week selection.
 *
 * The pure planning half, as every script test here covers — nothing below
 * opens a database connection or constructs an SES client, which is what the
 * `require.main === module` guard in the script makes possible.
 *
 * **A passing suite here says nothing about what the script would send.** The
 * delivery behaviour is in `src/server/reportDigestSend.test.ts` and
 * `src/server/db/reportDigestDelivery.db.test.ts`.
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { parseDigestArgs, resolveDigestWindow } from "./send-report-digest";
import { previousCompletedWeek } from "../src/server/reportDigestWindow";
import { SCHEDULE_TIMEZONE } from "../src/utils/scheduleTime";

dayjs.extend(utc);
dayjs.extend(timezone);

const mondayOf = (window: { start: Date }): string =>
  dayjs(window.start).tz(SCHEDULE_TIMEZONE).format("ddd YYYY-MM-DD HH:mm");

describe("parseDigestArgs", () => {
  it("is a dry run with no arguments", () => {
    expect(parseDigestArgs([])).toEqual({ apply: false });
  });

  it("sends with --apply", () => {
    expect(parseDigestArgs(["--apply"])).toEqual({ apply: true });
  });

  it("takes a week to send", () => {
    expect(parseDigestArgs(["--week", "2026-09-28"])).toEqual({
      apply: false,
      week: "2026-09-28",
    });
  });

  it("combines --apply and --week in either order", () => {
    expect(parseDigestArgs(["--apply", "--week", "2026-09-28"])).toEqual({
      apply: true,
      week: "2026-09-28",
    });
    expect(parseDigestArgs(["--week", "2026-09-28", "--apply"])).toEqual({
      apply: true,
      week: "2026-09-28",
    });
  });

  /**
   * An unrecognised argument is an error, not something to ignore. This script
   * sends mail: a misspelled `--aply` that silently did nothing would be read
   * as "the digest went out", which is the worst available outcome.
   */
  it.each([["--aply"], ["--force"], ["-a"], ["apply"], ["--week=2026-09-28"]])(
    "refuses the unrecognised argument %s",
    (arg) => {
      expect(() => parseDigestArgs([arg])).toThrow("unexpected argument");
    },
  );

  it("refuses --apply spelled as an unknown flag even alongside a good one", () => {
    expect(() => parseDigestArgs(["--week", "2026-09-28", "--nope"])).toThrow(
      "unexpected argument",
    );
  });

  it.each([
    ["a missing value", ["--week"]],
    ["a value that is not a date", ["--week", "last-monday"]],
    ["a value in the wrong order", ["--week", "28-09-2026"]],
    ["a flag where the date should be", ["--week", "--apply"]],
  ])("refuses --week with %s", (_label, argv) => {
    expect(() => parseDigestArgs(argv)).toThrow(
      "--week needs a date like 2026-09-28",
    );
  });

  /** There is no `--force` here, as `scripts/README.md` records for all of them. */
  it("has no way to force anything", () => {
    expect(() => parseDigestArgs(["--force"])).toThrow();
  });
});

describe("resolveDigestWindow", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  it("defaults to the most recently completed week", () => {
    const window = resolveDigestWindow({ apply: false }, now);

    expect(window.start.getTime()).toBe(
      previousCompletedWeek(now).start.getTime(),
    );
    expect(mondayOf(window)).toBe("Mon 2026-09-28 00:00");
  });

  /**
   * Any day of the wanted week names it, so an operator does not have to work
   * out which day was the Monday.
   */
  it.each([
    ["the Monday itself", "2026-09-28"],
    ["a midweek day", "2026-10-01"],
    ["the Sunday", "2026-10-04"],
  ])("selects the same week from %s", (_label, week) => {
    expect(mondayOf(resolveDigestWindow({ apply: true, week }, now))).toBe(
      "Mon 2026-09-28 00:00",
    );
  });

  /**
   * The reason the date is read at noon UTC rather than midnight. Midnight UTC
   * on a Monday is the preceding Sunday evening in Boston, so `--week` naming
   * a Monday would have selected the week *before* the one typed — off by
   * seven days, with nothing in the output to suggest it.
   */
  it("reads a Monday as its own week, not the one before", () => {
    expect(
      mondayOf(resolveDigestWindow({ apply: true, week: "2026-09-28" }, now)),
    ).not.toBe("Mon 2026-09-21 00:00");

    // The control: the week before is reachable, by naming a day in it.
    expect(
      mondayOf(resolveDigestWindow({ apply: true, week: "2026-09-21" }, now)),
    ).toBe("Mon 2026-09-21 00:00");
  });

  /** A week that straddles a DST transition still opens at Boston midnight. */
  it("opens at midnight for a 169-hour week", () => {
    const window = resolveDigestWindow(
      { apply: true, week: "2026-10-28" },
      now,
    );

    expect(mondayOf(window)).toBe("Mon 2026-10-26 00:00");
    expect((window.end.getTime() - window.start.getTime()) / 3_600_000).toBe(
      169,
    );
  });

  it("ignores `now` entirely when --week is given", () => {
    const fromOneInstant = resolveDigestWindow(
      { apply: true, week: "2026-09-28" },
      now,
    );
    const fromAnother = resolveDigestWindow(
      { apply: true, week: "2026-09-28" },
      new Date("2027-04-01T00:00:00Z"),
    );

    expect(fromOneInstant).toEqual(fromAnother);
  });
});
