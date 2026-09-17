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
import { trpc, realTimeQueryOptions } from "../utils/trpc";
import { UserContext } from "../utils/userContext";
import { useRouter } from "next/router";
import Spinner from "./Spinner";
import { unreadBadge } from "../utils/messages/unreadBadge";
import { useUnreadNotifications } from "../utils/messages/useUnreadNotifications";
import { PublicUser } from "../utils/types";
import useIsMobile from "../utils/useIsMobile";
// The same module `useIsMobile` and `tailwind.config.js` read, so the bar's own
// height, the space every caller reserves for it, and the width at which this
// file stops being mobile all have one definition. The templates below each
// wrote their own wider threshold until this import replaced it; the module's
// docblock carries the rest of that story, including why the three queries
// below are `min-width` and not their inverse.
import {
  DESKTOP_MEDIA_QUERY,
  MOBILE_NAV_SPACE,
  HEADER_BAR_HEIGHT,
  HEADER_BAR_MIN_HEIGHT,
  HEADER_LOGO_MAX_FONT_SIZE,
} from "../utils/breakpoints";
import {
  activeMobileNavItem,
  planMobileNav,
  type NavTab,
} from "../utils/nav/mobileNavPlan";
import { type UnsavedChangesGuard } from "../utils/profile/signOutWithGuard";
import {
  HiOutlineMap,
  HiOutlineChatAlt2,
  HiOutlineUserGroup,
  HiOutlineUser,
} from "react-icons/hi";

/**
 * The header bar.
 *
 * **`height` and `min-height` are a pair, and SCRUM-496 added the second one.**
 * The bar is a percentage of the viewport, which on a landscape phone - 667x375,
 * which `useIsMobile` treats as desktop because the breakpoint is width-only -
 * came to 31.875px. Every control in this bar is a child of it, so that was a
 * ceiling on all of them: SCRUM-491 could cap the tabs and the profile trigger
 * to *fit* the bar, which is what stopped them taking clicks meant for the
 * content row, but nothing inside a 31.875px box can be the 44px Apple's HIG
 * and WCAG 2.5.5 ask of a touch control. Raising the ceiling is this
 * declaration.
 *
 * **Two declarations rather than `height: max(8.5%, 44px)`, and the two are
 * equivalent** - including on `/sign-in`, which renders this same bar inside an
 * auto-height flex column where the percentage has no definite containing
 * block. The expected hazard there was that a `max()` would resolve the
 * percentage against zero and collapse to the floor; measured in Chromium it
 * does not, because an unresolvable percentage makes the whole math function
 * behave as `auto`. That page's bar is 111px before this change and 111px
 * after it under either spelling. `breakpoints.js` has the measurement and the
 * reasons this spelling was kept regardless, none of which is that the other
 * one breaks.
 *
 * `breakpoints.js` also carries the band this binds in - below 517.65px of
 * viewport height, so every desktop window renders the percentage unchanged -
 * and why the bar's children each needed the same floor repeated rather than
 * inheriting this one.
 */
const HeaderDiv = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  background-color: #c8102e;
  padding: 0 20px;
  box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.25);
  height: ${HEADER_BAR_HEIGHT};
  min-height: ${HEADER_BAR_MIN_HEIGHT};
  width: 100%;
  z-index: 10;

  @media ${DESKTOP_MEDIA_QUERY} {
    padding: 0 40px;
  }
