/**
 * Parsing, sanitizing and rate limiting of CSP violation reports (SCRUM-283).
 *
 * `cspReportEndpoint.test.ts` covers the HTTP contract around this. What is
 * covered here is the part that would fail silently in production: this endpoint
 * is fire-and-forget, the browser discards the response, and nothing in the app
 * ever calls it. If the parser does not recognize a real report there is no
 * error anywhere — just an empty log and a wrong conclusion that the policy is
 * clean enough to enforce.
 *
 * So the report fixtures below are the shapes browsers actually send, both of
 * them, rather than the shape convenient to parse.
 */

import {
  admitReport,
  collectViolationReports,
  LOG_PREFIX,
  MAX_FIELD_LENGTH,
  MAX_REPORTS_PER_REQUEST,
  MAX_REPORTS_PER_WINDOW,
  parseViolationReports,
  REPORT_WINDOW_MS,
  resetReportWindow,
  sanitizeField,
} from "./cspReport";

/** What Chrome posts to `report-uri` as `application/csp-report`. */
const legacyReport = {
  "csp-report": {
    "document-uri": "https://nucarpool.com/",
    referrer: "",
    "violated-directive": "connect-src",
    "effective-directive": "connect-src",
    "original-policy": "default-src 'self'; connect-src 'self'",
    disposition: "report",
    "blocked-uri": "https://api.example.com/track",
    "status-code": 200,
    "script-sample": "",
    "source-file": "https://nucarpool.com/_next/static/chunk.js",
    "line-number": 42,
  },
};

/** What Chrome posts to `report-to` as `application/reports+json`. */
const reportingApiReport = (overrides: Record<string, unknown> = {}) => [
  {
    age: 0,
    type: "csp-violation",
    url: "https://nucarpool.com/",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://nucarpool.com/",
      referrer: "",
      blockedURL: "https://api.example.com/track",
      effectiveDirective: "connect-src",
      originalPolicy: "default-src 'self'; connect-src 'self'",
      sourceFile: "https://nucarpool.com/_next/static/chunk.js",
      sample: "",
      disposition: "report",
      statusCode: 200,
      lineNumber: 42,
      columnNumber: 7,
      ...overrides,
    },
  },
];

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  resetReportWindow();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("parseViolationReports", () => {
  it("reads the report-uri shape", async () => {
    expect(parseViolationReports(legacyReport)).toEqual([
      {
        documentUri: "https://nucarpool.com/",
        blockedUri: "https://api.example.com/track",
        effectiveDirective: "connect-src",
        disposition: "report",
        sourceFile: "https://nucarpool.com/_next/static/chunk.js",
        lineNumber: 42,
        sample: null,
      },
    ]);
  });

  it("reads the report-to shape into the same normalized fields", async () => {
    // The whole point of normalizing: the two formats name the same facts
    // differently, and a log that has to be read two ways is a log nobody
    // correlates. Both fixtures describe the same violation, so both must
    // produce byte-identical output.
    expect(parseViolationReports(reportingApiReport())).toEqual(
      parseViolationReports(legacyReport),
    );
  });

  it("parses a raw JSON string body", async () => {
    // This is the one that would have broken in production. Next's body parser
    // only parses JSON for `application/json` and `application/ld+json`; reports
    // arrive as `application/csp-report` and `application/reports+json`, so
    // `req.body` is an unparsed string. A handler expecting an object would
    // collect nothing, silently, forever.
    expect(parseViolationReports(JSON.stringify(legacyReport))).toEqual(
      parseViolationReports(legacyReport),
    );
    expect(parseViolationReports(JSON.stringify(reportingApiReport()))).toEqual(
      parseViolationReports(legacyReport),
    );
  });

  it("falls back to violated-directive when effective-directive is absent", async () => {
    const { "effective-directive": _dropped, ...rest } =
      legacyReport["csp-report"];

    expect(
      parseViolationReports({ "csp-report": rest })[0]!.effectiveDirective,
    ).toBe("connect-src");
  });

  it("ignores report types that are not CSP violations", async () => {
    // The Reporting API multiplexes: deprecation and intervention reports
    // arrive on the same endpoint and are not this collector's business.
    const deprecation = [
      { type: "deprecation", url: "https://nucarpool.com/", body: {} },
    ];

    expect(parseViolationReports(deprecation)).toEqual([]);
  });

  it("returns nothing for junk instead of throwing", async () => {
    // An unauthenticated endpoint receives whatever anyone sends it. A throw
    // here would turn a scan into a 500 and a stack trace in the logs.
    for (const junk of [
      undefined,
      null,
      "",
      "not json at all",
      "{",
      42,
      {},
      [],
      { "csp-report": "a string" },
      [{ type: "csp-violation" }],
      [{ type: "csp-violation", body: "a string" }],
      [null, 7, "x"],
    ]) {
      expect(parseViolationReports(junk)).toEqual([]);
    }
  });

  it("caps how many reports it reads from one request", async () => {
    const flood = Array.from({ length: 500 }, () => reportingApiReport()[0]);

    expect(parseViolationReports(flood)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });
});

describe("sanitizeField", () => {
  it("truncates a long field", async () => {
    const cleaned = sanitizeField("x".repeat(5000))!;

    // Long enough to be useful, short enough that it cannot dominate a log.
    expect(cleaned.length).toBe(MAX_FIELD_LENGTH + 1);
    expect(cleaned.endsWith("…")).toBe(true);
  });

  it("leaves a field at the limit alone", async () => {
    const exact = "x".repeat(MAX_FIELD_LENGTH);

    expect(sanitizeField(exact)).toBe(exact);
  });

  it("strips newlines and other control characters", async () => {
    // Log-line forging. `JSON.stringify` also escapes these on the way out, but
    // that is a property of today's log format rather than of the data.
    const forged = sanitizeField('evil\r\n[csp-report] {"all":"clear"}')!;

    expect(forged).not.toContain("\n");
    expect(forged).not.toContain("\r");
    expect(forged).toContain("evil");
  });

  it("treats absent, blank and non-string values as missing", async () => {
    for (const value of [undefined, null, "", "   ", "\n\n", 42, {}, []]) {
      expect(sanitizeField(value)).toBeNull();
    }
  });
});

describe("admitReport", () => {
  it("admits reports up to the cap and refuses the rest", async () => {
    const now = 1_000_000;

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i += 1) {
      expect(admitReport(now).allowed).toBe(true);
    }
    expect(admitReport(now).allowed).toBe(false);
  });

  it("reports the previous window's suppressed count exactly once", async () => {
    const now = 1_000_000;

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW + 3; i += 1) {
      admitReport(now);
    }

    // Once, as the new window opens. If every dropped report announced itself,
    // the announcements would be the flood.
    const first = admitReport(now + REPORT_WINDOW_MS);
    expect(first).toEqual({ allowed: true, suppressed: 3 });
    expect(admitReport(now + REPORT_WINDOW_MS).suppressed).toBe(0);
  });

  it("gives a new window a full allowance", async () => {
    const now = 1_000_000;

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW + 1; i += 1) {
      admitReport(now);
    }
    expect(admitReport(now).allowed).toBe(false);

    expect(admitReport(now + REPORT_WINDOW_MS).allowed).toBe(true);
  });

  it("does not roll the window early", async () => {
    const now = 1_000_000;

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i += 1) {
      admitReport(now);
    }
    expect(admitReport(now + REPORT_WINDOW_MS - 1).allowed).toBe(false);
  });
});

