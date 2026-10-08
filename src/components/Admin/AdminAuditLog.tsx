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
import {
  describeAuditAction,
  describeAuditDetails,
  describeAuditTarget,
} from "../../utils/adminAuditLabels";

/**
 * The audit log's list view — every `AdminAuditLog` row, most
 * recent first.
 *
 * `getAuditLog` returns raw `actorId`/`targetId` rather than denormalized
 * emails; this component resolves them through `getAllUsers`, the same query
 * `UserManagement` already fetches, so viewing the log costs no additional
 * privileged read beyond the one `/admin` already makes.
 *
 * Only `actorId` is always a user. `targetId` names whatever the action acted
 * on — a user for `updateUserPermission`, a *report* for `resolveReport` — so
 * the Target cell asks `adminAuditLabels` which of the row's two ids names a
 * person, and resolves that one. `getAuditLog` supplies the second id,
 * `targetUserId`, because a report's reported user is not reachable from
 * `getAllUsers` alone.
 */
const AdminAuditLog = () => {
  /*
   * Held for the same reason `UserManagement`'s `getAllUsers` and
   * `AdminData`'s queries are: `/admin` is genuinely server-rendered, so a
   * phone's hydration pass can mount the desktop layout — and this option —
   * for one render React then discards. See `UserManagement.tsx`.
   */
  const isHydrated = useIsHydrated();

  /*
   * `refetchOnMount: "always"`, because every write to this table happens on a
   * tab that is not this one.
   *
   * `admin.updateUserPermission` and `admin.resolveReport` each append an
   * `AdminAuditLog` row inside their transaction, and they are reachable only
   * from `UserManagement` and `AdminReports`. `/admin` renders exactly one
   * panel at a time, so this query is always inactive when a row is written and
   * always remounting when the admin comes back to look - which, with
   * `refetchOnMount` off globally in `utils/trpc.ts`, meant being served a
   * cached log missing the admin's own action for up to the 5-minute `gcTime`.
   *
   * **Invalidating from those two mutations instead was the obvious fix and it
   * does not work.** `invalidateQueries` defaults to `refetchType: "active"`,
   * so an inactive query is only marked; and React Query's `shouldFetchOn`
   * tests `refetchOnMount` *before* staleness, so the mark changes nothing on
   * the remount either. An `invalidate()` added there would have been dead
   * code. This flag is also the only thing that can show another admin's
   * actions, which no invalidation on this client could ever do.
   */
  const auditLogQuery = trpc.user.admin.getAuditLog.useQuery(undefined, {
    enabled: isHydrated,
    refetchOnMount: "always",
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
  const emailFor = (id: string) => emailById.get(id);
  /** Actor is always a user, so a plain lookup is correct here. */
  const actorFor = (id: string) => emailById.get(id) ?? id;

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
                {auditLogQuery.data.map((entry) => {
                  const target = describeAuditTarget(entry, emailFor);
                  const details = describeAuditDetails(
                    entry.action,
                    entry.metadata,
                    entry.targetId,
                  );

                  return (
                    <tr key={entry.id} className="border-b border-stone-200">
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {format(entry.dateCreated, "MMM dd yyyy HH:mm")}
                      </td>
                      <td className="py-2 pr-4">{actorFor(entry.actorId)}</td>
                      <td className="py-2 pr-4">
                        {describeAuditAction(entry.action)}
                      </td>
                      {/* `title` carries the full id back when a cell
                          abbreviated one; undefined when it did not. */}
                      <td className="py-2 pr-4" title={target.title}>
                        {target.text}
                      </td>
                      <td className="py-2 pr-4" title={details.title}>
                        {details.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

export default AdminAuditLog;
