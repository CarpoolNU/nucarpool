import type { NextApiRequest, NextApiResponse } from "next";

import {
  collectViolationReports,
  LOG_PREFIX,
  sanitizeField,
} from "../../server/cspReport";

/**
 * CSP violation collector.
 *
 * The destination named by `report-uri` and `Reporting-Endpoints` in
 * `next.config.js`. Browsers post here on their own initiative when the
 * report-only policy is violated; nothing in the app calls it.
 *
 * Like `api/pusher/auth.ts` this cannot be a tRPC procedure — the browser
 * defines the contract, and it is a credential-less POST of a fixed JSON shape
 * under a content type tRPC does not speak. The parsing, sanitizing and rate
 * limiting live in `src/server/cspReport.ts`; this file is the HTTP edge.
 *
 * Deliberately unauthenticated. Browsers send reports without credentials, so
 * requiring a session would collect nothing. That makes the body untrusted
 * input from an unauthenticated stranger, which is why the size cap below and
 * the sanitizing in `cspReport.ts` both exist.
 *
 * What the rate limit in `cspReport.ts` does and does not do, since the
 * distinction matters: it caps how many reports are *written to the log*, not
 * how many requests are accepted. Nothing in a Next handler can refuse traffic
 * before it arrives — that is the load balancer's job. The threat being closed
 * here is a cheap unauthenticated request turning into unbounded log volume,
 * and it is closed at the write.
 *
 * Worth knowing when reading the policy: reports are sent by the browser's own
 * reporting infrastructure, not by page script, so they are exempt from the
 * policy that triggered them. `connect-src` and `form-action` do not need to
 * permit this route, and adding it to either would be a misunderstanding.
 */

/**
 * A real report runs to a couple of kilobytes, most of it the `original-policy`
 * echo. Next's default is 1mb; capping it here means an oversized body is
 * refused by the framework with a 413 before any of it is read into memory,
 * which is the cheapest possible place to stop it.
 */
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "32kb",
    },
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { logged, dropped } = collectViolationReports(req.body);

  if (logged === 0 && dropped === 0) {
    // Nothing recognizable arrived. Log the shape but never the body: echoing
    // unrecognized input is how an unauthenticated endpoint becomes a way to
    // write arbitrary text into someone's logs. The content type and size are
    // enough to tell "a browser format changed" from "someone is poking at it".
    console.warn(
      `${LOG_PREFIX} ignored a request with no CSP violations ` +
        `(content-type: ${JSON.stringify(
          sanitizeField(req.headers["content-type"]),
        )})`,
    );
  }

  // 204 regardless, including for a body we could not parse. Browsers discard
  // the response entirely, so a status code cannot inform the only legitimate
  // caller — it could only serve as a parser oracle for the illegitimate one.
  return res.status(204).end();
}
