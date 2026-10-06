import { Permission } from "@prisma/client";
import type { PrismaClient, ReportReason } from "@prisma/client";
import type { SESClient } from "@aws-sdk/client-ses";
import {
  generateAdminReportEmailParams,
  isDeliverableRecipient,
} from "./emailParams";
import { REPORT_REASON_LABELS } from "../utils/reports";

/**
 * Telling admins a report was filed.
 *
 * The report queue is pull-only: before this, a `SAFETY_CONCERN` report sat
 * in `OPEN` until an admin happened to open `/admin` and happened to look at
 * the Reports tab. There was no email, no digest and no badge anywhere else,
 * so the delay between a student reporting a safety problem and any human
 * seeing it was bounded only by how often someone visited the dashboard —
 * which for a volunteer-staffed project could be days.
 *
 * Three properties are the whole point of this module, and each is a test in
 * `adminReportAlert.test.ts`:
 *
 *  1. **It carries no user-authored text.** Not the reporter's `message`, not
 *     the `conversationSnapshot`, not either party's name. See
 *     `AdminReportEmailSchema` in `emailParams.ts`.
 *  2. **It cannot fail the report.** `notifyAdminsOfReport` resolves rather
 *     than rejects on every failure, so `reports.create` has nothing to catch.
 *     The report write is the thing that matters; the alert is best-effort.
 *  3. **It is not charged to the reporter.** See the budget note below.
 *
 * ## Why this claims no email budget
 *
 * `claimEmailBudget` is keyed to the **sender**. Claiming an admin alert
 * against the reporter would mean a reporter who had already sent request and
 * message notifications that hour could exhaust their own budget and thereby
 * silence their own safety alert — the worst failure this feature could have,
 * and one that gets *more* likely the more actively someone uses the app.
 *
 * A budget of its own, under a reserved key, was the other option and is
 * worse than it looks: a global per-window cap is spendable by *other*
 * people's reports, so a third reporter's genuine safety alert could be
 * silenced by two earlier reporters. That moves the same failure from one
 * account to across accounts rather than removing it.
 *
 * So the alert is exempt, and the bound is the report write itself, which is
 * already rate-limited where it belongs:
 *
 *  - `REPORTS_PER_WINDOW` in `reports.ts` caps one reporter at 20 reports a
 *    day, and each report sends at most this one alert;
 *  - one `OPEN` report per (reporter, reported) pair, so re-filing about the
 *    same person is refused before reaching here;
 *  - the recipients are **staff, resolved from `Permission`**, so unlike every
 *    procedure in `user.emails.*` this cannot be aimed at an arbitrary user.
 *    The abuse the budget exists to prevent — using the NUCarpool SES
 *    identity to mail a chosen person repeatedly — is structurally impossible
 *    on this path.
 *
 * The residual cost is that N accounts can generate 20N alerts a day to
 * staff. Sign-up is Azure AD and Northeastern-only, so accounts are not free,
 * and the failure mode is admins receiving mail they asked to receive. That
 * is the right side of the trade against a safety report nobody is told
 * about.
 */

/**
 * How many admins one alert addresses.
 *
 * SES caps a single `SendTemplatedEmail` at 50 recipients across To, Cc and
 * Bcc, and the whole send fails if the list is longer — so an admin roster
 * that outgrew the limit would silence the alert entirely rather than
 * shortening it. The roster is a handful of people today; this is here so
 * that growing it degrades instead.
 */
export const ADMIN_ALERT_RECIPIENT_LIMIT = 50;

export type AdminAlertOutcome =
  | { sent: true; recipientCount: number }
  | { sent: false; reason: "no_recipients" | "send_failed" };

