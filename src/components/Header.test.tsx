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

    /*
     * The design sizes, which SCRUM-484 capped rather than replaced: each is
     * still the first argument to its own `min()`, so a viewport with room for
     * it still gets exactly it.
     */
    expect(baseOf(logo)).toContain("font-size: min(32px");
    expect(desktopOf(logo)).toContain("font-size: min(48px");
  });

  /**
   * SCRUM-484's regression guard, and the one assertion in this file whose
   * subject is an *absence*.
   *
   * The defect was a fixed pixel height inside a percentage-height bar:
   * `HeaderDiv` is 8.5% of the viewport and `Logo` declared `111px`, so the
   * child overflowed its parent at every viewport below about 1500px tall -
   * measured at 31.88px of bar around a 111px logo at 667x375, and still
   * 76.5px around 111px at 1440x900. The fix is that the logo's height is now
   * the bar's, whatever that turns out to be.
   *
   * **A positive control comes first.** `desktopOf` returning the empty string
   * would satisfy every `not.toContain` below it and read as a pass - the same
   * vacuous-negative shape `guards the header's styling` guards against above,
   * and the one SCRUM-475 was written about. So the block is proved non-empty
   * by the declaration it *does* carry before anything is asserted missing.
   *
   * This says nothing about the resulting geometry. jsdom computes no layout
   * and resolves no `dvh`, so whether 100% of the bar is 31.88px is a browser
   * question - measured through `scripts/measure-layout.ts`, recorded on the
   * `header-logo-bar` fixture, and regression-testable only in SCRUM-264's
   * Playwright suite.
   */
  it("gives the logo a height it can occupy rather than a fixed one", () => {
    renderHeader();
    const logo = desktopBrand()!;

    // The control: the desktop query does guard a declaration for this
    // element, so the absences below are real absences.
    expect(desktopOf(logo)).toContain("font-size");

    expect(baseOf(logo)).toContain("height: 100%");
    expect(baseOf(logo)).toContain("line-height: normal");

    /* The three declarations that went with the fixed box. `line-height: 77px`
       was the third independent number a 31.88px bar could not hold either. */
    expect(baseOf(logo)).not.toContain("height: 70px");
    expect(desktopOf(logo)).not.toContain("height: 111px");
    expect(desktopOf(logo)).not.toContain("line-height: 77px");
  });

  /**
   * The deliberate asymmetry, pinned so that a later reader "finishing the
   * job" has to delete a test that says why not.
   *
   * `SigninLogo` keeps the fixed 111px because its bar is not a percentage of
   * anything: `sign-in.tsx:68` puts `Header` inside a `w-fit` card in an
   * auto-height flex column, so `HeaderDiv`'s 8.5% has no definite containing
   * block and resolves to `auto`. Measured in Chromium at 667x375 the bar
   * computes to 111px and the logo's box ends exactly on the bar's bottom edge
   * - an overflow of zero, which is the whole reason this one is not a defect.
   */
  it("leaves the sign-in logo's fixed height alone, because its bar has none", () => {
    render(<Header signIn={true} />);

    const logo = screen.getByText("CarpoolNU");

    expect(baseOf(logo)).toContain("height: 70px");
    expect(desktopOf(logo)).toContain("height: 111px");
    expect(desktopOf(logo)).toContain("line-height: 77px");

    /* And therefore no cap: the card has room the viewport height says nothing
       about, so scaling this logo with `dvh` would shrink it for no reason. */
    expect(baseOf(logo)).toContain("font-size: 32px");
    expect(baseOf(logo)).not.toContain("min(");
    expect(desktopOf(logo)).not.toContain("min(");
  });

  it("does the same with the header's padding", () => {
    renderHeader();
    const headerDiv = desktopBrand()!.parentElement!;

    expect(baseOf(headerDiv)).toContain("padding: 0 20px");
    expect(desktopOf(headerDiv)).toContain("padding: 0 40px");
  });
});

/**
 * The bar's *other* children, which SCRUM-484 did not reach.
 *
 * `Logo` above is a percentage-height bar's child that declared a fixed pixel
 * height, and the tests above are the record of that fix. The four desktop
 * tabs and the profile trigger had the same relationship to the same bar -
 * `p-4 text-xl` is 60px and `h-14 w-14` is 56px, inside a bar that is 31.875px
 * at 667x375 - and one of them lost part of its tap target rather than merely
 * painting in the wrong place: the tab group's wrapper has no stacking
 * context, so the content row below hit-tested above the tabs' lower band and
 * a tap on the visible bottom third of `Explore` reached the page instead.
 *
 * **Everything here is a class request, and that is all jsdom can offer.** It
 * resolves no CSS, computes no percentage and reports every rect as zero (see
 * `testing/viewport.ts`), so not one of the figures above is assertable in
 * this file. They were measured in Chromium against the compiled stylesheet
 * through the `header-control-row` fixture, whose `recorded` lines carry the
 * before and after; `scripts/measure-layout.test.ts` fails if either class
 * string here stops matching the one that fixture copied. The geometry itself
 * belongs to SCRUM-264's Playwright suite.
 */