describe("collectViolationReports", () => {
  it("logs one greppable line per violation", async () => {
    expect(collectViolationReports(legacyReport)).toEqual({
      logged: 1,
      dropped: 0,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const line = warnSpy.mock.calls[0]![0] as string;
    expect(line.startsWith(LOG_PREFIX)).toBe(true);
    // One line per violation is what makes these usable in a hosted log viewer.
    expect(line).not.toContain("\n");
    expect(JSON.parse(line.slice(LOG_PREFIX.length))).toEqual(
      parseViolationReports(legacyReport)[0],
    );
  });

  it("does not record the policy back into the log", async () => {
    // Every report echoes the entire policy. It is the largest field by far, and
    // it is a copy of something this repository already contains.
    collectViolationReports(legacyReport);

    expect(warnSpy.mock.calls[0]![0]).not.toContain("default-src");
  });

  it("logs nothing for a body with no violations in it", async () => {
    expect(collectViolationReports("nonsense")).toEqual({
      logged: 0,
      dropped: 0,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stops logging once the window's allowance is gone", async () => {
    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i += 1) {
      collectViolationReports(legacyReport);
    }
    warnSpy.mockClear();

    expect(collectViolationReports(legacyReport)).toEqual({
      logged: 0,
      dropped: 1,
    });
    // The point of the cap: a flood must not be able to write more log.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never echoes an attacker-supplied field verbatim", async () => {
    const hostile = collectViolationReports(
      reportingApiReport({
        sample: `\n${LOG_PREFIX} {"documentUri":"https://evil.example/"}`,
        blockedURL: "y".repeat(10_000),
      }),
    );

    expect(hostile).toEqual({ logged: 1, dropped: 0 });

    const line = warnSpy.mock.calls[0]![0] as string;
    // A single line, so the forged prefix cannot become a log entry of its own.
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(2000);
  });

  it("ignores fields it was not asked to collect", async () => {
    // An attacker adding a key must not get it echoed. The parser reads a fixed
    // field list rather than copying the object.
    collectViolationReports({
      "csp-report": {
        ...legacyReport["csp-report"],
        "attacker-field": "should-not-appear",
      },
    });

    expect(warnSpy.mock.calls[0]![0]).not.toContain("should-not-appear");
  });
});