`;

/**
 * The mobile bottom navigation.
 *
 * `height` and `padding-bottom` are the load-bearing pair, and they are the
 * point of this block. This used to declare no height, so the bar was whatever
 * its children summed to and three other files each guessed at that number -
 * disagreeing with it and with each other. The height now comes from
 * `MOBILE_NAV_SPACE`, which every one of those callers also reads, so the value
 * cannot drift from what they reserve for it.
 *
 * Both properties are needed, not either one. `MOBILE_NAV_SPACE` is
 * `60px + safe-area-inset-bottom`, and Tailwind's preflight makes this
 * `border-box`, so `padding-bottom` of the same inset leaves a content box for
 * the items while the bar itself still covers the home indicator. Setting the
 * height alone would push the icons *into* the indicator; setting the padding
 * alone would grow the bar past what callers subtract.
 *
 * **That content box is 59px, not 60** - this block's `border-top` is the
 * difference, and SCRUM-502 is the ticket that had to measure it to find out.
 * `MobileNavItem` no longer assumes a figure for it at all; see that
 * component's comment.
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
// attribute `active`". Worth knowing if you go looking for that
// warning: React caches it per attribute name at module scope, so it appears
// **once per page load** and never again - not once per element and not once
// per render, which is why `Header.console.test.tsx` has to be its own file.
// `height: 100%` plus `justify-content: center` is SCRUM-502's fix, and the
// point is that it is structural rather than arithmetic. Before this, the
// item had no declared height at all, so its box was whatever its children
// summed to: 8px padding + 24px icon span + 24px label span (the label's
// wrapper sets no font-size, so it inherits `globals.css`'s 24px line-height
// on a 12px label - an accidental term, not a chosen one) + 8px padding + 4px
// border-bottom = 68px, against a 59px content box `MobileNav` actually
// leaves (see that component's comment). `align-items: center` split the 9px
// excess, so the item overhung the bar 3.5px on top and 4.5px on the bottom -
// and the border-bottom, the *only* visual difference between the active and
// inactive states, was the last 4px of that overhang. On a device with no
// safe-area inset the underline landed entirely below the viewport, which
// left the active tab with no visible marker at all.
//
// `height: 100%` resolves against `MobileNav`'s content box, whatever it
// measures, so the item's own border-box - and therefore its border-bottom -
// is pinned to that edge by construction rather than by keeping every child's
// height summing to a number nobody re-checks when one of them changes. The
// icon and label still want more room than the content box has once padding
// and the border are taken out (48px against roughly 39px), but flexbox lets
// that overflow bleed into the padding rather than past the box itself - so
// nothing here depends on the label wrapper's inherited line-height either,
// unlike the arithmetic this replaced.
const MobileNavItem = styled.button<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
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

/**
 * The in-page logo, which is the bar's only child on the pages that give the
 * bar a definite height.
 *
 * **`height: 100%`, not a pixel figure, and that is SCRUM-484's fix.**
 * `HeaderDiv` above is a percentage of the viewport; this declared `70px` and
 * `111px`, so the child's height had no relationship to the parent's and lost
 * whenever the parent was smaller. Measured at 667x375 the bar is 31.88px and
 * the 111px box overhung it by 39.56px each way - clipped off the top of the
 * screen, painted over the content row below. `100%` cannot do that at any
 * viewport, because it *is* the bar.
 *
 * `line-height: 77px` went with the fixed height, and for the same reason: a
 * third independent number that a 31.88px bar could not hold either. The base
 * `normal` now applies at every width, which makes the line box follow the
 * font rather than contradict it.
 *
 * **The font size is capped and not replaced.** `min()` picks the design size
 * wherever it fits, so an ordinary desktop window renders exactly what it
 * rendered before - 48px, measured identical at 1440x900 - and only a bar too
 * short to hold that line scales it down. `HEADER_LOGO_MAX_FONT_SIZE` carries
 * the derivation and the measured `1.15` behind it.
 *
 * Both `min()` calls name their own design size rather than sharing one: 32px
 * and 48px are different decisions about two different widths, and the cap is
 * the only thing they have in common.
 */
export const Logo = styled.h1`
  font-family: "Lato", sans-serif;
  height: 100%;
  font-style: normal;
  font-weight: 700;
  font-size: min(32px, ${HEADER_LOGO_MAX_FONT_SIZE});
  line-height: normal;
  display: flex;
  align-items: center;
  text-align: center;
  color: #f4f4f4;

  @media ${DESKTOP_MEDIA_QUERY} {
    font-size: min(48px, ${HEADER_LOGO_MAX_FONT_SIZE});
  }
