/**
 * Series labels for the admin growth chart, shared by `LineChartCount` and the
 * CSV export so the two cannot drift apart: writing them out separately in
 * each would let an export go on calling a series something the chart no
 * longer claims it is.
 *
 * The request splits say "current" because a `Request` row does not record
 * its sender's role: they classify each request by the role its sender holds
 * now. None of these may contain a comma, since each is also a CSV header.
 */
export const LINE_CHART_LABELS = {
  signupCount: "Users Signed Up",
  groupCounts: "Groups",
  requestCount: "Requests",
  riderRequestCount: "Requests From Current Riders",
  driverRequestCount: "Requests From Current Drivers",
} as const;

/**
 * The weekdays in `daysWorking` index order, Sunday first, shared by the
 * server aggregation, the chart, the table and the CSV so none of them can
 * put a count under the wrong name. None of these may contain a comma, since
 * each is also a CSV field.
 */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** What the head count of people who named no weekday is called. */
export const UNSPECIFIED_DAYS_LABEL = "Unspecified";

/**
 * A chunk of production users share the same `dateCreated` of 2024-10-21, and
 * some of their requests predate it: the column was rewritten when the data
 * was imported, so the chart's cliff on that date is not real growth. No code
 * can recover the real dates, so the chart says so instead.
 */
export const IMPORTED_SIGNUP_DATE_NOTE =
  "Signup dates on or before Oct 21, 2024 were overwritten when the data was " +
  "imported, so the jump in users that week is an artifact, not real growth.";
