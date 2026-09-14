import { Permission } from "@prisma/client";
import { trpc } from "../../utils/trpc";
import React, { useEffect, useState } from "react";
import Spinner from "../Spinner";
import { toast } from "react-toastify/unstyled";
import { ConfigProvider, Select } from "antd";
import { Note } from "../../styles/profile";
import { AdminUser } from "../../utils/types";
import useIsHydrated from "../../utils/useIsHydrated";

type UserManagementProps = {
  permission: Permission;
};
const UserManagement = ({ permission }: UserManagementProps) => {
  const [loading, setLoading] = useState<boolean>(true);
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
   * Nothing flashes while it is held back: `loading` above starts `true` and
   * only clears once `users` arrives, so the deferred pass renders the spinner
   * this component already shows while fetching.
   */
  const isHydrated = useIsHydrated();

  const { data: users } = trpc.user.admin.getAllUsers.useQuery<AdminUser[]>(
    undefined,
    { enabled: isHydrated },
  );
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
  useEffect(() => {
    if (users) {
      setLoading(false);
    }
  }, [users]);
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
      {loading && <Spinner />}
      {!loading && users && (
        <div className="m-auto p-20">
          <div className="flex flex-col gap-10 p-10">
            <h1 className="font-montserrat text-center text-3xl font-bold text-black">
              Permissions Management
            </h1>
            {permission !== "MANAGER" && (
              <div className="items-center gap-1 text-center">
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
                className="text-bold bg-northeastern-red font-lato hover:bg-busy-red w-full justify-center rounded-2xl py-2 text-white"
                onClick={updatePermission}
              >
                Update Permission
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
export default UserManagement;
