import { PrismaClient } from "@prisma/client";
import { SESClient } from "@aws-sdk/client-ses";
import {
  sendReportDigest,
  type DigestRunOutcome,
  type ReportDigestPrisma,
} from "../../src/server/reportDigestSend";
import { formatReportingWindow } from "../../src/server/reportDigestWindow";
import {
  parseDigestArgs,
  resolveDigestWindow,
} from "../../scripts/send-report-digest";

/**
 * The EventBridge Scheduler target for the weekly admin report digest.
 *
 * **This is an adapter and nothing else.** It decides which week to send by
 * calling the same `resolveDigestWindow` the script calls, and it sends by
 * calling the same `sendReportDigest`, so the window derivation and the
 * compare-and-swap delivery claim exist in exactly one place and are covered by
 * the tests SCRUM-625 wrote against a real MySQL. The only logic that is new
 * here is the mapping from a `DigestRunOutcome` onto a Lambda invocation
 * result, which is the one thing a script's exit code could not express.
 *
 * ## Why the trigger is allowed to be unreliable
 *
 * EventBridge Scheduler retries, and a schedule can still be late, dropped or
 * fired twice. None of that threatens correctness: the window comes from the
 * calendar rather than from when this ran, and `claimDigestWindow` is a
 * compare-and-swap on one row, so a late run, a double run and two concurrent
 * runs all produce exactly one digest per week. That property is what made the
 * trigger a replaceable choice in SCRUM-626 rather than a design constraint.
 *
 * ## Why this does not import `src/server/ses.ts`
 *
 * That module reads its credentials from `serverEnv`, which `envsafe`
 * validates at import time — all fourteen variables, including the Azure,
 * Google and Pusher secrets this job has no use for. Importing it would mean
 * copying the application's entire secret set into a Lambda that sends one
 * email a week.
 *
 * A Lambda does not need copied credentials at all. The SES client below is
 * constructed with no `credentials` key, so the SDK resolves them from the
 * execution role, and the only AWS permission the role carries is
 * `ses:SendTemplatedEmail`. **That is the reason this ticket chose a Lambda:**
 * the credentials stay where the SES identity already lives, and nothing new
 * is handed to CI.
 *
 * ## The environment this does need
 *
 * `DATABASE_URL`, and — because `emailParams.ts` reads `NEXT_PUBLIC_ENV` to
 * decide whether staging's gmail-only recipient filter applies — the five
 * `NEXT_PUBLIC_*` variables `browserEnv` validates as a group. Four of those
 * five are not used by this job and are set only because `envsafe` throws a
 * `TypeError` at import time for any missing one; they are public tokens that
 * every browser already receives, so setting them in a Lambda discloses
 * nothing. `infra/report-digest/README.md` lists them with that caveat.
 *
 * `REGION_AWS` is the repository's name for SES's region and is read here for
 * the same purpose, falling back to the `AWS_REGION` the Lambda runtime always
 * sets. The two differ whenever the function is deployed outside the region
 * holding the SES identity, which is why the fallback is not the only source.
 */

/**
 * What the schedule sends. `{}` in normal operation.
 *
 * `week` exists for a manual re-run from the console — the Lambda equivalent of
 * the script's `--week` and of a `workflow_dispatch` button. It is typed
 * `unknown` because this payload is **input, not trusted configuration**: a
 * hand-typed console invocation is exactly where a malformed date appears, and
 * a wrong week here would send a digest covering reports nobody asked about.
 */
export type ReportDigestEvent = {
  week?: unknown;
} | null;

/** The clients the job needs, injected so the tests supply fakes. */
export type ReportDigestDeps = {
  prisma: ReportDigestPrisma;
  ses: Pick<SESClient, "send">;
};

/**
 * Which week this invocation covers.
 *
 * A `week` in the payload is validated by handing it to the script's own
 * `parseDigestArgs`, rather than by a second copy of the date pattern here.
 * That function already rejects anything that is not `YYYY-MM-DD` and already
 * carries the reason it has to — and `resolveDigestWindow` then applies the
 * noon-UTC reading that stops a Monday from selecting the preceding week in
 * `America/New_York`. Both of those are decisions with a comment attached
 * somewhere else; neither is restated.
 */
