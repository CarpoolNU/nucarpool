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
import AdminMobileNotice from "../components/Admin/AdminMobileNotice";
import useIsHydrated from "../utils/useIsHydrated";
import useIsMobile from "../utils/useIsMobile";

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
   * Keeps `Header` out of this page's server HTML.
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

  /*
   * Which layout this page has, rather than which one the viewport wants.
   *
   * `useIsMobile` reports the real viewport on a fresh mount, but React uses
   * its `getServerSnapshot` during *hydration* as well as on the server - and
   * this page, alone among the pages with a `Header`, really is in the server
   * HTML, because `userPermission` arrives as a `getServerSideProps` prop
   * rather than a query behind `ssr: false`. So `isMobile` alone would be
   * false for the hydration pass and the dashboard would render once on a
   * phone before the notice replaced it.
   *
   * Gating on `isHydrated` does not remove that pass - nothing can, the server
   * cannot know the device - it just makes this read the same way `Header`
   * above it already does, and keeps the dashboard in the server HTML for
   * desktop, which is what `AdminPage.test.tsx` asserts deliberately.
   *
   * The residual cost is that the hydration pass mounts `UserManagement`,
   * whose `getAllUsers` query React Query subscribes to in a passive effect -
   * which runs *before* React's corrective re-render, so the request goes out
   * on a phone and its result is then discarded. Same shape as the wasted
   * presigned-URL calls SCRUM-423 and SCRUM-437 removed, and tracked in
   * SCRUM-452 rather than fixed here, because avoiding it means gating the
   * query inside `UserManagement` instead of the layout in this file.
   */
  const isMobile = useIsMobile();
  const showMobileNotice = isHydrated && isMobile;

  return (
    /*
     * `h-full`, not `h-screen`. `globals.css` sets `#__next` to `100dvh`
     * deliberately - `100vh` on a mobile browser is the height the page would
     * have with the URL bar retracted, so a `100vh` box puts its own bottom
     * edge behind the browser chrome. Inheriting the shell leaves one owner of
     * that decision. `w-screen` is gone with it: `#__next` is already `100vw`,
     * and `100vw` counts the scrollbar where `100%` does not.
     *
     * This line is the `/admin` half of SCRUM-433, taken here because the two
     * tickets touch the same line and editing it twice is how they conflict.
     * `/profile` is the other half and is deliberately untouched.
     */
    <div className="relative h-full select-none">
      {isHydrated && <Header admin={true} />}
      {!userPermission ? (
        <Spinner />
      ) : showMobileNotice ? (
        <AdminMobileNotice />
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
