import { format } from "date-fns";
import { ReportStatus } from "@prisma/client";
import { Note } from "../../styles/profile";
import { QueryError } from "../QueryError";
import Spinner from "../Spinner";
import { trpc } from "../../utils/trpc";
import {
  REPORTER_STATUS_LABELS,
  REPORT_REASON_LABELS,
} from "../../utils/reports";

/**
 * The reports the reader has filed, and where each one stands.
 *
 * It sits in the profile's Account section beside `BlockedUsersSection`, and
 * outside its react-hook-form, for the same reason that one does: none of it
 * belongs to "Save Changes". Unlike that sibling it is read-only - there is
 * no control here at all, because a report is evidence and a reporter cannot
 * withdraw or edit one.
 *
 * **Why this exists.** Without it, filing a report is write-only: a toast,
 * and then silence. A reporter cannot confirm the report exists, see what
 * they wrote, or learn that an admin has acted - and the refusal of a second
 * report about the same person names a row they cannot read.
 *
 * **Resolution is shown here and nowhere else.** No email is sent when an
 * admin resolves a report; the status below is the whole of the feedback
 * loop. That is deliberate: an email would put a decision about a named
 * student into someone's inbox, which needs a policy decision nobody has
 * made, and it would need a template and a rate-limit story besides.
 *
 * **Everything on this screen is the reader's own writing**, their message
 * and nothing else - `reports.me` returns no part of the conversation
 * snapshot and nothing about the reported user beyond the display name. It is
 * rendered as React text children, never as HTML.
 */
const ReportsFiledSection = () => {
  const reports = trpc.user.reports.me.useQuery();

  return (
    <section aria-labelledby="reports-filed-heading" className="pb-8">
      {/* A heading, not an `EntryLabel`: that renders a `<label>`, and there
          is no field here for it to label. The wording is quoted back by
          `DUPLICATE_REPORT_MESSAGE`, which sends people here. */}
      <h2
        id="reports-filed-heading"
        className="font-montserrat mt-4 mb-4 text-2xl font-bold"
      >
        Reports You&apos;ve Filed
      </h2>

      {reports.isPending ? (
        <Spinner />
      ) : reports.isError ? (
        <QueryError
          subject="your reports"
          onRetry={() => void reports.refetch()}
        />
      ) : reports.data.length === 0 ? (
        <Note className="py-2">You haven&apos;t reported anyone.</Note>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
          {reports.data.map((report) => (
            <li key={report.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-montserrat min-w-0 font-medium">
                  {report.reportedName}
                </span>
                {/* The status in words the reporter can act on, not the enum.
                    `OPEN` reads as a queue state; "Awaiting review" says
                    which side the report is waiting on. */}
                <span className="font-montserrat flex-shrink-0 text-sm font-medium text-gray-700">
                  {REPORTER_STATUS_LABELS[report.status]}
                </span>
              </div>

              {/*
                Reason and date on one line, the date in a `<time>` so the
                machine-readable instant survives the formatting - `superjson`
                means these arrive as real `Date`s, not strings to reparse.

                `MMM dd yyyy`, as `BlockedUsersSection` uses and for the same
                reason: this answers "when did I do this", for which the hour
                does not matter. The admin queue keeps its clock because a
                report is triaged against a timeline.
              */}
              <p className="font-montserrat text-sm text-gray-600">
                {REPORT_REASON_LABELS[report.reason]} &middot;{" "}
                <time dateTime={report.filedAt.toISOString()}>
                  Filed {format(report.filedAt, "MMM dd yyyy")}
                </time>
              </p>

              {/*
                Only for a resolved report. `updatedAt` is the row's
                `dateModified`, and `admin.resolveReport` is the only thing
                that writes a report after it is created - so on a row that
                has left `OPEN` it is when the decision was made, and on one
                that has not it is merely when the report was filed, which the
                line above already says.
              */}
              {report.status !== ReportStatus.OPEN && (
                <p className="font-montserrat text-sm text-gray-600">
                  <time dateTime={report.updatedAt.toISOString()}>
                    {REPORTER_STATUS_LABELS[report.status]}{" "}
                    {format(report.updatedAt, "MMM dd yyyy")}
                  </time>
                </p>
              )}

              {report.message && (
                <p className="font-montserrat mt-2 text-sm break-words whitespace-pre-wrap text-gray-800">
                  {report.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Note className="py-2">
        Admins review reports privately. The person you reported is never told
        that you reported them, and reports can&apos;t be withdrawn or edited.
      </Note>
    </section>
  );
};

export default ReportsFiledSection;
