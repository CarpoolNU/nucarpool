/**
 * Send the weekly admin report digest for a completed Monday-to-Sunday week.
 *
 * One email to every `permission != USER` user, carrying the week's report
 * counts and a link to `/admin`. No reporter text, no conversation snapshot
 * and nothing identifying any user — see `src/server/reportDigest.ts` for why
 * repeat subjects are counted rather than named.
 *
 * **This writes: it sends mail and records the delivery.** Dry-run by default
 * like every script here, and the dry run claims nothing and sends nothing —
 * it prints the week, the counts and the recipient count only, so it is safe
 * to point at production to see what would go out.
 *
 * Usage:
 *   npx ts-node scripts/send-report-digest.ts                      # dry run
 *   npx ts-node scripts/send-report-digest.ts --apply              # send
 *   npx ts-node scripts/send-report-digest.ts --week 2026-09-28    # a past week
 *
 * `--week` takes any date inside the week wanted and sends that week instead
 * of the most recently completed one. It exists because each week is a
 * separate row in `report_digest_delivery`, so a week the job missed is still
 * sendable afterwards and is never silently folded into the next digest.
 *
 * ## What schedules this, and why running it by hand still matters
 *
 * An EventBridge Scheduler schedule invokes a Lambda every Monday, defined in
 * `infra/report-digest/`. Its handler calls `sendReportDigest` — the same
 * function `main` below calls — so there is one implementation of the window
 * and the claim and this script is not a second copy of the job. Whether a
 * stack is actually deployed is not something this repository records;
 * `infra/report-digest/README.md` has the check.
 *
 * This remains the way to **see** what would go out, because the Lambda has no
 * dry run, and the way to send a week the schedule missed.
 *
 * **Correctness does not depend on the trigger**, which is what made the
 * choice of one a question of operational fit. The window is derived from the
 * calendar rather than from when this ran
 * (`src/server/reportDigestWindow.ts`), and the delivery claim is a
 * compare-and-swap on one row (`src/server/db/reportDigestDelivery.ts`), so
 * running this twice, running it late, running two copies at once, or running
 * it by hand on a Monday while the Lambda also fires all produce exactly one
 * digest per week. `REPORT_DIGEST_SCHEDULE` records the cadence in both the
 * crontab and the EventBridge spelling.
 *
 * Exits 0 when a digest was sent or deliberately skipped, 1 when a send
 * failed, so it can gate a follow-up.
 */

import { PrismaClient } from "@prisma/client";
import {
  formatReportingWindow,
  previousCompletedWeek,
  REPORT_DIGEST_SCHEDULE,
  weekContaining,
  type ReportingWindow,
} from "../src/server/reportDigestWindow";
import {
  formatReasonBreakdown,
  type ReportDigestSummary,
} from "../src/server/reportDigest";
import {
  previewReportDigest,
  sendReportDigest,
} from "../src/server/reportDigestSend";

export type DigestArgs = {
  apply: boolean;
  /** A date inside the week to send, or `undefined` for the latest one. */
  week?: string;
};

/** What `--week` has to look like. Checked here so a typo is not a wrong week. */
const WEEK_ARG_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses arguments, and refuses anything it does not recognise.
 *
 * Exported so `send-report-digest.test.ts` can cover it without opening a
 * database connection, which is how every script here is tested.
 *
 * Unknown arguments are an error rather than being ignored: this sends mail,
 * and a misspelled `--aply` that silently did nothing would be read as "the
 * digest went out".
 */
export const parseDigestArgs = (argv: readonly string[]): DigestArgs => {
  const args: DigestArgs = { apply: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      args.apply = true;
      continue;
    }

    if (arg === "--week") {
      const value = argv[index + 1];
      if (!value || !WEEK_ARG_PATTERN.test(value)) {
        throw new Error("--week needs a date like 2026-09-28.");
      }
      args.week = value;
      index += 1;
      continue;
    }

    throw new Error(
      `unexpected argument: ${arg}. ` +
        `Usage: send-report-digest.ts [--apply] [--week YYYY-MM-DD]`,
    );
  }

  return args;
};