/**
 * Who gets told. Every user whose `permission` is not `USER`, which is the
 * same population `adminRouter` admits to the queue — so the alert cannot
 * reach someone who could not then read the report it is about, and a
 * promotion or demotion moves the recipient list with it.
 *
 * Deliberately not an environment variable. A single configured address is
 * the least coupled option and the easiest to get wrong silently: it would
 * need adding to `.env.example` **and** `amplify.yml`, which `yarn check:env`
 * and `yarn check:amplify` enforce as two separate contracts, and nothing
 * would notice if it were pointed at a mailbox no one reads any more.
 * Deriving it from `Permission` has one source of truth and no new contract.
 *
 * Exported for the weekly digest, which addresses the same population and
 * must keep addressing it: a digest and an immediate alert that disagreed
 * about who is staff would be two rosters to maintain, and the one that
 * drifted would go unnoticed because mail arriving for most people looks
 * like mail arriving. See `reportDigestSend.ts`.
 */
export const resolveAdminRecipients = async (
  prisma: Pick<PrismaClient, "user">,
): Promise<string[]> => {
  const admins = await prisma.user.findMany({
    where: { permission: { not: Permission.USER } },
    select: { email: true },
  });

  return (
    admins
      .map((admin) => admin.email)
      .filter((email): email is string => Boolean(email))
      // Staging may only mail gmail.com. Filtered, not thrown: in
      // `user.emails.*` an undeliverable recipient is the point of the call and
      // refusing it tells the user something, whereas here it must not reach
      // the reporter at all. A staging roster with no gmail address simply gets
      // no alert, which is `no_recipients` below.
      .filter(isDeliverableRecipient)
      .slice(0, ADMIN_ALERT_RECIPIENT_LIMIT)
  );
};

/**
 * Sends the alert, and never throws.
 *
 * Call this **after** the transaction that wrote the report has committed,
 * and do not make the mutation's result depend on what it returns. The
 * outcome is returned for tests and for the log line, not for the client:
 * nothing a reporter sees should change because an admin's mail server was
 * briefly unavailable.
 */
export const notifyAdminsOfReport = async (
  prisma: Pick<PrismaClient, "user">,
  ses: Pick<SESClient, "send">,
  reason: ReportReason,
): Promise<AdminAlertOutcome> => {
  try {
    const recipientEmails = await resolveAdminRecipients(prisma);
    if (recipientEmails.length === 0) {
      // Not an error. A deployment with no admins yet, or a staging roster
      // with no gmail address, is a real state and not a fault.
      console.warn("A report was filed with no admin alert recipient.");
      return { sent: false, reason: "no_recipients" };
    }

    // Imported here rather than at module scope, and the import above is
    // type-only so it is erased. `reports.ts` is the only caller and
    // `ReportDialog.test.tsx` imports that module for its refusal messages —
    // under jsdom, where loading `@aws-sdk/client-ses` throws
    // `ReferenceError: TextDecoder is not defined` from its CBOR submodule
    // before any test runs. A module-scope import therefore made a component
    // test fail to *load*, three files away from anything to do with email.
    // `email.ts` can import it eagerly because nothing in the browser tree
    // reaches that router.
    const { SendTemplatedEmailCommand } = await import("@aws-sdk/client-ses");

    await ses.send(
      new SendTemplatedEmailCommand(
        generateAdminReportEmailParams({
          recipientEmails,
          reasonLabel: REPORT_REASON_LABELS[reason],
        }),
      ),
    );

    return { sent: true, recipientCount: recipientEmails.length };
  } catch (error) {
    // The one `catch` that makes property 2 above true, and it is deliberately
    // this wide: the recipient read can fail as easily as the send, and
    // neither may reach the reporter. Logged rather than rethrown — the
    // report is already written, and the queue still holds it.
    //
    // `AdminReportTemplate` lives in AWS, not in this repository: until
    // someone runs `scripts/emailtemplate.py --apply`, SES answers every send
    // here with `TemplateDoesNotExist` and this is the line that will say so.
    console.error("Could not alert admins about a new report", error);
    return { sent: false, reason: "send_failed" };
  }
};
