import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Role, Status } from "@prisma/client";
import Header from "./Header";
import { resetTrpcSpies, trpcSpies } from "../testing/trpcHarness";
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
import { routerSpies } from "../testing/nextRouterStub";

/**
 * Which navigation the header renders, at each viewport.
 *
 * `useIsMobile` and `Header` share one breakpoint definition in
 * `utils/breakpoints.js`, which `breakpoints.test.ts` guards. This test
 * guards a different thing: that `Header` renders exactly one navigation
 * rather than both at once, and that it switches at the boundary.
 *
 * The two assertions that matter are mutually exclusive: exactly one of the
 * navigations exists at any width. A one-sided test would pass against a
 * header that rendered both navigations at once.
 *
 * *What this does not cover:* the bottom bar's height, its safe-area padding,
 * and whether it overlaps anything are all layout, and jsdom has none. See
 * `testing/viewport.ts`.
 */

/**
 * `pathname` is `/` so `planMobileNav` treats a tab press as a client-side
 * switch rather than a page load - `/profile` is the one path that navigates
 * hard, and that decision has its own suite in `nav/mobileNavPlan.test.ts`.
 *
 * `query` has to be present, not merely absent: `Header` destructures `tab`
 * out of it to restore the tab a full page load carried in the URL, and
 * destructuring `undefined` throws during render.
 */
jest.mock("next/router", () =>
  require("../testing/nextRouterStub").buildRouterMock({
    // Named explicitly although the stub defaults to both: the comment above
    // is the reason this file needs them, and a change to those defaults must
    // not quietly take it away.
    pathname: "/",
    query: {},
  }),
);

const mockPush = routerSpies().push;

/**
 * `trpc` onto a real React Query, through `testing/trpcHarness.ts`.
 *
 * The presigned-URL query behind `DropDownMenu`'s avatar is this file's one
 * side-effect assertion. `useIsMobile` starts at `useState(false)` and
 * corrects itself in an effect, so the first render pass on a phone is the
 * *desktop* tree - `DropDownMenu` mounts and fires this query once per mobile
 * page load before being thrown away.
 *
 * **Why this is fetched rather than spied at render time.** A `jest.fn()`
 * standing in for `useQuery` is called on the discarded pass whether or not the
 * query is disabled, so it reports the same count either way. And it is
 * disabled here for real: `useProfileImage` gates on `useIsHydrated`, so
 * "`DropDownMenu` rendered" and "a presigned URL was requested" are genuinely
 * two different facts, and only the second one costs anything. The spy below is
 * the harness's `queryFn`, called from inside the client when the request
 * actually goes out, so the counts are measurements. Same shape and the same
 * reasoning as `components/Admin/UserManagement.test.tsx` and
 * `utils/useProfileImage.test.tsx`.
 *
 * The unread count drives the Requests badge and is declared `inertQuery` - a
 * literal result, no fetch - whose `data` is `undefined`, so `unreadBadge`
 * produces a hidden badge. The badge is `useUnreadNotifications` and
 * `unreadBadge`'s subject, both of which have their own suites, and it is not
 * what this file is about.
 *
 * `realTimeQueryOptions` is exported because `Header` imports it by name
 * alongside `trpc` and spreads it into that query.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock(
    {
      "user.messages.getUnreadMessageCount": { inertQuery: true },
      // `{ url: null }` rather than `undefined`: React Query rejects an
      // `undefined` resolution as an error, and null is what the hook's
      // `data?.url ?? null` produces, so the avatar renders its fallback.
      "user.getPresignedDownloadUrl": { query: async () => ({ url: null }) },
    },
    { realTimeQueryOptions: {} },
  ),
);

/** The presigned-URL fetch, counted from inside the client. */
const presignedUrlQuery = () =>
  trpcSpies("user.getPresignedDownloadUrl").queryFn;

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
jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock({
    status: "unauthenticated",
  }),
);

restoreViewportAfterEach();

/*
 * `clearMocks` is not configured for this project, so the harness's spies
 * accumulate across the tests in this file unless they are reset per test.
 */
beforeEach(() => {
  resetTrpcSpies();
});

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  preferredName: "Sam",
} as unknown as User;

/**
 * A fresh `QueryClient` per render, not one shared across the file.
 *
 * `useProfileImage` sets a long `staleTime`, so a client carried between tests
 * would serve the previous test's cached presigned URL and issue no request -
 * making "the avatar query mounted here" pass or fail on test order rather than
 * on the component. A new client per render is a cold load every time.
 */