`;

/**
 * The sign-in logo, and **deliberately not given `Logo`'s treatment above.**
 *
 * It looks like the same defect and is not, which is the reason this comment
 * exists rather than a matching edit. `sign-in.tsx:68` renders `Header` inside
 * a `w-fit` card in an auto-height flex column, so `HeaderDiv`'s `height: 8.5%`
 * has no definite containing block to resolve against and falls back to
 * `auto`: on that page the bar takes its height *from* this logo instead of
 * imposing one on it. Measured in Chromium at 667x375 against the compiled
 * stylesheet, the bar computes to `111px` and this logo's box ends exactly at
 * the bar's own bottom edge - an overflow of 0.
 *
 * So the two changes that fix `Logo` would both be regressions here. `100%`
 * against an auto-height parent collapses to the line box and shrinks the
 * card's header by about half; the `dvh` font cap is derived from a bar that
 * is 8.5% of the viewport, which this one is not, so it would shrink the
 * sign-in logo on a short window where the card has room to spare.
 *
 * Leaving it untouched is also what keeps `/sign-in` out of the blast radius:
 * `Logo` and `SigninLogo` are used nowhere but this file, and only in the two
 * arms of one ternary, so the pages are genuinely separable.
 */
export const SigninLogo = styled.h1`
  font-family: "Lato", sans-serif;
  height: 70px;
  font-style: normal;
  font-weight: 700;
  font-size: 32px;
  line-height: normal;
  display: flex;
  align-items: center;
  text-align: center;
  color: #f4f4f4;
  justify-content: center;
  width: 100%;

  @media ${DESKTOP_MEDIA_QUERY} {
    font-size: 48px;
    height: 111px;
    line-height: 77px;
  }
