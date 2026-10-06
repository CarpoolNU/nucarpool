import { useState } from "react";
import { format } from "date-fns";
import { ReportStatus } from "@prisma/client";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import Spinner from "../Spinner";
import { QueryError } from "../QueryError";
import {
  HELD_QUERY_STATE,
  combineQueryStates,
  toQueryState,
} from "../../utils/queryState";
import useIsHydrated from "../../utils/useIsHydrated";
import { REPORT_REASON_LABELS } from "../../utils/reports";

/** The status filter options, plus "every status" as `null`. */
const STATUS_FILTERS = [
  { label: "Open", value: ReportStatus.OPEN },
  { label: "Reviewed", value: ReportStatus.REVIEWED },
  { label: "Dismissed", value: ReportStatus.DISMISSED },
  { label: "All", value: null },
] as const;

/**
 * What the per-user count column is called, for the slice it counted.
 *
 * Taken from the page's own `countedStatus` rather than from the filter
 * state, so the heading always describes the numbers on screen. The two
 * disagree for one render after a filter change — React Query serves the
 * previous page while the new one loads — and a heading that said "Open"
 * over counts that were still "all statuses" would be a number with the
 * wrong scope attached, which is the one thing this column must not be.
 */
const COUNT_HEADINGS: Record<ReportStatus, string> = {
  OPEN: "Open reports about them",
  REVIEWED: "Reviewed reports about them",
  DISMISSED: "Dismissed reports about them",
};
const countHeading = (countedStatus: ReportStatus | null) =>
  countedStatus === null
    ? "Reports about them (all statuses)"
    : COUNT_HEADINGS[countedStatus];

/**
 * The report queue: most recent first, defaulting to OPEN and
 * paginated so a flood of reports makes the queue longer rather
 * than pushing genuinely unresolved ones out of what `getReports`'s bounded
 * page carries.
 *
 * Modelled on `AdminAuditLog`. `getReports` returns raw user ids, and this
 * resolves them through `getAllUsers`, the query `UserManagement` already
 * makes, so the queue adds no second privileged read of the user table.
 *
 * **Everything a report carries was written by a user**, the reporter's
 * message and every line of the snapshot alike. It is rendered as React text
 * children only, never as HTML, so markup in a report shows as characters.
 *
 * An OPEN report can be resolved as Reviewed or Dismissed, which
 * is what lets the same reporter file a new report against the same person —
 * `reports.ts`'s duplicate guard is keyed on `OPEN`.
 */
