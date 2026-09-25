import { useState } from "react";
import { format } from "date-fns";
import { ReportStatus } from "@prisma/client";
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
 * The report queue (SCRUM-555): most recent first, defaulting to OPEN and
 * paginated (SCRUM-562) so a flood of reports makes the queue longer rather
 * than pushing genuinely unresolved ones out of what `getReports`'s bounded
 * page carries. Read-only. Resolving a report is SCRUM-552.
 *
 * Modelled on `AdminAuditLog`. `getReports` returns raw user ids, and this
 * resolves them through `getAllUsers`, the query `UserManagement` already
 * makes, so the queue adds no second privileged read of the user table.
 *
 * **Everything a report carries was written by a user**, the reporter's
 * message and every line of the snapshot alike. It is rendered as React text
 * children only, never as HTML, so markup in a report shows as characters.
 */
const AdminReports = () => {
  // Held for the reason `AdminAuditLog` gives: `/admin` is server-rendered,
  // and a phone's hydration pass can mount this for one discarded render.
  const isHydrated = useIsHydrated();

  const [status, setStatus] = useState<ReportStatus | null>(ReportStatus.OPEN);

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

  const state = isHydrated
    ? combineQueryStates(toQueryState(reportsQuery), toQueryState(usersQuery))
    : HELD_QUERY_STATE;

  const reports = (reportsQuery.data?.pages ?? []).flatMap(
    (page) => page.reports,
  );

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
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Details</th>
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
