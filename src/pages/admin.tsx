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
import useIsHydrated from "../utils/useIsHydrated";

// One direct session lookup, not a self-directed HTTP round trip to
// `/api/auth/session`. `getSession` from `next-auth/react` is the
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

  /*
   * Keeps `Header` out of this page's server HTML (SCRUM-423).
   *
   * `Header` branches on `useIsMobile`, and the server cannot know the device
   * - so it emits the desktop branch, and React reads the same server
   * snapshot again during hydration. Every other page that renders `Header`
   * escapes this for free: `trpc` is configured `ssr: false`, so `/` and
   * `/profile` return a spinner until `user.me` resolves and their `Header`
   * mounts fresh on the client, correct from its first render. This page's
   * `userPermission` arrives as a `getServerSideProps` prop rather than a
   * query, so its `Header` is in the server HTML and hydrates the desktop
   * branch once on a phone - mounting `DropDownMenu` behind the bottom
   * navigation that then replaces it.
   *
   * Gating on `useIsHydrated` makes this page's `Header` behave like the
   * others': absent from the server render, mounted on the client, correct on
   * its first pass. The desktop header therefore never renders on a phone at
   * all, rather than rendering once and being discarded.
   *
   * The cost is that the header arrives one render pass late for everyone,
   * `/admin` being an internal, permission-gated, desktop-oriented tool. It
   * is not gated on `userPermission` instead, which would look like the
   * cheaper fix: `getServerSideProps` above redirects on a missing session and
   * on `USER`, and `Permission` has no falsy member, so that value is never
   * absent and the `<Spinner />` branch below is unreachable. Moving `Header`
   * under it would leave it in the server HTML exactly as before.
   */
  const isHydrated = useIsHydrated();

  return (
    <div className="relative h-screen w-screen select-none">
      {isHydrated && <Header admin={true} />}
      {!userPermission ? (
        <Spinner />
      ) : (
        <div className="relative flex h-[91.5%] w-full flex-row overflow-hidden">
          <div className="border-busy-red z-0 h-full max-w-[250px] min-w-[175px] flex-[1] border-r-4 bg-stone-100">
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