const AdminReports = () => {
  // Held for the reason `AdminAuditLog` gives: `/admin` is server-rendered,
  // and a phone's hydration pass can mount this for one discarded render.
  const isHydrated = useIsHydrated();

  const [status, setStatus] = useState<ReportStatus | null>(ReportStatus.OPEN);

  const utils = trpc.useUtils();
  const reportsQuery = trpc.user.admin.getReports.useInfiniteQuery(
    { status },
    {
      enabled: isHydrated,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );
  const usersQuery = trpc.user.admin.getAllUsers.useQuery(undefined, {
    enabled: isHydrated,
  });
  const resolveReport = trpc.user.admin.resolveReport.useMutation({
    onSuccess: () => {
      utils.user.admin.getReports.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to resolve report: ${error.message}`);
    },
  });

  const state = isHydrated
    ? combineQueryStates(toQueryState(reportsQuery), toQueryState(usersQuery))
    : HELD_QUERY_STATE;

  const pages = reportsQuery.data?.pages ?? [];
  const reports = pages.flatMap((page) => page.reports);

  // Every page of one infinite query was fetched with the same `status`, so
  // any page reports the same scope and the first is as good as the last.
  const countedStatus = pages[0]?.countedStatus ?? null;

  const emailById = new Map(
    (usersQuery.data ?? []).map((user) => [user.id, user.email]),
  );
  const nameFor = (id: string) => emailById.get(id) ?? id;

  return (
    <div className="relative h-full w-full">
      {state.status === "error" && (
        <QueryError
          variant="page"
          subject="the reports"
          onRetry={state.retry}
        />
      )}
      {state.status === "loading" && <Spinner />}
      {state.status === "ready" && reportsQuery.data && (
        <div className="h-full w-full overflow-auto p-10">
          <h1 className="font-montserrat mb-6 text-center text-3xl font-bold text-black">
            Reports
          </h1>
          <div className="font-lato mb-4 flex justify-center gap-4">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.label}
                type="button"
                onClick={() => setStatus(filter.value)}
                className={
                  filter.value === status
                    ? "font-bold text-black underline"
                    : "text-stone-500 hover:text-black"
                }
              >
                {filter.label}
              </button>
            ))}
          </div>
          {reports.length === 0 ? (
            <p className="font-lato text-center">No reports yet.</p>
          ) : (
            <table className="font-lato w-full text-left text-sm">
              <thead>
                <tr className="border-b-2 border-stone-300">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Reporter</th>
                  <th className="py-2 pr-4">Reported</th>
                  <th className="py-2 pr-4">{countHeading(countedStatus)}</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Details</th>
                  <th className="py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => {
                  const senderLabel = (senderId: string) =>
                    senderId === report.reporterId
                      ? "Reporter"
                      : senderId === report.reportedUserId
                        ? "Reported"
                        : nameFor(senderId);

                  const isResolvingThis =
                    resolveReport.isPending &&
                    resolveReport.variables?.reportId === report.id;

                  return (
                    <tr
                      key={report.id}
                      className="border-b border-stone-200 align-top"
                    >
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {format(report.dateCreated, "MMM dd yyyy HH:mm")}
                      </td>
                      <td className="py-2 pr-4">
                        {nameFor(report.reporterId)}
                      </td>
                      <td className="py-2 pr-4">
                        {nameFor(report.reportedUserId)}
                      </td>
                      {/* Bold past the first, so a repeat offender is
                          visible while scanning rather than only on being
                          read. One report about someone is the ordinary
                          case and should not draw the eye. */}
                      <td
                        className={
                          report.reportsAboutUser > 1
                            ? "py-2 pr-4 font-bold"
                            : "py-2 pr-4"
                        }
                      >
                        {report.reportsAboutUser}
                      </td>
                      <td className="py-2 pr-4">
                        {REPORT_REASON_LABELS[report.reason]}
                      </td>
                      <td className="py-2 pr-4">{report.status}</td>
                      <td className="py-2 pr-4 break-words">
                        {report.message && <p>{report.message}</p>}
                        {report.conversationSnapshot && (
                          <details className="mt-1">
                            <summary className="cursor-pointer font-semibold">
                              Conversation ({report.conversationSnapshot.length}{" "}
                              {report.conversationSnapshot.length === 1
                                ? "message"
                                : "messages"}
                              )
                            </summary>
                            <ol className="mt-2 flex flex-col gap-1">
                              {report.conversationSnapshot.map(
                                (message, index) => (
                                  <li key={index}>
                                    <span className="font-semibold">
                                      {senderLabel(message.senderId)}
                                    </span>{" "}
                                    <span className="text-stone-600">
                                      {format(
                                        message.sentAt,
                                        "MMM dd yyyy HH:mm",
                                      )}
                                    </span>
                                    : {message.content}
                                  </li>
                                ),
                              )}
                            </ol>
                          </details>
                        )}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {report.status === ReportStatus.OPEN && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                resolveReport.mutate({
                                  reportId: report.id,
                                  status: ReportStatus.REVIEWED,
                                })
                              }
                              disabled={isResolvingThis}
                              className="hover:text-northeastern-red text-stone-600 underline disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Mark reviewed
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                resolveReport.mutate({
                                  reportId: report.id,
                                  status: ReportStatus.DISMISSED,
                                })
                              }
                              disabled={isResolvingThis}
                              className="hover:text-northeastern-red text-stone-600 underline disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {reportsQuery.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => void reportsQuery.fetchNextPage()}
                disabled={reportsQuery.isFetchingNextPage}
                className="font-lato hover:text-northeastern-red rounded-full px-4 py-1 text-sm text-stone-600 underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
              >
                {reportsQuery.isFetchingNextPage
                  ? "Loading more…"
                  : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminReports;
