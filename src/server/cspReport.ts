/**
 * CSP violation report collection.
 *
 * The Content Security Policy ships report-only so it can be validated against
 * real traffic before being enforced. That plan needed one thing it did not
 * have: somewhere for the reports to go. Without a collector a violation is
 * written to the console of whichever user's browser hit it and is then gone,
 * so "has this policy been violated in production?" — the question enforcement
 * depends on — had no answer.
 *
 * This module holds the parsing, sanitizing and rate limiting. The endpoint that
 * uses it is `src/pages/api/csp-report.ts`; its HTTP contract is covered in
 * `cspReportEndpoint.test.ts`.
 *
 * ## Two wire formats, and why both
 *
 * Browsers disagree about how to deliver these, so the policy names both
 * destinations and this parser accepts both shapes:
 *
 *  - `report-uri` posts `application/csp-report`: a single object under a
 *    `csp-report` key, with kebab-case fields (`blocked-uri`).
 *  - `report-to` posts `application/reports+json`: an *array* of envelopes,
 *    each `{ type, url, body }`, with camelCase fields (`blockedURL`).
 *
 * Both are normalized to one shape, because a log you have to read two ways is
 * a log nobody correlates.
 *
 * ## The body is untrusted
 *
 * This endpoint is unauthenticated — browsers send reports without credentials,
 * so it cannot be otherwise — which means anything here may have been typed by
 * a stranger rather than produced by a browser. Every string is therefore
 * length-capped and stripped of control characters before it reaches a log, and
 * only the fields below are read at all; an attacker cannot add a field and
 * have it echoed.
 */

/**
 * How much of any single report string may reach a log line.
 *
 * `sample` is the field that motivates this: it carries a fragment of the
 * offending inline script or style, it is attacker-influenced, and it is the
 * one field with no natural length bound.
 */
export const MAX_FIELD_LENGTH = 300;

/**
 * How many reports are read out of a single `application/reports+json` array.
 *
 * The Reporting API batches, so a legitimate request holds a handful. This is a
 * bound on work per request, not a judgement about the sender.
 */
export const MAX_REPORTS_PER_REQUEST = 10;

/** Rate-limit window. */
export const REPORT_WINDOW_MS = 60_000;

/**
 * Reports logged per window.
 *
 * Deliberately a *global* cap rather than per-IP. Per-IP tracking would need an
 * unbounded map keyed by attacker-controlled input — itself a memory-growth
 * vector — and behind a proxy the client address is a header anyone can set, so
 * it would be both costlier and weaker.
 *
 * The trade-off is real and worth stating: one noisy client can crowd out
 * everyone else's reports inside a window. That is acceptable here because
 * reports are a diagnostic sample and not an audit log — the same violation
 * re-reports on every page load, so duplicates are the norm and losing some
 * costs nothing. Silence is the failure mode that would matter, and the
 * suppression count below exists so a flood cannot cause it quietly.
 */
export const MAX_REPORTS_PER_WINDOW = 100;

/**
 * A violation, normalized across both wire formats.
 *
 * `original-policy` / `originalPolicy` is deliberately dropped rather than
 * recorded: it is by far the largest field in every report, and it is a copy of
 * a policy this repository already contains.
 */
export type CspViolation = {
  documentUri: string | null;
  blockedUri: string | null;
  effectiveDirective: string | null;
  disposition: string | null;
  sourceFile: string | null;
  lineNumber: number | null;
  sample: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Replaces C0 and C1 control characters with spaces.
 *
 * Written as a loop rather than a regex over an escape range, which reads as
 * line noise for exactly the characters that matter most here.
 *
 * The specific concern is newlines. Log-line forging is not currently reachable
 * — `JSON.stringify` escapes them on the way out — but that safety is a
 * property of today's log format rather than of the data, and the next person
 * to change the format should not have to rediscover why it mattered.
 */
const stripControlCharacters = (value: string): string => {
  let result = "";

  for (const character of value) {
    const code = character.codePointAt(0)!;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    result += isControl ? " " : character;
  }
  return result;
};

/**
 * Anything absent, blank, or not a string at all becomes `null`.
 *
 * Exported because the endpoint needs it too: the request's content type is as
 * attacker-controlled as the body, and it gets logged when a body arrives that
 * holds no recognizable reports.
 */
export const sanitizeField = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  // Truncate before stripping so a megabyte of control characters is not walked
  // one code point at a time.
  const truncated = value.slice(0, MAX_FIELD_LENGTH + 1);
  const cleaned = stripControlCharacters(truncated).trim();

  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.length > MAX_FIELD_LENGTH
    ? `${cleaned.slice(0, MAX_FIELD_LENGTH)}…`
    : cleaned;
};

/** Line numbers arrive as JSON numbers, but nothing guarantees it. */
const cleanNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** `report-uri`: kebab-case, one report per request. */
const fromLegacyReport = (report: Record<string, unknown>): CspViolation => ({
  documentUri: sanitizeField(report["document-uri"]),
  blockedUri: sanitizeField(report["blocked-uri"]),
  // `violated-directive` is the older name for the same thing and is still what
  // some browsers send; preferring `effective-directive` keeps the normalized
  // field populated either way.
  effectiveDirective:
    sanitizeField(report["effective-directive"]) ??
    sanitizeField(report["violated-directive"]),
  disposition: sanitizeField(report["disposition"]),
  sourceFile: sanitizeField(report["source-file"]),
  lineNumber: cleanNumber(report["line-number"]),
  sample: sanitizeField(report["script-sample"]),
});