export const resolveEventWindow = (event: ReportDigestEvent, now: Date) => {
  const week = event?.week;

  if (week === undefined || week === null) {
    return resolveDigestWindow({ apply: true }, now);
  }

  if (typeof week !== "string") {
    throw new Error(
      `the "week" field must be a string like 2026-09-28; received ${typeof week}.`,
    );
  }

  return resolveDigestWindow(parseDigestArgs(["--week", week]), now);
};

/**
 * Runs the digest and turns the outcome into a Lambda result.
 *
 * **A `failed` outcome throws.** That is the whole observability design: a
 * thrown error is what increments the function's `Errors` metric, which is
 * what the CloudWatch alarm in `template.yaml` watches and what sends the mail
 * saying the digest is broken. Returning a `{ status: "failed" }` object
 * instead would make a broken digest a *successful* invocation, and a safety
 * mechanism that fails silently looks exactly like a quiet week — the failure
 * mode `REPORT_DIGEST_SEND_WHEN_EMPTY` exists to keep the recipients from
 * having to guess at.
 *
 * Every `skipped` outcome returns normally, because each one is the mechanism
 * working rather than a fault: `already_sent` is the duplicate guard, and the
 * other three released the claim so a later run still sends the week.
 */
export const runReportDigest = async (
  deps: ReportDigestDeps,
  event: ReportDigestEvent = null,
  now: Date = new Date(),
): Promise<DigestRunOutcome> => {
  const window = resolveEventWindow(event, now);
  const windowLabel = formatReportingWindow(window);

  const outcome = await sendReportDigest(deps.prisma, deps.ses, now, {
    window,
  });

  if (outcome.status === "sent") {
    // Counts only, matching what the digest itself carries. `reportDigest.ts`
    // keeps reporter text and conversation snapshots out of the summary type,
    // and a log line is just as readable by anyone with log access.
    console.log("Report digest sent", {
      window: windowLabel,
      attempt: outcome.attempt,
      reportCount: outcome.summary.reportCount,
      recipientCount: outcome.recipientCount,
    });
    return outcome;
  }

  if (outcome.status === "skipped") {
    console.log("Report digest skipped", {
      window: windowLabel,
      reason: outcome.reason,
    });
    return outcome;
  }

  // `reportDigestSend.ts` has already logged the underlying cause at error
  // level by this point, so this adds the week and the classification rather
  // than restating it.
  throw new Error(
    outcome.reason === "state_not_recorded"
      ? `The digest for ${windowLabel} was sent but could not be recorded as ` +
          `delivered: this run lost its claim mid-flight, so a later run may ` +
          `send the week again. Check report_digest_delivery for window_start ` +
          `${window.start.toISOString()} before the next Monday.`
      : `The digest for ${windowLabel} was not sent. The claim was released, ` +
          `so the next run retries the same week. If SES reported ` +
          `TemplateDoesNotExist, publish the template with ` +
          `python3 scripts/emailtemplate.py --apply.`,
  );
};

/**
 * The live clients, built once per execution environment rather than per
 * invocation, so a warm container reuses the database pool and the TLS
 * connection to SES — the same reasoning `src/server/ses.ts` gives for not
 * building a client per request.
 *
 * Memoised behind a function rather than constructed at module scope so that
 * importing this file has no side effects, which is what lets the test import
 * `runReportDigest` without opening a database connection.
 *
 * Deliberately never `$disconnect()`ed. A Lambda container is frozen between
 * invocations rather than exited, so disconnecting at the end of each run
 * would discard a pool the next invocation would otherwise reuse and buy
 * nothing.
 */
let cached: ReportDigestDeps | undefined;

const liveDeps = (): ReportDigestDeps => {
  if (!cached) {
    cached = {
      prisma: new PrismaClient(),
      ses: new SESClient({
        region: process.env.REGION_AWS || process.env.AWS_REGION,
      }),
    };
  }

  return cached;
};

/** The Lambda entry point. `template.yaml` names this as the handler. */
export const handler = async (
  event: ReportDigestEvent = null,
): Promise<DigestRunOutcome> => runReportDigest(liveDeps(), event);
