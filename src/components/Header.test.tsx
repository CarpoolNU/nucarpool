import { render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import Header from "./Header";
import { UserContext } from "../utils/userContext";
import { User } from "../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  resizeViewportTo,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";
import { DESKTOP_MEDIA_QUERY } from "../utils/breakpoints";

/**
 * Which navigation the header renders, at each viewport.
 *
 * This is the gate the 640-vs-768 defect lived in. `useIsMobile` used 640 and
 * `Header` used a private 768, so every viewport between them got the desktop
 * layout *and* the mobile bottom bar at once, leaving no usable header at all.
 * That was fixed by giving both one definition in `utils/breakpoints.js`, and
 * `breakpoints.test.ts` guards the constant — but nothing has ever checked
 * that `Header` renders one navigation rather than two, or that it switches at
 * the boundary. It is the single most consequential `isMobile` branch in the
 * app and it was completely uncovered.
 *
 * The two assertions that matter are mutually exclusive: exactly one of the
 * navigations exists at any width. A one-sided test would pass against a
 * header that rendered both, which is precisely what the original defect did.
 *
 * *What this does not cover:* the bottom bar's height, its safe-area padding,
 * and whether it overlaps anything are all layout, and jsdom has none. See
 * `testing/viewport.ts`.
 */

const mockPush = jest.fn();
const mockReplace = jest.fn();

/**
 * `pathname` is `/` so `planMobileNav` treats a tab press as a client-side
 * switch rather than a page load - `/profile` is the one path that navigates
 * hard, and that decision has its own suite in `nav/mobileNavPlan.test.ts`.
 *
 * `query` has to be present, not merely absent: `Header` destructures `tab`
 * out of it to restore the tab a full page load carried in the URL, and
 * destructuring `undefined` throws during render.
 */
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    pathname: "/",
    query: {},
  }),
}));

/**
 * The presigned-URL query behind `DropDownMenu`'s avatar, as a spy.
 *
 * This is that change's regression test, and it replaces a `useProfileImage`
 * mock that used to sit lower in this file. That mock was needed by the
 * *mobile* tests, which was the tell: `useIsMobile` started at
 * `useState(false)` and corrected itself in an effect, so the first render
 * pass on a phone was the *desktop* tree - `DropDownMenu` mounted and fired
 * this query once per mobile page load before being thrown away.
 *
 * Deleting the mock is what the ticket asked for, but on its own it is a weak
 * test: it failed because the mock was missing, so making the `trpc` mock
 * complete would have made it pass again with the bug still present. Spying on
 * the query instead asserts the thing that was actually wrong - that the
 * request happens at all - and it stays meaningful now that the query resolves.
 */
const presignedUrlQuery = jest.fn(() => ({
  data: undefined,
  error: null,
  isLoading: false,
}));

/**
 * The unread count drives the Requests badge. Returned as `undefined` so
 * `unreadBadge` produces a hidden badge — the badge is `useUnreadNotifications`
 * and `unreadBadge`'s subject, both of which have their own suites, and it is
 * not what this file is about.
 */
jest.mock("../utils/trpc", () => ({
  trpc: {
    user: {
      messages: {
        getUnreadMessageCount: { useQuery: () => ({ data: undefined }) },
      },
      groups: { me: { useQuery: () => ({ data: undefined }) } },
      me: { useQuery: () => ({ data: undefined }) },
      /*
       * Reached through an arrow so the spy is read when the query runs rather
       * than when this factory is invoked - `jest.mock` is hoisted above the
       * `const` above, so naming it directly here would be a TDZ error. The
       * `useRouter` mock above depends on the same lazy read.
       */
      getPresignedDownloadUrl: { useQuery: () => presignedUrlQuery() },
    },
  },
}));

/** Subscribes to Pusher for live invalidation; no side effects wanted here. */
jest.mock("../utils/messages/useUnreadNotifications", () => ({
  useUnreadNotifications: () => undefined,
}));

/**
 * The desktop header renders `DropDownMenu`, which calls `useSession` and so
 * needs a `SessionProvider` above it. Mocked rather than provided: a real
 * provider would put this file's subject - which navigation renders - behind
 * next-auth's own state machine, and the menu's contents are not what is being
 * asserted here.
 */
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signOut: jest.fn(),
}));

restoreViewportAfterEach();

/*
 * `clearMocks` is not configured for this project, so the spy accumulates
 * across the tests in this file unless it is reset per test.
 */
beforeEach(() => {
  presignedUrlQuery.mockClear();
});

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  preferredName: "Sam",
} as unknown as User;

const renderHeader = () =>
  render(
    <UserContext.Provider value={VIEWER}>
      <Header
        data={{
          sidebarValue: "explore",
          setSidebar: () => undefined,
          disabled: false,
        }}
        onViewGroupRoute={() => undefined}
      />
    </UserContext.Provider>,
  );