/** `report-to`: camelCase, inside a report envelope's `body`. */
const fromReportingApiBody = (body: Record<string, unknown>): CspViolation => ({
  documentUri: sanitizeField(body["documentURL"]),
  blockedUri: sanitizeField(body["blockedURL"]),
  effectiveDirective: sanitizeField(body["effectiveDirective"]),
  disposition: sanitizeField(body["disposition"]),
  sourceFile: sanitizeField(body["sourceFile"]),
  lineNumber: cleanNumber(body["lineNumber"]),
  sample: sanitizeField(body["sample"]),
});

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * Extracts every CSP violation from a request body, in either wire format.
 *
 * Accepts a raw string as well as a parsed object, and that is not defensive
 * padding: Next's body parser only parses JSON for `application/json` and
 * `application/ld+json`. Reports arrive as `application/csp-report` and
 * `application/reports+json`, so `req.body` is handed over as an unparsed
 * string and a handler that assumed an object would collect nothing at all —
 * silently, because the browser never reads the response.
 */
export const parseViolationReports = (body: unknown): CspViolation[] => {
  const payload = typeof body === "string" ? safeJsonParse(body) : body;

  if (isRecord(payload) && isRecord(payload["csp-report"])) {
    return [fromLegacyReport(payload["csp-report"])];
  }

  if (Array.isArray(payload)) {
    return (
      payload
        // Bound the work before inspecting it, so a thousand-element array of
        // the wrong report type is nine hundred and ninety cheap discards.
        .slice(0, MAX_REPORTS_PER_REQUEST)
        .filter(isRecord)
        // The Reporting API multiplexes: deprecation, intervention and
        // crash reports can arrive on the same endpoint and are not this
        // collector's business.
        .filter((envelope) => envelope["type"] === "csp-violation")
        .map((envelope) => envelope["body"])
        .filter(isRecord)
        .map(fromReportingApiBody)
    );
  }

  return [];
};

type ReportWindow = { startedAt: number; logged: number; suppressed: number };

let currentWindow: ReportWindow = { startedAt: 0, logged: 0, suppressed: 0 };

/** Exported for tests, which need a clean window per case. */
export const resetReportWindow = (): void => {
  currentWindow = { startedAt: 0, logged: 0, suppressed: 0 };
};

/**
 * Decides whether one report may be logged.
 *
 * A fixed window rather than a token bucket: violations arrive in bursts by
 * nature — one page load reports every violation on the page — and a fixed
 * window is the variant whose worst case is a number someone can read off the
 * constants above.
 *
 * `suppressed` is non-zero only on the first call of a new window, and carries
 * how many reports the *previous* window dropped. Reporting it there, once, is
 * what keeps a flood visible without every dropped report writing its own line
 * — which would be the flood.
 *
 * Note this counts per process. Under a serverless deployment each instance has
 * its own window and its own log stream, so concurrency multiplies the ceiling.
 * It bounds what any one instance can be made to write, which is the part that
 * makes the endpoint safe to expose; it is not a global quota.
 */
export const admitReport = (
  now: number = Date.now(),
): { allowed: boolean; suppressed: number } => {
  let suppressed = 0;

  if (now - currentWindow.startedAt >= REPORT_WINDOW_MS) {
    suppressed = currentWindow.suppressed;
    currentWindow = { startedAt: now, logged: 0, suppressed: 0 };
  }

  if (currentWindow.logged >= MAX_REPORTS_PER_WINDOW) {
    currentWindow.suppressed += 1;
    return { allowed: false, suppressed };
  }

  currentWindow.logged += 1;
  return { allowed: true, suppressed };
};

/** The prefix every line shares, so the log is greppable. */
export const LOG_PREFIX = "[csp-report]";

/**
 * Parses, rate-limits and records the violations in one request body.
 *
 * `console.warn` rather than `info`: while the policy is report-only these are
 * expected noise during the shakeout, but the whole point of collecting them is
 * that somebody looks, and `info` is where log lines go to be filtered out.
 */
export const collectViolationReports = (
  body: unknown,
): { logged: number; dropped: number } => {
  const violations = parseViolationReports(body);
  let logged = 0;
  let dropped = 0;

  for (const violation of violations) {
    const { allowed, suppressed } = admitReport();

    if (suppressed > 0) {
      console.warn(
        `${LOG_PREFIX} rate limit dropped ${suppressed} report(s) in the previous window`,
      );
    }

    if (!allowed) {
      dropped += 1;
      continue;
    }

    // Single-line JSON: the fields are already sanitized, and one line per
    // violation is what makes these greppable in a hosted log viewer.
    console.warn(`${LOG_PREFIX} ${JSON.stringify(violation)}`);
    logged += 1;
  }

  return { logged, dropped };
};
