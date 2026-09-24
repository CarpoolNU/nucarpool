/**
 * Series labels for the admin growth chart, shared by `LineChartCount` and the
 * SCRUM-540 CSV export so the two cannot drift apart. They used to be written
 * out separately in each, which is how an export could go on calling a series
 * something the chart no longer claimed it was (SCRUM-548).
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
 * 1,390 of 4,486 production users carry a `dateCreated` of 2024-10-21, and
 * some of their requests predate it: the column was rewritten when the data
 * was imported, so the chart's cliff on that date never happened. No code can
 * recover the real dates, so the chart says so instead.
 */
export const IMPORTED_SIGNUP_DATE_NOTE =
  "Signup dates on or before Oct 21, 2024 were overwritten when the data was " +
  "imported, so the jump in users that week is an artifact, not real growth.";
