import { Permission } from "@prisma/client";
import { trpc } from "../../utils/trpc";
import React from "react";
import Spinner from "../Spinner";
import { QueryError } from "../QueryError";
import { HELD_QUERY_STATE, toQueryState } from "../../utils/queryState";
import { toast } from "react-toastify/unstyled";
import { ConfigProvider, Select } from "antd";
import { Note } from "../../styles/profile";
import { AdminUser } from "../../utils/types";
import useIsHydrated from "../../utils/useIsHydrated";
import { viewerActionState } from "./viewerAction";

type UserManagementProps = {
  permission: Permission;
};
const UserManagement = ({ permission }: UserManagementProps) => {
  const [selectedUser, setSelectedUser] = React.useState<AdminUser | null>(
    null,
  );
  const [selectedPermission, setSelectedPermission] =
    React.useState<Permission | null>(null);
  /*
   * Holds `getAllUsers` back on a render that hydration may discard.
   *
   * `/admin` is the one page whose dashboard is genuinely in the server HTML,
   * because `userPermission` arrives from `getServerSideProps` rather than
   * from a query behind `ssr: false`. React reads `useIsMobile`'s
   * `getServerSnapshot` - hardcoded `false` - during hydration as well as on
   * the server, so on a phone that pass renders the desktop dashboard and
   * mounts this component before `AdminMobileNotice` replaces it. React Query
   * subscribes in a passive effect, which runs *before* React's corrective
   * re-render, so the request really went out - one privileged read of the
   * whole user table per mobile load, for a list nobody saw.
   *
   * **No viewport term, and that is forced rather than chosen.** On the pass
   * in question `useIsMobile` reports `false` - that *is* the defect - so "is
   * this a phone" cannot be answered here. The only computable question is
   * "might this render be thrown away", so desktop is deferred by that one
   * pass too and then fetches exactly as before. `useProfileImage` gates its
   * presigned-URL call the same way and for the same reason.
   *
   * Nothing flashes while it is held back, but that takes saying so: React
   * Query reads a disabled query as `ready` rather than as loading, so
   * `HELD_QUERY_STATE` supplies the spinner for the deferred pass. A
   * `useState(true)` cleared only by `users` arriving would have exactly
   * that problem: a *failed* query would never clear it either.
   */
  const isHydrated = useIsHydrated();

  const usersQuery = trpc.user.admin.getAllUsers.useQuery<AdminUser[]>(
    undefined,
    { enabled: isHydrated },
  );
  const { data: users } = usersQuery;

  /*
   * `HELD_QUERY_STATE` only while the query is gated; `toQueryState` the
   * moment it is live. Reading the real flags is what lets a failure be a
   * failure - a boolean that only tracks "has data arrived" could never
   * express that.
   */
  const usersState = isHydrated ? toQueryState(usersQuery) : HELD_QUERY_STATE;
  const utils = trpc.useUtils();

  const updateUserPermission = trpc.user.admin.updateUserPermission.useMutation(
    {
      onSuccess: () => {
        toast.success("User permission updated successfully!");
        utils.user.admin.getAllUsers.refetch();
      },
      onError: (error) => {
        toast.error(`Failed to update permission: ${error.message}`);
      },
    },
  );
  const handleUserChange = (value: string) => {
    const user = users?.find((user) => user.id === value);
    if (user) {
      setSelectedUser(user);
      setSelectedPermission(user.permission);
    }
  };
  const updatePermission = () => {
    if (selectedUser && selectedPermission) {
      updateUserPermission.mutate({
        userId: selectedUser.id,
        permission: selectedPermission,
      });
    } else {
      toast.error("User or Permission not selected");
    }
  };

  /*
   * Dropping a user to VIEWER, which takes them out of matching.
   *
   * Refetches `getAllUsers` on success for the same reason the permission
   * mutation does, and for one more: the row's own role is what decides
   * whether this action stays available, so a stale list would keep offering
   * an action the server now refuses.
   */
  const setUserToViewer = trpc.user.admin.setUserToViewer.useMutation({
    onSuccess: () => {
      toast.success("User set to viewer. They are no longer being matched.");
      utils.user.admin.getAllUsers.refetch();
    },
    onError: (error) => {
      toast.error(`Failed to set user to viewer: ${error.message}`);
    },
  });

  const viewerAction = viewerActionState(selectedUser, permission);

  const setToViewer = () => {
    // Guarded by `disabled` below, so this is the stale-state case rather than
    // a click the UI meant to allow: the list can change under a selection.
    if (!viewerAction.enabled || !selectedUser) {
      return;
    }
    setUserToViewer.mutate({ userId: selectedUser.id });
  };
  const groupedOptions = users
    ? [
        {
          label: "Managers",
          options: users
            .filter((user) => user.permission === "MANAGER")
            .map((user) => ({ label: user.email, value: user.id })),
        },
        {
          label: "Admins",
          options: users
            .filter((user) => user.permission === "ADMIN")
            .map((user) => ({ label: user.email, value: user.id })),
        },
        {
          label: "Users",
          options: users
            .filter((user) => user.permission === "USER")
            .map((user) => ({ label: user.email, value: user.id })),
        },
      ]
    : [];

  return (
    <div className="relative h-full w-full">
      {usersState.status === "error" && (
        <QueryError
          variant="page"
          subject="the user list"
          onRetry={usersState.retry}
        />
      )}
      {usersState.status === "loading" && <Spinner />}
      {usersState.status === "ready" && users && (
        <div className="m-auto p-20">
          <div className="flex flex-col gap-10 p-10">
            <h1 className="font-montserrat text-center text-3xl font-bold text-black">
              Permissions Management
            </h1>
            {permission !== "MANAGER" && (
              <div className="flex flex-col items-center gap-1 text-center">
                <Note>
                  Admins can view user permissions but cannot modify them.
                </Note>
                <Note>
                  To change your permission, contact a MANAGER from the
                  dropdown.
                </Note>
              </div>
            )}
            <div className="flex flex-row items-center justify-center gap-8">
              <ConfigProvider
                theme={{
                  token: {
                    fontFamily: "Lato",
                    fontSize: 16,
                    colorPrimary: "#C8102E",
                  },
                }}
              >
                <Select
                  showSearch
                  style={{ width: "180px" }}
                  placeholder={
                    permission === "MANAGER"
                      ? "Select a User"
                      : "View User List"
                  }
                  onChange={handleUserChange}
                  popupMatchSelectWidth={false}
                  placement={"bottomRight"}
                  filterOption={(input, option) =>
                    (option?.label ?? "")
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                  options={groupedOptions}
                />
                <Select
                  placeholder="Change Permission"
                  value={selectedPermission}
                  disabled={permission !== "MANAGER"}
                  onChange={(value: Permission) => {
                    setSelectedPermission(value);
                  }}
                  popupMatchSelectWidth={false}
                  placement={"bottomLeft"}
                  options={[
                    { value: "USER", label: "user" },
                    { value: "ADMIN", label: "admin" },
                    { value: "MANAGER", label: "manager" },
                  ]}
                />
              </ConfigProvider>
            </div>
            {permission === "MANAGER" && (
              <button
                className="bg-northeastern-red font-lato hover:bg-busy-red w-full justify-center rounded-2xl py-2 font-bold text-white"
                onClick={updatePermission}
              >
                Update Permission
              </button>
            )}

            {/*
             * Carpool role, which is a different axis from the permission
             * above: permission is what a user may administer, role is how
             * they take part in matching. Separated by a rule and its own
             * heading so the two are not read as one control.
             *
             * One-way by design. Restoring a role belongs to the profile form,
             * which validates the schedule and addresses a RIDER or DRIVER
             * needs and a VIEWER does not have — and since nothing is locked,
             * the user can do it themselves.
             */}
            {permission === "MANAGER" && (
              <div className="flex flex-col gap-2 border-t border-gray-200 pt-6">
                <h2 className="font-montserrat text-center text-xl font-bold text-black">
                  Carpool Role
                </h2>
                <Note>
                  Setting a user to viewer removes them from matching. It is not
                  a suspension — they can change their role back from their own
                  profile.
                </Note>
                <button
                  className="bg-northeastern-red font-lato hover:bg-busy-red mt-2 w-full justify-center rounded-2xl py-2 font-bold text-white disabled:cursor-not-allowed disabled:bg-gray-400"
                  onClick={setToViewer}
                  disabled={!viewerAction.enabled || setUserToViewer.isPending}
                  title={viewerAction.enabled ? undefined : viewerAction.reason}
                >
                  Set to Viewer
                </button>
                {!viewerAction.enabled && <Note>{viewerAction.reason}</Note>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
export default UserManagement;
