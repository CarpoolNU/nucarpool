import { GetServerSidePropsContext, NextPage } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "./api/auth/[...nextauth]";
import Header from "../components/Header";
import AdminSidebar from "../components/Admin/AdminSidebar";
import { useState } from "react";
import UserManagement from "../components/Admin/UserManagement";
import Spinner from "../components/Spinner";
import { Permission } from "@prisma/client";
import AdminData from "../components/Admin/AdminData";

// One direct session lookup, not a self-directed HTTP round trip to
// `/api/auth/session` (SCRUM-299). `getSession` from `next-auth/react` is the
// *client* helper and was being called here; `getServerSession` reads the cookie
// and queries directly, as `server/router/context.ts` already did.
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (session?.user) {
    if (session.user.permission === "USER") {
      return {
        redirect: {
          destination: "/",
          permanent: false,
        },
      };
    }
  } else {
    return {
      redirect: {
        destination: "/",
        permanent: false,
      },
    };
  }

  return {
    props: {
      userPermission: session.user.permission,
    },
  };
}

interface AdminProps {
  userPermission: Permission;
}

const Admin: NextPage<AdminProps> = ({ userPermission }) => {
  const [option, setOption] = useState<string>("management");
  return (
    <div className="relative h-screen w-screen select-none">
      <Header admin={true} />
      {!userPermission ? (
        <Spinner />
      ) : (
        <div className="relative flex h-[91.5%] w-full flex-row overflow-hidden">
          <div className="z-0 h-full min-w-[175px] max-w-[250px] flex-[1] border-r-4 border-busy-red bg-stone-100">
            <AdminSidebar option={option} setOption={setOption} />
          </div>
          <div className="h-full w-full flex-[3]">
            {option === "management" ? (
              <UserManagement permission={userPermission} />
            ) : (
              <AdminData />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
export default Admin;