`;

/**
 * One desktop navigation tab's classes.
 *
 * **`py-header-nav-y` is SCRUM-491's fix and is the only part of this string
 * that changed**; `px-4` is the horizontal half of the `p-4` that was here
 * before, at the same 16px. The token caps the vertical padding against the
 * bar's own height, so a tab is 60px wherever 60px fits and exactly the bar
 * everywhere else. `breakpoints.js` carries the derivation and the measured
 * 28px line box it turns on.
 *
 * Hoisted into a constant because the six branches below returned two distinct
 * strings between them, so the padding lived in the file six times and a fix
 * had to find all six. The branches are otherwise untouched.
 */
export const HEADER_NAV_BUTTON_CLASS =
  "rounded-xl px-4 py-header-nav-y font-medium text-xl text-white";

/** The same tab, underlined, which is how the active one is marked. */
export const HEADER_NAV_BUTTON_ACTIVE_CLASS = `underline underline-offset-8 ${HEADER_NAV_BUTTON_CLASS}`;

interface HeaderProps {
  data?: {
    sidebarValue: string;
    setSidebar: Dispatch<SetStateAction<HeaderOptions>>;
    disabled: boolean;
    /**
     * Called when the mobile bottom nav's My Group tab is tapped while it was
     * already the active tab. That case used to do nothing: `setSidebar`
     * receives the same value it already held, React bails out of the
     * same-value `setState` without re-rendering, and the page's own
     * tab-change effect - the one that resets the sheet to its resting
     * position - never runs. This is the page's hook to run that reset
     * anyway, which is what lets tapping My Group again reopen a sheet the
     * header's Close button collapsed. Optional because only `pages/index.tsx`
     * has a sheet detent to reset; nothing else supplying `data` needs it.
     */
    onMyGroupReselected?: () => void;
  };
  admin?: boolean;
  signIn?: boolean;
  profile?: boolean;
  /**
   * The profile page's unsaved-changes guard. Given the navigation the header
   * wants to perform, it either runs it immediately or shows `UnsavedModal`
   * and runs it after the user decides.
   *
   * Taking the navigation as a callback rather than a destination string keeps
   * that change's full page load here, where the reason for it is documented,
   * instead of teaching the profile page when to bypass the router.
   *
   * The type moved to `signOutWithGuard` alongside the third consumer, so the
   * set of things that take the guard is one grep rather than three inline
   * declarations that could drift apart.
   */
  checkChanges?: UnsavedChangesGuard;
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
  // Refetched when the tab comes back, because this is the one query with no
  // other way to recover: `Header` never unmounts while the user stays on `/`,
  // so `refetchOnMount: false` never gets a second chance, and the count only
  // otherwise moves on a live `sendNotification`. A notification missed while
  // the phone was locked would leave the badge wrong for the rest of the
  // session. `useUnreadNotifications` covers the same gap from the transport
  // side, for a socket that drops without the tab ever being backgrounded.
  const { data: unreadMessagesCount } =
    trpc.user.messages.getUnreadMessageCount.useQuery(
      undefined,
      realTimeQueryOptions,
    );
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
   * counter. `useUnreadNotifications` invalidates the query
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
      return HEADER_NAV_BUTTON_ACTIVE_CLASS;
    } else if (sidebarValue == "requests" && sidebarText == "explore") {
      return HEADER_NAV_BUTTON_CLASS;
    }

    if (sidebarValue == "requests" && sidebarText == "requests") {
      return HEADER_NAV_BUTTON_ACTIVE_CLASS;
    } else if (sidebarValue == "explore" && sidebarText == "requests") {
      return HEADER_NAV_BUTTON_CLASS;
    }

    if (displayGroup) {
      return HEADER_NAV_BUTTON_ACTIVE_CLASS;
    } else {
      return HEADER_NAV_BUTTON_CLASS;
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
      currentTab: props.data?.sidebarValue,
    });

    // The full page load the profile page needs. Kept identical, and deliberately not
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
          // `setSidebar` above is a same-value `setState` on a reselect, so it
          // does not itself reopen a collapsed My Group sheet - see
          // `onMyGroupReselected`'s docblock.
          if (plan.tab === "mygroup" && plan.reselected) {
            props.data?.onMyGroupReselected?.();
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
     * if so, do a full page load - **a branch that could not execute**.
     * `handleSidebarChange` only exists inside
     * `renderSidebarOptions`, which renders only when `props.data` is supplied,
     * and the sole caller that supplies it is `pages/index.tsx` at route `/`.
     * So `props.profile` was always undefined and `router.pathname` always `/`.
     *
     * It read like a third way off the profile page, and the unsaved-changes
     * work had to enumerate every `<Header>` usage to prove it was not one. Its comment
     * also said "don't force reload" directly above a full page load.
     *
     * **If a page ever passes both `data` and `profile`, this needs the guard,
     * not the old branch** - leaving the profile page without consulting
     * `checkChanges` is exactly the defect that was fixed. Route it through
     * `planMobileNav`'s equivalent rather than restoring a hard navigation.
     *
     * It is now a plain forward to `setSidebar`: the badge no longer needs the
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
    // Decided beside `planMobileNav` rather than here, because `Header` cannot
    // be executed without a router, a tRPC client and a portal - so a rule
    // living in this function is a rule nothing checks. `/admin` is why it
    // matters: the version inline here fell through to `activeNav` and lit
    // Explore while the user was on the admin dashboard.
    const currentActiveTab = activeMobileNavItem({
      pathname: router.pathname,
      isAdmin: props.admin ?? false,
      displayGroup,
      sidebarValue: props.data?.sidebarValue,
      lastTapped: activeNav,
    });

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
            {!props.signIn && (
              <DropDownMenu checkChanges={props.checkChanges} />
            )}
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
            {/* The guard reaches the dropdown's Sign Out the same way it
                reaches the Map button above: `undefined` everywhere except
                `/profile`, which is the only page with edits to lose. */}
            {!props.signIn && (
              <DropDownMenu checkChanges={props.checkChanges} />
            )}
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
