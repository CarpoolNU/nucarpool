import type { NextApiRequest, NextApiResponse } from "next";

/**
 * HTTP contract of the CSP report collector (SCRUM-283).
 *
 * `cspReport.test.ts` covers the parsing and rate limiting. This covers the
 * edge: that the endpoint answers a browser the way a browser expects, that a
 * body it cannot use is still answered rather than erroring, and that an
 * unrecognized request never gets its own content echoed into the log.
 *
 * Deliberately NOT co-located with the handler it covers (SCRUM-269). Under
 * src/pages/ a filename is also a route — Next's default `pageExtensions`
 * includes `.ts` — so a co-located `csp-report.test.ts` would ship as the
 * endpoint `/api/csp-report.test`. Same reason and same placement as
 * `pusherAuthEndpoint.test.ts`.
 */

import handler, { config } from "../pages/api/csp-report";
import { LOG_PREFIX, resetReportWindow } from "./cspReport";

const violation = {
  "csp-report": {
    "document-uri": "https://nucarpool.com/",
    "effective-directive": "img-src",
    "blocked-uri": "https://tracker.example/pixel.gif",
    disposition: "report",
  },
};

const buildRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    ended: boolean;
    setHeader: jest.Mock;
  };
};

const call = async (req: Partial<NextApiRequest> = {}) => {
  const res = buildRes();
  await handler(
    {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: violation,
      ...req,
    } as unknown as NextApiRequest,
    res,
  );
  return res;
};

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  resetReportWindow();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("POST /api/csp-report", () => {
  it("records a violation and answers 204 with no body", async () => {
    const res = await call();

    // Browsers discard this response, so there is nothing useful to return and
    // a body would only be wasted bytes on every violation of every page load.
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain(
      "https://tracker.example/pixel.gif",
    );
  });

  it("accepts the report as a raw string, which is how it really arrives", async () => {
    // Next only JSON-parses `application/json`; `application/csp-report` is
    // handed over as a string.
    const res = await call({ body: JSON.stringify(violation) });

    expect(res.statusCode).toBe(204);
    expect(warnSpy.mock.calls[0]![0]).toContain(
      "https://tracker.example/pixel.gif",
    );
  });

  it("still answers 204 for a body it cannot use", async () => {
    // A parser oracle is the only thing a distinguishing status code could
    // provide here, since the one legitimate caller never reads it.
    const res = await call({ body: "}{ not json" });

    expect(res.statusCode).toBe(204);
  });

  it("notes an unusable request without echoing its body", async () => {
    await call({
      headers: { "content-type": "text/plain" },
      body: "sensitive-or-hostile-payload",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]![0] as string;

    // The shape is diagnostic; the content is a way to write attacker text into
    // someone's logs.
    expect(line).toContain(LOG_PREFIX);
    expect(line).toContain("text/plain");
    expect(line).not.toContain("sensitive-or-hostile-payload");
  });

  it("does not let the content-type header itself flood a log line", async () => {
    // The header is as attacker-controlled as the body, and it is the value
    // being logged in the branch above.
    await call({
      headers: { "content-type": `text/plain${"z".repeat(10_000)}` },
      body: "",
    });

    expect((warnSpy.mock.calls[0]![0] as string).length).toBeLessThan(500);
  });

  it("rejects a non-POST method and says what is allowed", async () => {
    const res = await call({ method: "GET" });

    expect(res.statusCode).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("caps the request body well below Next's 1mb default", async () => {
    // Next refuses an oversized body with a 413 before the handler runs, so this
    // limit is the whole size defence and is worth pinning. A real report is a
    // couple of kilobytes.
    const limit = config.api.bodyParser.sizeLimit;

    expect(limit).toBe("32kb");
  });
});