/** The bottom bar carries this; the desktop header does not render it. */
const bottomNav = () => screen.queryByTestId("navigation");

/**
 * The desktop header's brand mark, which is a click target routing to `/`.
 * Used as the desktop branch's identity because it is present in every desktop
 * variant of the header and in none of the mobile one.
 */
const desktopBrand = () => screen.queryByText("CarpoolNU");

describe("Header navigation at a mobile viewport", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("renders the bottom navigation", () => {
    renderHeader();

    expect(bottomNav()).toBeInTheDocument();
  });

  it("renders every tab in it", () => {
    renderHeader();

    // All four, by the testids the component assigns. A tab silently dropped
    // from the mobile bar is unreachable on a phone with no other route to it,
    // which is phase 3's defect class exactly.
    for (const testId of [
      "explore-sidebar",
      "requests-sidebar",
      "mygroup-sidebar",
      "profile-sidebar",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it("underlines the active tab and only the active tab", () => {
    // `renderHeader` passes `sidebarValue: "explore"`, so that is the tab
    // carrying `$active`.
    renderHeader();

    /*
     * The `$active` prop's entire visual effect, and the reason the prop
     * cannot simply be deleted to silence React's non-boolean-attribute
     * warning.
     *
     * This is the assertion that catches the half-done rename. Prefixing the
     * declaration and the call site but leaving the template reading
     * `props.active` makes the interpolation `undefined` for every item - no
     * warning, because nothing is forwarded any more, and no underline
     * either. `Header.console.test.tsx` passes against that; this does not.
     *
     * `getComputedStyle` is load-bearing here in a way `testing/viewport.ts`
     * warns it usually is not. Its caveat is about *inline* styles, where it
     * echoes the declared string back uncomputed. These values come from a
     * stylesheet styled-components injects, and jsdom does resolve that
     * cascade - it parsed `#000` into `rgb(0, 0, 0)` and `transparent` into
     * `rgba(0, 0, 0, 0)`, which is real work rather than an echo. It is still
     * not layout: this says the rule applies, not that four pixels are
     * painted anywhere.
     */
    const borderOf = (testId: string) =>
      getComputedStyle(screen.getByTestId(testId)).borderBottom;

    expect(borderOf("explore-sidebar")).toBe("4px solid rgb(0, 0, 0)");

    // Transparent rather than absent: the width is declared on every item so
    // that gaining the underline does not shift the row by four pixels.
    for (const inactive of [
      "requests-sidebar",
      "mygroup-sidebar",
      "profile-sidebar",
    ]) {
      expect(borderOf(inactive)).toBe("4px solid rgba(0, 0, 0, 0)");
    }
  });

  it("does not also render the desktop header", () => {
    // The other half of the original defect. Rendering both is what left the
    // 640-768 band with no usable header, and it is invisible to a test that
    // only asserts the mobile bar is present.
    renderHeader();

    expect(desktopBrand()).not.toBeInTheDocument();
  });

  it("never mounts the desktop-only avatar query", () => {
    // Not "the desktop header is absent from the final tree", which the test
    // above already covers and which passed while the bug was live. This
    // asserts nothing desktop-only *ever mounted*, by watching the one side
    // effect such a mount produces.
    //
    // It fails against `useState(false)` plus a mount effect, where the query
    // is called during the discarded first pass.
    renderHeader();

    expect(presignedUrlQuery).not.toHaveBeenCalled();
  });
});

describe("Header navigation at a desktop viewport", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("renders the desktop header", () => {
    renderHeader();

    expect(desktopBrand()).toBeInTheDocument();
  });

  it("does not render the bottom navigation", () => {
    renderHeader();

    expect(bottomNav()).not.toBeInTheDocument();
  });

  it("does mount the avatar query here", () => {
    // The control for the assertion above. Without this, a spy that could
    // never be called for some unrelated reason - a renamed procedure, a
    // `DropDownMenu` that stopped requesting an avatar - would make the mobile
    // test pass vacuously and look like a fix.
    renderHeader();

    expect(presignedUrlQuery).toHaveBeenCalled();
  });
});

describe("Header navigation across the boundary", () => {
  it("swaps navigations when the viewport crosses the breakpoint", () => {
    // At exactly the breakpoint it must be the desktop header: Tailwind
    // screens are min-width, so `desktop:` applies *at* 640. A header using
    // `<=` would put itself and the CSS on opposite sides of one pixel, and
    // the whole point of the shared constant is that they cannot.
    setViewportWidth(DESKTOP_WIDTH);
    renderHeader();

    expect(desktopBrand()).toBeInTheDocument();
    expect(bottomNav()).not.toBeInTheDocument();

    resizeViewportTo(MOBILE_WIDTH);

    expect(bottomNav()).toBeInTheDocument();
    expect(desktopBrand()).not.toBeInTheDocument();

    // Back again, because a header that latched into the mobile layout after
    // one narrow moment would pass a one-directional test.
    resizeViewportTo(DESKTOP_WIDTH);

    expect(desktopBrand()).toBeInTheDocument();
    expect(bottomNav()).not.toBeInTheDocument();
  });
});

/**
 * Which width the header's own styling changes at.
 *
 * The navigation suites above cover the JavaScript half of the 640-vs-768
 * defect. This is the CSS half, which outlived it: `HeaderDiv`, `Logo` and
 * `SigninLogo` each kept a hand-written `@media (max-width: 768px)` after the
 * constant moved to 640, so between the two widths the desktop header rendered
 * with a phone's 20px padding and a 32px logo.
 *
 * This is an unusual thing to be able to assert. jsdom does no layout and
 * **does not evaluate media queries** - `matchMedia` is absent entirely - so
 * nothing here can say what 641px looks like. What it can do is read the
 * stylesheet styled-components injects, which jsdom parses for real: the rules
 * below come back from `document.styleSheets` grouped under their conditions.
 * So these tests assert *which query guards which declarations*, never that a
 * pixel was painted. The boundary itself is still a browser check at 639px and
 * 641px. See `testing/viewport.ts`.
 */
describe("Header styling across the breakpoint", () => {
  type StyledRule = { condition: string | null; css: string };

  /**
   * Every declaration block that targets this element, paired with the media
   * condition guarding it - `null` for the unconditional base.
   *
   * Matched by the element's own generated class names rather than by reading
   * the template, so a rule that moved between the base and the query is
   * visible here and a renamed component is not. Duck-typed on
   * `conditionText`/`selectorText` instead of `instanceof CSSMediaRule`,
   * because those constructors are jsdom's and not worth depending on.
   */
  const rulesFor = (element: Element): StyledRule[] => {
    const selectors = Array.from(element.classList).map((name) => `.${name}`);
    const collected: StyledRule[] = [];

    const visit = (rule: CSSRule, condition: string | null) => {
      const asMedia = rule as CSSMediaRule;
      if (typeof asMedia.conditionText === "string") {
        for (const inner of Array.from(asMedia.cssRules)) {
          visit(inner, asMedia.conditionText);
        }
        return;
      }

      const asStyle = rule as CSSStyleRule;
      if (selectors.includes(asStyle.selectorText)) {
        collected.push({ condition, css: asStyle.style.cssText });
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        visit(rule, null);
      }
    }

    return collected;
  };

  const baseOf = (element: Element) =>
    rulesFor(element)
      .filter((rule) => rule.condition === null)
      .map((rule) => rule.css)
      .join(" ");

  const desktopOf = (element: Element) =>
    rulesFor(element)
      .filter((rule) => rule.condition === DESKTOP_MEDIA_QUERY)
      .map((rule) => rule.css)
      .join(" ");

  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /**
   * The assertion that fails if a `max-width: 768px` block comes back. Written
   * as "no condition other than the shared one" rather than "no 768", because
   * the constant is allowed to move and a second hand-written threshold is not.
   */
  it("guards the header's styling with the shared query and nothing else", () => {
    renderHeader();
    const logo = desktopBrand()!;

    const conditions = [logo, logo.parentElement!].flatMap((element) =>
      rulesFor(element)
        .map((rule) => rule.condition)
        .filter((condition): condition is string => condition !== null),
    );

    // Non-empty first: `rulesFor` returning nothing would satisfy every
    // assertion below it and look like a pass.
    expect(conditions.length).toBeGreaterThan(0);
    expect(new Set(conditions)).toEqual(new Set([DESKTOP_MEDIA_QUERY]));
  });

  /**
   * The inversion, as the declarations record it: mobile values unconditional,
   * desktop values inside the query. The old templates had these the other way
   * round, which is what put the boundary at the wrong width.
   */
  it("states the mobile logo as the base and the desktop logo in the query", () => {
    renderHeader();
    const logo = desktopBrand()!;

    expect(baseOf(logo)).toContain("font-size: 32px");
    expect(baseOf(logo)).toContain("height: 70px");

    expect(desktopOf(logo)).toContain("font-size: 48px");
    expect(desktopOf(logo)).toContain("height: 111px");
    expect(desktopOf(logo)).toContain("line-height: 77px");
  });

  it("does the same with the header's padding", () => {
    renderHeader();
    const headerDiv = desktopBrand()!.parentElement!;

    expect(baseOf(headerDiv)).toContain("padding: 0 20px");
    expect(desktopOf(headerDiv)).toContain("padding: 0 40px");
  });
});
