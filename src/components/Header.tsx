import React, {
  Dispatch,
  SetStateAction,
  useContext,
  useState,
  useEffect,
} from "react";
import styled from "styled-components";
import DropDownMenu from "./DropDownMenu";
import { createPortal } from "react-dom";
import { GroupPage } from "./Group/GroupPage";
import { trpc } from "../utils/trpc";
import { UserContext } from "../utils/userContext";
import { useRouter } from "next/router";
import Spinner from "./Spinner";
import { unreadBadge } from "../utils/messages/unreadBadge";
import { useUnreadNotifications } from "../utils/messages/useUnreadNotifications";
import { PublicUser } from "../utils/types";
import useIsMobile from "../utils/useIsMobile";
// The same module `useIsMobile` and `tailwind.config.js` read, so the bar's own
// height and the space every caller reserves for it have one definition.
import { MOBILE_NAV_SPACE } from "../utils/breakpoints";
import { planMobileNav, type NavTab } from "../utils/nav/mobileNavPlan";
import {
  HiOutlineMap,
  HiOutlineChatAlt2,
  HiOutlineUserGroup,
  HiOutlineUser,
} from "react-icons/hi";

const HeaderDiv = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #c8102e;
  padding: 0 40px;
  box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.25);
  height: 8.5%;
  width: 100%;
  z-index: 10;

  @media (max-width: 768px) {
    padding: 0 20px;
  }
`;

/**
 * The mobile bottom navigation.
 *
 * `height` and `padding-bottom` are the load-bearing pair, and they are the
 * point of SCRUM-412. This used to declare no height, so the bar was whatever
 * its children summed to and three other files each guessed at that number -
 * disagreeing with it and with each other. The height now comes from
 * `MOBILE_NAV_SPACE`, which every one of those callers also reads, so the value
 * cannot drift from what they reserve for it.
 *
 * Both properties are needed, not either one. `MOBILE_NAV_SPACE` is
 * `60px + safe-area-inset-bottom`, and Tailwind's preflight makes this
 * `border-box`, so `padding-bottom` of the same inset leaves exactly 60px of
 * content box for the items while the bar itself still covers the home
 * indicator. Setting the height alone would push the icons *into* the
 * indicator; setting the padding alone would grow the bar past what callers
 * subtract.
 */
const MobileNav = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  width: 100%;
  height: ${MOBILE_NAV_SPACE};
  display: flex;
  justify-content: space-around;
  align-items: center;
  background-color: #e6e6e6;
  padding: 0px 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  box-shadow: 0px -2px 6px rgba(0, 0, 0, 0.15);
  z-index: 100;
  border-top: 1px solid #d1d1d1;
`;

// A real <button>, not a div: this is the entire mobile navigation, and as a
// div it was unreachable by keyboard. Tailwind's preflight already
// makes buttons inherit font and drop their border, but this is styled-
// components, so the resets are stated here.
//
// `$active`, not `active`: the `$` marks the prop *transient*, so
// styled-components v6 consumes it for the template below and does not forward
// it to the <button>. Without it React receives `active={true}` as a DOM
// attribute, declines to write it, and logs "Received `true` for a non-boolean
// attribute `active`" (SCRUM-424). Worth knowing if you go looking for that
// warning: React caches it per attribute name at module scope, so it appears
// **once per page load** and never again - not once per element and not once
// per render, which is why `Header.console.test.tsx` has to be its own file.
const MobileNavItem = styled.button<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  width: 25%;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  border-bottom: ${(props) =>
    props.$active ? "4px solid #000" : "4px solid transparent"};
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid #c8102e;
    outline-offset: -2px;
  }
`;

export const Logo = styled.h1`
  font-family: "Lato", sans-serif;
  height: 111px;
  font-style: normal;
  font-weight: 700;
  font-size: 48px;
  line-height: 77px;
  display: flex;
  align-items: center;
  text-align: center;
  color: #f4f4f4;

  @media (max-width: 768px) {
    font-size: 32px;
    height: 70px;
    line-height: normal;
  }
`;

export const SigninLogo = styled.h1`
  font-family: "Lato", sans-serif;
  height: 111px;
  font-style: normal;
  font-weight: 700;
  font-size: 48px;
  line-height: 77px;
  display: flex;
  align-items: center;
  text-align: center;
  color: #f4f4f4;
  justify-content: center;
  width: 100%;

  @media (max-width: 768px) {
    font-size: 32px;
    height: 70px;
    line-height: normal;
  }
