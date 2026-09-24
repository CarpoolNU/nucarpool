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
import AdminAuditLog from "../components/Admin/AdminAuditLog";
import AdminReports from "../components/Admin/AdminReports";
import AdminMobileNotice from "../components/Admin/AdminMobileNotice";
import useIsHydrated from "../utils/useIsHydrated";
import useIsMobile from "../utils/useIsMobile";
import useIsViewportShorterThan from "../utils/useIsViewportShorterThan";
import { ADMIN_CONSOLE_MIN_HEIGHT_PX } from "../utils/breakpoints";

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
   * That pass still mounts `UserManagement`, but it no longer costs anything:
   * the component gates its own `getAllUsers` on `useIsHydrated`, so the
   * request waits for the render that is known not to be hydration. The gate
   * lives there rather than as a prop from here because it carries no
   * viewport term - `useIsMobile` reports `false` on the pass in question, so
   * "is this a phone" is unanswerable at that point and "might this render be
   * discarded" is the only computable condition. This page therefore knows
   * nothing the component does not. `AdminData` carries the same gate against
   * `option`'s default changing. See `UserManagement.tsx`.
   */
  const isMobile = useIsMobile();

  /*
   * The height half of the same question, and the reason SCRUM-484 touched
   * this line.
   *
   * `isMobile` is width alone, so a phone held in landscape is 667px wide,
   * lands *above* the breakpoint, and was served the full console into a
   * content row 343px tall - measured, at 667x375, against the compiled
   * stylesheet. The console's charts are the tallest fixed blocks in the
   * repository, so what arrived was a 600px chart showing 57% of itself.
   *
   * The threshold is the console's own, derived in `breakpoints.js` from the
   * shortest chart it contains and the row's share of the viewport, and read
   * at this one call site. `MOBILE_BREAKPOINT_PX` is untouched on purpose:
   * SCRUM-477 records why a height term on that constant would move all twelve
   * of its survey sites at once, and SCRUM-474's opt-in threshold is the
   * pattern instead.
   */
  const isTooShort = useIsViewportShorterThan(ADMIN_CONSOLE_MIN_HEIGHT_PX);

  /*
   * Either condition serves the notice, and `isHydrated` still gates both for
   * the reason written above - `isTooShort` has the same server snapshot as
   * `isMobile` and is false on the hydration pass for the same reason.
   */
  const showMobileNotice = isHydrated && (isMobile || isTooShort);

  return (
    <div className="relative h-full select-none">
      {isHydrated && <Header admin={true} />}
      {!userPermission ? (
        <Spinner />
      ) : showMobileNotice ? (
        /*
         * `isMobile`, not `showMobileNotice`: the prop is about which header
         * is on screen, not about why the notice is. `Header` renders its
         * fixed bottom navigation exactly when the viewport is mobile *width*,
         * so a landscape phone reaching the notice by the height term above
         * gets the desktop bar instead - and reserving room for a navigation
         * that is not there would push the notice's own content down by 60px
         * of nothing.
         */
        <AdminMobileNotice reservesMobileNav={isMobile} />
      ) : (
        <div className="h-content-row relative flex w-full flex-row overflow-hidden">
          <div className="border-busy-red z-0 h-full max-w-[250px] min-w-[175px] flex-[1] border-r-4 bg-stone-100">
            <AdminSidebar option={option} setOption={setOption} />
          </div>
          <div className="h-full w-full flex-[3]">
            {option === "management" ? (
              <UserManagement permission={userPermission} />
            ) : option === "audit" ? (
              <AdminAuditLog />
            ) : option === "reports" ? (
              <AdminReports />
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