describe("Header controls inside the bar they have to fit", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /** Every tab in the desktop group, by the label it carries. */
  const tabs = () =>
    ["Explore", "Requests", "My Group", "Admin"].map(
      (label) =>
        screen.getByRole("button", { name: new RegExp(label) }) as HTMLElement,
    );

  it("caps every tab's vertical padding against the bar rather than fixing it", () => {
    renderHeader();

    for (const tab of tabs()) {
      expect(tab.className).toContain("py-header-nav-y");

      /* The horizontal half of the old `p-4` is unchanged at 16px - the tabs
         were never too wide, and narrowing them would be a change this ticket
         has no measurement for. */
      expect(tab.className).toContain("px-4");
    }
  });

  it("leaves no tab asking for the uncapped padding", () => {
    renderHeader();

    /* `p-4` is the defect itself: one shorthand setting both axes, the
       vertical half of which a 31.875px bar cannot hold. A regression here
       would most likely arrive as someone restoring the shorthand. */
    for (const tab of tabs()) {
      expect(tab.className.split(" ")).not.toContain("p-4");
      expect(tab.className.split(" ")).not.toContain("py-4");
    }
  });

  /**
   * The active tab is the state one of the four is always in, and it is a
   * separate string in `Header.tsx` - so the cap can be dropped from it alone.
   * Measured, the underline does not move at all: the label's line box is
   * centred in the bar either way, at a content-box top of 1.9375px before and
   * after, which is why this fix is invisible at every viewport except in what
   * responds to a tap.
   */
  it("keeps the cap on the active tab, which is a second class string", () => {
    renderHeader();

    const active = screen.getByRole("button", { name: /Explore/ });

    // The control: `explore` is the rendered sidebar value, so this really is
    // the underlined variant and the assertion below is not vacuous.
    expect(active.className).toContain("underline");
    expect(active.className).toContain("py-header-nav-y");
  });

  it("caps the profile trigger as a square, so it stays a circle", () => {
    renderHeader();

    const trigger = document.querySelector(".h-header-control");

    expect(trigger).toBeInTheDocument();
    expect(trigger!.className).toContain("w-header-control");
    expect(trigger!.className).toContain("rounded-full");

    /* Both axes from one token. A cap on the height alone would leave a 56px
       circle in a 31.875px bar as a 31.875x56 ellipse. */
    expect(trigger!.className.split(" ")).not.toContain("h-14");
    expect(trigger!.className.split(" ")).not.toContain("w-14");
  });

  it("has the trigger's contents fill it rather than restate its size", () => {
    renderHeader();

    const inner =
      document.querySelector(".h-header-control")!.firstElementChild;

    /* `getAttribute`, not `className`: with no presigned URL this branch is
       the `AiOutlineUser` fallback, and an SVG element's `className` is an
       `SVGAnimatedString` rather than a string. */
    const classes = inner!.getAttribute("class");

    /* `h-full w-full`, not a second `h-14 w-14`: the avatar is a raster in a
       circle, and a child that keeps the old fixed size would overflow the
       capped box it sits in. */
    expect(classes).toContain("h-full");
    expect(classes).toContain("w-full");
    expect(classes!.split(" ")).not.toContain("h-14");
  });

  /**
   * Why `/sign-in` is outside this fix's blast radius, pinned rather than
   * assumed - SCRUM-477's Closeout on `SigninLogo` is the reason to check.
   *
   * Both caps are derived from `100dvh * 0.085`, which reconstructs the bar's
   * basis rather than reading it, so they describe the bar only on the pages
   * where it has a definite height. On `/sign-in` it does not: the card is an
   * auto-height flex column, the 8.5% resolves to `auto`, and the bar takes
   * its height *from* its logo. That would make a cap derived from the
   * viewport wrong there - and it cannot be, because neither control is
   * rendered on that page at all.
   */
  it("renders neither control on the sign-in page", () => {
    render(<Header signIn={true} />);

    // The control: the sign-in header does render, so these are real absences.
    expect(screen.getByText("CarpoolNU")).toBeInTheDocument();

    expect(screen.queryByTestId("navigation-desktop")).not.toBeInTheDocument();
    expect(document.querySelector(".h-header-control")).not.toBeInTheDocument();
  });
});