/**
 * Which week the run covers.
 *
 * `--week` is resolved through `weekContaining`, so any day of the wanted
 * week names it and an operator does not have to work out which day was the
 * Monday. The date is read as **noon UTC** rather than midnight: midnight UTC
 * on a Monday is the preceding Sunday evening in `America/New_York` and would
 * therefore select the week before the one typed. Noon is the same calendar
 * day in every US zone.
 */
export const resolveDigestWindow = (
  args: DigestArgs,
  now: Date,
): ReportingWindow =>
  args.week
    ? weekContaining(new Date(`${args.week}T12:00:00Z`))
    : previousCompletedWeek(now);

/** The counts, printed the same way whether this is a dry run or a send. */
const printSummary = (
  windowLabel: string,
  summary: ReportDigestSummary,
  recipientCount: number,
): void => {
  console.log(`    week                 ${windowLabel}`);
  console.log(`    reports              ${summary.reportCount}`);
  console.log(`    unique users         ${summary.uniqueReportedUserCount}`);
  console.log(`    repeat subjects      ${summary.repeatedReportedUserCount}`);
  console.log(`    highest about one    ${summary.highestReportsAboutOneUser}`);
  console.log(`    critical             ${summary.criticalReportCount}`);
  console.log(`    by reason            ${formatReasonBreakdown(summary)}`);
  console.log(`    recipients           ${recipientCount}`);
};

const main = async () => {
  const args = parseDigestArgs(process.argv.slice(2));
  const now = new Date();
  const window = resolveDigestWindow(args, now);

  const prisma = new PrismaClient();

  try {
    if (!args.apply) {
      const preview = await previewReportDigest(prisma, now, window);

      console.log("Dry run. Nothing claimed, nothing sent.\n");
      printSummary(
        preview.windowLabel,
        preview.summary,
        preview.recipientCount,
      );
      console.log(
        `\n    window               ${window.start.toISOString()}` +
          ` -> ${window.end.toISOString()}`,
      );
      console.log(
        `    schedule             ${REPORT_DIGEST_SCHEDULE.cron} (UTC)`,
      );

      if (preview.recipientCount === 0) {
        console.log(
          "\n✖ No deliverable admin recipients. Nothing would be sent. " +
            "On staging only gmail.com addresses are deliverable.",
        );
      } else {
        console.log("\nRe-run with --apply to send.");
      }

      return;
    }

    // Imported here rather than at module scope so that a dry run and the
    // test of `parseDigestArgs` do not construct an SES client: `ses.ts`
    // reads credentials from `serverEnv` at import time.
    const { sesClient } = await import("../src/server/ses");

    const outcome = await sendReportDigest(prisma, sesClient, now, { window });

    if (outcome.status === "sent") {
      console.log(
        `✓ digest sent for ${outcome.windowLabel} ` +
          `(attempt ${outcome.attempt})\n`,
      );
      printSummary(
        outcome.windowLabel,
        outcome.summary,
        outcome.recipientCount,
      );
      return;
    }

    if (outcome.status === "skipped") {
      // Every skip is the mechanism working, so none of them is an error
      // exit. `already_sent` in particular is the duplicate guard doing its
      // job, which is the expected outcome of a second run.
      const explanation: Record<typeof outcome.reason, string> = {
        already_sent:
          "this week has already been delivered; nothing was sent again",
        held_by_another_run:
          "another run holds the claim for this week; it is sending it",
        no_recipients:
          "no deliverable admin recipients; the claim was released so a " +
          "later run can still send this week",
        empty_week: "no reports this week, and empty weeks are not sent",
      };

      console.log(
        `- skipped ${formatReportingWindow(window)}: ` +
          `${explanation[outcome.reason]}`,
      );
      return;
    }

    if (outcome.reason === "state_not_recorded") {
      console.error(
        `✖ The digest for ${formatReportingWindow(window)} was sent but ` +
          `could not be recorded as delivered — this run lost its claim ` +
          `mid-flight. A later run may send this week a second time. ` +
          `Check report_digest_delivery for window_start ` +
          `${window.start.toISOString()} before running again.`,
      );
    } else {
      console.error(
        `✖ The digest for ${formatReportingWindow(window)} was not sent. ` +
          `The claim was released, so re-running retries the same week. ` +
          `If SES reported TemplateDoesNotExist, publish the template ` +
          `first: python3 scripts/emailtemplate.py --apply`,
      );
    }

    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import the pure helpers without opening a database
// connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