const renderHeader = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UserContext.Provider value={VIEWER}>
        <Header
          data={{
            sidebarValue: "explore",
            setSidebar: () => undefined,
            disabled: false,
          }}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>
    </QueryClientProvider>,
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
    // from the mobile bar is unreachable on a phone with no other route to it.
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

  it("sizes each nav item to the bar rather than to its children", () => {
    // Not a re-assertion of the border-bottom test above: that one reads the
    // declared value, but a declared height does not by itself prove the box
    // it produces actually lands on-screen. jsdom cannot measure that; it
    // lays nothing out. What it *can* assert is the structural property that
    // matters: the item's own declared height is `100%` of its container,
    // not an omitted declaration that leaves the box to whatever its children
    // add up to. `layoutFixtures.ts`'s `mobile-nav-active-underline` fixture,
    // driven through `scripts/measure-layout.ts`, is what proves that
    // declaration actually keeps the underline on-screen in a real browser.
    renderHeader();

    expect(getComputedStyle(screen.getByTestId("explore-sidebar")).height).toBe(
      "100%",
    );
  });

  it("does not also render the desktop header", () => {
    // Rendering both navigations at once would leave a band of viewports
    // with no usable header, and that is invisible to a test that only
    // asserts the mobile bar is present.
    renderHeader();

    expect(desktopBrand()).not.toBeInTheDocument();
  });

  it("never fires the desktop-only avatar query", async () => {
    // Not "the desktop header is absent from the final tree", which the test
    // above already covers. This asserts nothing desktop-only ever
    // *fetched*, by watching the one side effect such a mount produces.
    //
    // Measured: against `useIsMobile` rewritten as `useState(false)` plus a
    // mount effect, the fetch really does go out on the discarded first pass -
    // React Query subscribes before React's corrective re-render - and this
    // test fails.
    renderHeader();

    // React Query subscribes its observer in a passive effect and fetches from
    // there, so the request would appear a tick after render rather than
    // during it. Draining is what stops this passing merely because nothing
    // has happened yet; the desktop control below is what stops it passing
    // because nothing ever happens.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(presignedUrlQuery()).not.toHaveBeenCalled();
  });
});

/**
 * Reopening a My Group sheet the header's own Close button collapsed needs
 * another way in - see `onMyGroupReselected`'s docblock on `Header` and
 * `reselected`'s on `planMobileNav`.
 */