`;

interface HeaderProps {
  data?: {
    sidebarValue: string;
    setSidebar: Dispatch<SetStateAction<HeaderOptions>>;
    disabled: boolean;
  };
  admin?: boolean;
  signIn?: boolean;
  profile?: boolean;
  /**
   * The profile page's unsaved-changes guard. Given the navigation the header
   * wants to perform, it either runs it immediately or shows `UnsavedModal`
   * and runs it after the user decides (SCRUM-384).
   *
   * Taking the navigation as a callback rather than a destination string keeps
   * SCRUM-171's full page load here, where the reason for it is documented,
   * instead of teaching the profile page when to bypass the router.
   */
  checkChanges?: (proceed: () => void | Promise<void>) => void | Promise<void>;
  onViewGroupRoute?: (driver: PublicUser, riders: PublicUser[]) => void;
}

/**
 * Unchanged for every importer; the union itself now lives beside
 * `planMobileNav`, so the plan and the header cannot disagree about what a tab
 * is.
 */
export type HeaderOptions = NavTab;

const Header = (props: HeaderProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [activeNav, setActiveNav] = useState<string>("explore");
  const { data: unreadMessagesCount } =
    trpc.user.messages.getUnreadMessageCount.useQuery();
  const user = useContext(UserContext);
  const router = useRouter();

  const [displayGroup, setDisplayGroup] = useState<boolean>(false);

  /**
   * The badge, from the server count alone.
   *
   * There used to be a second local count beside it, incremented on each Pusher
   * notification, which the badge *preferred* — so five unread messages plus
   * one notification displayed `1`, and reading a thread from the map panel
   * could not clear it because only a Requests-tab click reset the local
   * counter (SCRUM-383). `useUnreadNotifications` invalidates the query
   * instead, so there is one number and it is the true one.
   */
  const badge = unreadBadge(unreadMessagesCount);

  // One shared definition, rather than a private `<= 768` check plus an optional
  // prop that let a caller disagree with it. `index.tsx` passed `isMobile={true}`
  // for its mobile instance and nothing for its desktop instance, so the desktop
  // header measured 768 while the page around it measured 640 - and every
  // viewport in between rendered the desktop layout with the mobile bottom
  // navigation and no usable header.
  const isMobile = useIsMobile();

  // The Pusher subscription that keeps the count above honest. It lived here
  // as an inline effect, along with a `setSidebarRef` whose only remaining
  // purpose was to let its notification handler read the sidebar out of a state
  // setter; the handler no longer reads the sidebar at all, so both are gone.
  // The reason that ref existed is preserved in the hook, which still depends
  // on the user id alone.
  useUnreadNotifications(user?.id);

  const renderClassName = (sidebarValue: string, sidebarText: string) => {
    if (sidebarValue == "explore" && sidebarText == "explore") {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else if (sidebarValue == "requests" && sidebarText == "explore") {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }

    if (sidebarValue == "requests" && sidebarText == "requests") {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else if (sidebarValue == "explore" && sidebarText == "requests") {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }

    if (displayGroup) {
      return "underline underline-offset-8 rounded-xl p-4 font-medium text-xl text-white";
    } else {
      return "rounded-xl p-4 font-medium text-xl text-white";
    }
  };

  const handleAdminClick = async () => {
    setIsLoading(true);
    if (!props.admin) {
      await router.push("/admin");
      setIsLoading(false);
    } else {
      await router.push("/");
      setIsLoading(false);
    }
  };

  const handleMapClick = async () => {
    if (props.checkChanges) {
      await props.checkChanges(async () => {
        setIsLoading(true);
        await router.push("/");
        setIsLoading(false);
      });
    } else {
      // explicit navigation
      setIsLoading(true);
      await router.push("/");
      setIsLoading(false);
    }
  };

  const handleMobileNavClick = (option: string) => {
    // Set before the guard runs, and harmless there: `renderMobileNav` pins
    // the highlight to "profile" whenever the route is the profile page, so a
    // cancelled modal cannot leave a tab lit that was never reached.
    setActiveNav(option);

    const plan = planMobileNav({
      option,
      pathname: router.pathname,
      hasUnsavedGuard: props.checkChanges !== undefined,
    });

    // The full page load SCRUM-171 needs. Kept identical, and deliberately not
    // run until the guard below has had its say.
    const leaveProfile = (href: string) => {
      setIsLoading(true);
      // Don't use timeout - let the browser handle the navigation naturally
      window.location.href = href;
    };

    switch (plan.kind) {
      case "guard":
        // `setIsLoading` is *not* set here: the modal is rendered by the
        // profile page, and raising the header's spinner first would cover it
        // and stay up if the user cancels.
        void props.checkChanges?.(() => leaveProfile(plan.href));
        return;

      case "hardNavigate":
        leaveProfile(plan.href);
        return;

      case "switchTab":
        setIsLoading(true);
        router.push({ pathname: "/", query: { tab: plan.tab } }).finally(() => {
          setIsLoading(false);
          if (props.data?.setSidebar) {
            props.data.setSidebar(plan.tab);
          }
        });
        // Opening the Requests tab used to zero the local counter, which was
        // the only way to stop it overriding the server count. Nothing to zero
        // now: the badge already shows what the server says, and a thread the
        // user actually reads is marked read by `MessageContent`.
        return;

      case "openProfile":
        setIsLoading(true);
        router.push("/profile").finally(() => {
          setIsLoading(false);
        });
        return;

      case "ignore":
        return;
    }
  };

  useEffect(() => {
    const { tab, showGroup } = router.query;

    // Handle showGroup parameter (from profile -> My Group navigation)
    if (showGroup === "true") {
      setDisplayGroup(true);
      // Clean up URL parameter after showing modal
      const { showGroup: _, ...restQuery } = router.query;
      if (Object.keys(restQuery).length > 0) {
        router.replace({ pathname: "/", query: restQuery }, undefined, {
          shallow: true,
        });
      } else {
        router.replace("/", undefined, { shallow: true });
      }
    }

    // Handle tab parameter (explore/requests/mygroup navigation)
    if (
      tab &&
      (tab === "explore" || tab === "requests" || tab === "mygroup") &&
      props.data?.setSidebar
    ) {
      props.data.setSidebar(tab as HeaderOptions);
      setActiveNav(tab as string);
    }
  }, [router.query, props.data?.setSidebar, props.data, router]);

  const renderSidebarOptions = ({
    sidebarValue,
    setSidebar,
    disabled,
  }: {
    sidebarValue: string;
    setSidebar: Dispatch<SetStateAction<HeaderOptions>>;
    disabled: boolean;
  }) => {
    if (isLoading) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
          <Spinner />
        </div>
      );
    }

    /**
     * The desktop tab buttons. A sidebar swap, nothing more.
     *
     * This used to begin by asking whether it was leaving the profile page and,
     * if so, do a full page load - **a branch that could not execute**
     * (SCRUM-401). `handleSidebarChange` only exists inside
     * `renderSidebarOptions`, which renders only when `props.data` is supplied,
     * and the sole caller that supplies it is `pages/index.tsx` at route `/`.
     * So `props.profile` was always undefined and `router.pathname` always `/`.
     *
     * It read like a third way off the profile page, and SCRUM-384 had to
     * enumerate every `<Header>` usage to prove it was not one. Its comment
     * also said "don't force reload" directly above a full page load.
     *
     * **If a page ever passes both `data` and `profile`, this needs the guard,
     * not the old branch** - leaving the profile page without consulting
     * `checkChanges` is exactly the defect SCRUM-384 fixed. Route it through
     * `planMobileNav`'s equivalent rather than restoring a hard navigation.
     *
     * It is now a plain forward to `setSidebar` — SCRUM-383 removed the
     * `setCurrentunreadMessagesCount(0)` that fired on the Requests tab, since
     * there is no longer a local counter for a tab click to reset. Kept as a
     * named function rather than inlined because it is the one place a future
     * guard would be added, which is what the warning above is about.
     */
    const handleSidebarChange = (option: HeaderOptions) => {
      setSidebar(option);
    };

    return (
      <div className="pr-8" data-testid="navigation-desktop">
        <button
          onClick={() => {
            handleSidebarChange("explore");
          }}
          disabled={disabled}
          className={renderClassName(sidebarValue, "explore")}
        >
          Explore
        </button>
        <button
          onClick={() => {
            handleSidebarChange("requests");
          }}
          disabled={disabled}
          className={`${renderClassName(sidebarValue, "requests")} relative`}
        >
          Requests
          {badge.show && (
            <span className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center rounded-full bg-white">
              <span className="text-northeastern-red text-xs font-bold">
                {badge.count}
              </span>
            </span>
          )}
        </button>
        <button
          onClick={() => setDisplayGroup(true)}
          disabled={disabled}
          className={renderClassName(sidebarValue, "filler")}
        >
          My Group
        </button>
        {user?.permission !== "USER" && (
          <button
            onClick={handleAdminClick}
            disabled={disabled}
            className={renderClassName(sidebarValue, "filler")}
          >
            Admin
          </button>
        )}
      </div>
    );
  };

  const renderMobileNav = () => {
    const isProfilePage = router.pathname.includes("/profile");

    const currentActiveTab = isProfilePage
      ? "profile"
      : displayGroup
        ? "mygroup"
        : props.data?.sidebarValue || activeNav;

    const navItems = [
      {
        id: "explore",
        icon: <HiOutlineMap />,
        label: "Explore",
        testId: "explore-sidebar",
      },
      {
        id: "requests",
        icon: <HiOutlineChatAlt2 />,
        label: "Requests",
        badge: badge.show,
        testId: "requests-sidebar",
      },
      {
        id: "mygroup",
        icon: <HiOutlineUserGroup />,
        label: "My Group",
        testId: "mygroup-sidebar",
      },
      {
        id: "profile",
        icon: <HiOutlineUser />,
        label: "Profile",
        testId: "profile-sidebar",
      },
    ];

    return (
      <MobileNav data-testid="navigation">
        {navItems.map((item) => (
          <MobileNavItem
            key={item.id}
            type="button"
            $active={currentActiveTab === item.id}
            aria-current={currentActiveTab === item.id ? "page" : undefined}
            onClick={() => {
              handleMobileNavClick(item.id);
            }}
            data-testid={item.testId}
          >
            {/* Spans, not divs: a <button> may not contain flow content. They
                are flex items here, so they lay out exactly as before. */}
            <span
              style={{ fontSize: "24px", display: "flex" }}
              aria-hidden="true"
            >
              {item.icon}
            </span>
            <span style={{ position: "relative", display: "block" }}>
              {item.badge && (
                <span
                  style={{
                    position: "absolute",
                    top: "-18px",
                    right: "-10px",
                    background: "#c8102e",
                    color: "white",
                    borderRadius: "50%",
                    width: "20px",
                    height: "20px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "12px",
                  }}
                >
                  {badge.count}
                </span>
              )}
              <span style={{ fontSize: "12px", fontWeight: "500" }}>
                {item.label}
              </span>
            </span>
          </MobileNavItem>
        ))}
      </MobileNav>
    );
  };

  if (isMobile && !props.signIn) {
    return (
      <>
        {renderMobileNav()}
        {displayGroup &&
          createPortal(
            <GroupPage
              onClose={() => setDisplayGroup(false)}
              onViewGroupRoute={props.onViewGroupRoute!}
            />,
            document.body,
          )}
      </>
    );
  }

  return (
    <>
      <HeaderDiv>
        {props.signIn ? (
          <SigninLogo>CarpoolNU</SigninLogo>
        ) : (
          <Logo onClick={() => router.push("/")} style={{ cursor: "pointer" }}>
            CarpoolNU
          </Logo>
        )}
        {props.admin ? (
          <div className="flex items-center">
            <button
              onClick={handleAdminClick}
              className="rounded-xl pr-10 text-xl font-medium text-white"
            >
              Home
            </button>
            {!props.signIn && <DropDownMenu />}
          </div>
        ) : (
          <div className="flex items-center">
            {props.data && renderSidebarOptions(props.data)}
            {props.profile && (
              <div className="flex">
                <button
                  onClick={handleMapClick}
                  className="rounded-xl pr-10 text-xl font-medium text-white"
                >
                  Map
                </button>
                {user?.permission !== "USER" && (
                  <button
                    onClick={handleAdminClick}
                    className="rounded-xl pr-10 text-xl font-medium text-white"
                  >
                    Admin
                  </button>
                )}
              </div>
            )}
            {!props.signIn && <DropDownMenu />}
          </div>
        )}
      </HeaderDiv>

      {displayGroup &&
        createPortal(
          <GroupPage
            onClose={() => setDisplayGroup(false)}
            onViewGroupRoute={props.onViewGroupRoute!}
          />,
          document.body,
        )}
    </>
  );
};

export default Header;
