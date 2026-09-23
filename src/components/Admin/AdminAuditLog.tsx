import { format } from "date-fns";
import { trpc } from "../../utils/trpc";
import Spinner from "../Spinner";
import { QueryError } from "../QueryError";
import {
  HELD_QUERY_STATE,
  combineQueryStates,
  toQueryState,
} from "../../utils/queryState";
import useIsHydrated from "../../utils/useIsHydrated";

/**
 * The audit log's list view (SCRUM-541) — every `AdminAuditLog` row, most
 * recent first.
 *
 * `getAuditLog` returns raw `actorId`/`targetId` rather than denormalized
 * emails; this component resolves both through `getAllUsers`, the same query
 * `UserManagement` already fetches, so viewing the log costs no additional
 * privileged read beyond the one `/admin` already makes.
 */
const AdminAuditLog = () => {
  /*
   * Held for the same reason `UserManagement`'s `getAllUsers` and
   * `AdminData`'s queries are: `/admin` is genuinely server-rendered, so a
   * phone's hydration pass can mount the desktop layout — and this option —
   * for one render React then discards. See `UserManagement.tsx`.
   */
  const isHydrated = useIsHydrated();

  const auditLogQuery = trpc.user.admin.getAuditLog.useQuery(undefined, {
    enabled: isHydrated,
  });
  const usersQuery = trpc.user.admin.getAllUsers.useQuery(undefined, {
    enabled: isHydrated,
  });

  const state = isHydrated
    ? combineQueryStates(toQueryState(auditLogQuery), toQueryState(usersQuery))
    : HELD_QUERY_STATE;

  const emailById = new Map(
    (usersQuery.data ?? []).map((user) => [user.id, user.email]),
  );
  const nameFor = (id: string) => emailById.get(id) ?? id;

  return (
    <div className="relative h-full w-full">
      {state.status === "error" && (
        <QueryError
          variant="page"
          subject="the audit log"
          onRetry={state.retry}
        />
      )}
      {state.status === "loading" && <Spinner />}
      {state.status === "ready" && auditLogQuery.data && (
        <div className="h-full w-full overflow-auto p-10">
          <h1 className="font-montserrat mb-6 text-center text-3xl font-bold text-black">
            Admin Audit Log
          </h1>
          {auditLogQuery.data.length === 0 ? (
            <p className="font-lato text-center">
              No admin actions recorded yet.
            </p>
          ) : (
            <table className="font-lato w-full text-left text-sm">
              <thead>
                <tr className="border-b-2 border-stone-300">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogQuery.data.map((entry) => (
                  <tr key={entry.id} className="border-b border-stone-200">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {format(entry.dateCreated, "MMM dd yyyy HH:mm")}
                    </td>
                    <td className="py-2 pr-4">{nameFor(entry.actorId)}</td>
                    <td className="py-2 pr-4">{entry.action}</td>
                    <td className="py-2 pr-4">{nameFor(entry.targetId)}</td>
                    <td className="py-2 pr-4">{entry.metadata ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminAuditLog;