describe("Header navigation at a mobile viewport — reselecting My Group", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
    // `handleMobileNavClick`'s switchTab branch awaits `router.push(...)`
    // before forwarding the tab, so the mock needs to resolve rather than
    // return `undefined`, which has no `.finally`. Pinning it here says so at
    // the point it matters.
    mockPush.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // `mockClear`, not `mockReset`: the latter would strip the shared stub's
    // resolving default along with this suite's override, leaving a later
    // `router.push` returning `undefined` again.
    mockPush.mockClear();
  });

  it("reopens the sheet when My Group is tapped while already the active tab", async () => {
    const onMyGroupReselected = jest.fn();
    const setSidebar = jest.fn();

    render(
      <UserContext.Provider value={VIEWER}>
        <Header
          data={{
            sidebarValue: "mygroup",
            setSidebar,
            disabled: false,
            onMyGroupReselected,
          }}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>,
    );

    fireEvent.click(screen.getByTestId("mygroup-sidebar"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onMyGroupReselected).toHaveBeenCalledTimes(1);
    // Reselecting still forwards the tab like any other tap - only the
    // sheet-reopening side effect is new.
    expect(setSidebar).toHaveBeenCalledWith("mygroup");
  });

  it("does not reopen the sheet when switching in from a different tab", async () => {
    const onMyGroupReselected = jest.fn();

    render(
      <UserContext.Provider value={VIEWER}>
        <Header
          data={{
            sidebarValue: "explore",
            setSidebar: () => undefined,
            disabled: false,
            onMyGroupReselected,
          }}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>,
    );

    fireEvent.click(screen.getByTestId("mygroup-sidebar"));
    await Promise.resolve();
    await Promise.resolve();

    // A fresh switch already lands on the role's resting detent through the
    // page's own tab-change effect; calling this too would be redundant, not
    // wrong, but asserting its absence is what would catch `reselected` being
    // computed backwards.
    expect(onMyGroupReselected).not.toHaveBeenCalled();
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

  it("does fire the avatar query here", async () => {
    // The control for the assertion above. Without this, a request that could
    // never go out for some unrelated reason - a renamed procedure, a
    // `DropDownMenu` that stopped asking for an avatar, a `useIsHydrated` gate
    // that never opens - would make the mobile test pass vacuously and look
    // like a fix.
    renderHeader();

    await waitFor(() => expect(presignedUrlQuery()).toHaveBeenCalled());
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
 * `HeaderDiv`, `Logo` and `SigninLogo` must share the header's one
 * breakpoint constant rather than a separately hand-written `@media`
 * threshold: if the JavaScript and CSS halves of the responsive switch ever
 * disagree, every viewport between their two thresholds renders the desktop
 * header with a phone's padding and logo size.
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
   * desktop values inside the query.
   */
  it("states the mobile logo as the base and the desktop logo in the query", () => {
    renderHeader();
    const logo = desktopBrand()!;

    /*
     * The design sizes, capped rather than replaced: each is still the first
     * argument to its own `min()`, so a viewport with room for it still gets
     * exactly it.
     */
    expect(baseOf(logo)).toContain("font-size: min(32px");
    expect(desktopOf(logo)).toContain("font-size: min(48px");
  });

  /**
   * A regression guard, and the one assertion in this file whose subject is
   * an *absence*.
   *
   * A fixed pixel height inside a percentage-height bar would overflow the
   * parent at any viewport short enough to make the percentage smaller than
   * the fixed figure. The logo's height is the bar's `100%`, whatever that
   * turns out to be, rather than a number of its own.
   *
   * **A positive control comes first.** `desktopOf` returning the empty string
   * would satisfy every `not.toContain` below it and read as a pass - the same
   * vacuous-negative shape `guards the header's styling` guards against above,
   * and the one the aria-hidden dialog regression was written about. So the
   * block is proved non-empty by the declaration it *does* carry before
   * anything is asserted missing.
   *
   * This says nothing about the resulting geometry. jsdom computes no layout
   * and resolves no `dvh`, so whether the bar is ever short enough to matter
   * is a browser question - measured through `scripts/measure-layout.ts`,
   * recorded on the `header-logo-bar` fixture, and regression-testable only
   * in the layout-fixture Playwright suite.
   */
  it("gives the logo a height it can occupy rather than a fixed one", () => {
    renderHeader();
    const logo = desktopBrand()!;

    // The control: the desktop query does guard a declaration for this
    // element, so the absences below are real absences.
    expect(desktopOf(logo)).toContain("font-size");

    expect(baseOf(logo)).toContain("height: 100%");
    expect(baseOf(logo)).toContain("line-height: normal");

    /* The three declarations that went with a fixed-height box. `line-height:
       77px` was a third independent number a short bar could not hold either. */
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
 * `MobileNav`'s horizontal safe-area padding.
 *
 * The bar needs horizontal safe-area padding, not only the vertical inset: a
 * notched or Dynamic Island iPhone rotated to landscape reports its
 * sensor-housing inset on a horizontal edge, and the outermost tab's tap
 * target would sit partly under it without padding to clear it.
 *
 * **This can only prove the declaration exists, not that it does anything.**
 * jsdom resolves no `env()` and does no layout (`testing/viewport.ts`), so
 * reading `getComputedStyle(...).paddingLeft` here would report whatever the
 * fallback happens to parse to, not a pixel a real device would produce. The
 * same `rulesFor`-style read the breakpoint suite above uses - the injected
 * stylesheet's raw `cssText`, not a computed value - sidesteps that: it
 * proves the rule reached the cascade without asking jsdom to resolve it.
 * The pixel proof is `mobile-nav-horizontal-safe-area` in
 * `src/testing/layoutFixtures.ts`, driven through
 * `scripts/measure-layout.ts` against the real compiled stylesheet with
 * `Emulation.setSafeAreaInsetsOverride` - its `recorded` lines carry the
 * before/after figures this file cannot measure.
 */
describe("Header — MobileNav horizontal safe-area padding", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  const cssTextFor = (element: Element): string => {
    const selectors = Array.from(element.classList).map((name) => `.${name}`);

    return Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter(
        (rule): rule is CSSStyleRule =>
          typeof (rule as CSSStyleRule).selectorText === "string" &&
          selectors.includes((rule as CSSStyleRule).selectorText),
      )
      .map((rule) => rule.style.cssText)
      .join(" ");
  };

  it("declares padding-left and padding-right from the horizontal safe-area insets", () => {
    renderHeader();

    const nav = screen.getByTestId("navigation");
    const css = cssTextFor(nav);

    // Non-empty first, the same vacuous-negative guard the breakpoint suite
    // above uses: an empty read would trivially "pass" every assertion below.
    expect(css.length).toBeGreaterThan(0);

    expect(css).toContain("padding-left: env(safe-area-inset-left, 0px)");
    expect(css).toContain("padding-right: env(safe-area-inset-right, 0px)");

    // The vertical inset this bar already handles.
    expect(css).toContain("padding-bottom: env(safe-area-inset-bottom, 0px)");
  });

  it("still spans the full viewport width, so its background covers the housing band", () => {
    // The other half of the criteria: the padding narrows the *content* box
    // the items sit in, not the bar's own box. `width: 100%` is what keeps
    // the bar's background opaque under the housing even though its tabs
    // move clear of it - jsdom cannot resolve what 100% computes to, but it
    // can confirm the declaration survived the same edit that added padding.
    renderHeader();

    const nav = screen.getByTestId("navigation");
    expect(cssTextFor(nav)).toContain("width: 100%");
  });
});

/**
 * The bar's *other* children need the same cap `Logo` above does.
 *
 * The four desktop tabs and the profile trigger have the same relationship
 * to the same bar: each can be taller than a short enough bar, and the tab
 * group's wrapper has no stacking context - so an uncapped tab can lose part
 * of its tap target to the content row below rather than merely paint in the
 * wrong place, with a tap on its visible bottom third reaching the page
 * instead of the tab.
 *
 * **Everything here is a class request, and that is all jsdom can offer.** It
 * resolves no CSS, computes no percentage and reports every rect as zero (see
 * `testing/viewport.ts`), so not one of the figures above is assertable in
 * this file. They are measured in Chromium against the compiled stylesheet
 * through the `header-control-row` fixture, whose `recorded` lines carry a
 * before and after pair; `scripts/measure-layout.test.ts` fails if either
 * class string here stops matching the one that fixture copied. The geometry
 * itself belongs to the layout-fixture Playwright suite.
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

      /* `px-4` is the horizontal padding, at 16px - the tabs are never too
         wide, and narrowing them would be a change this ticket has no
         measurement for. */
      expect(tab.className).toContain("px-4");
    }
  });

  it("leaves no tab asking for the uncapped padding", () => {
    renderHeader();

    /* `p-4` is one shorthand setting both axes, and a short bar cannot hold
       its vertical half. A regression here would most likely arrive as
       someone reaching for the shorthand. */
    for (const tab of tabs()) {
      expect(tab.className.split(" ")).not.toContain("p-4");
      expect(tab.className.split(" ")).not.toContain("py-4");
    }
  });

  /**
   * The active tab is the state one of the four is always in, and it is a
   * separate string in `Header.tsx` - so the cap can be dropped from it
   * independently of the other three. Measured, the underline does not move
   * at all: the label's line box is centred in the bar either way, at a
   * content-box top of 1.9375px, so the cap is invisible at every viewport
   * except in what responds to a tap.
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
       circle, and a child with its own fixed size would overflow the capped
       box it sits in. */
    expect(classes).toContain("h-full");
    expect(classes).toContain("w-full");
    expect(classes!.split(" ")).not.toContain("h-14");
  });

  /**
   * Why `/sign-in` is outside the blast radius here, pinned rather than
   * assumed - a closeout note on `SigninLogo` is the reason to check.
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

/**
 * The in-page logo routes to `/`, so it needs to be a control reachable by
 * keyboard, not only by pointer - in the tab order, and announced as
 * something that does something rather than as a heading.
 *
 * **Why a native button rather than `tabIndex` on a heading.** A native
 * button brings the tab stop, the role, and Enter/Space activation together;
 * the alternative needs all three re-implemented and still leaves a heading
 * claiming to be a button. The `<h1>` is no loss here: `Logo` is not a
 * document outline, several pages render their own `h1`, and `DropDownMenu`
 * renders one inside this same bar.
 *
 * `SigninLogo` is deliberately untouched, and the test below says so: it has
 * no `onClick`, so it is the one place the brand mark really is just a
 * heading. The styling tests above - which read declarations off the generated
 * class - still apply unchanged, because the styled component kept its class.
 */
describe("the header's brand mark", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("is a button, so the keyboard can reach what the pointer can", () => {
    renderHeader();

    // Found by role rather than by text: that it *is* a button is the subject,
    // and `getByText` would pass even if this were a heading instead.
    const brand = screen.getByRole("button", { name: "CarpoolNU" });
    expect(brand.tagName).toBe("BUTTON");

    // Inside the wizard-less header there is no form to submit, but the type
    // is still explicit - the repo's own convention, recorded on
    // `InitialStep`'s Get Started button.
    expect(brand).toHaveAttribute("type", "button");
  });

  it("still routes home when activated", async () => {
    renderHeader();

    const brand = screen.getByRole("button", { name: "CarpoolNU" });

    // Keyboard activation specifically: a click handler on an `<h1>` never
    // sees Enter, so a heading could not do this at all.
    brand.focus();
    expect(brand).toHaveFocus();
    await act(async () => {
      fireEvent.click(brand);
    });

    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("leaves the sign-in brand mark a heading, because it is not a control", () => {
    render(<Header signIn={true} />);

    // The control: the sign-in header renders its brand mark, so the absence
    // below is a real absence and not an unrendered tree.
    const brand = screen.getByText("CarpoolNU");
    expect(brand.tagName).toBe("H1");

    expect(
      screen.queryByRole("button", { name: "CarpoolNU" }),
    ).not.toBeInTheDocument();
  });
});
