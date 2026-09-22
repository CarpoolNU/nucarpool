/**
 * The pages the layout harness measures, and the arithmetic that checks a page
 * reproduces the app's container chain.
 *
 * A fixture is a fragment of markup plus the chain of horizontal insets
 * between the viewport edge and the row being measured. Nothing here renders a
 * React component: the harness serves static HTML, because the point is to get
 * a real browser to resolve this project's real Tailwind output against real
 * widths, and a component would drag in tRPC, NextAuth and a map.
 *
 * **That makes every fixture a copy, and a copy can drift.** It is the one
 * dishonesty available to this harness: a fixture measuring 44px proves
 * nothing if the component it was copied from has since changed. So each
 * fixture names the class string it reproduces, and
 * `scripts/measure-layout.test.ts` asserts that string still appears in the
 * source file the fixture claims - in `yarn test`, on every run, with no
 * browser. A drifted fixture fails there rather than reporting a stale number
 * here.
 *
 * See `layoutProbe.js` for the in-page half and `scripts/measure-layout.ts`
 * for the entry point.
 */

import {
  ADMIN_CONSOLE_MIN_HEIGHT_PX,
  HEADER_BAR_HEIGHT,
  HEADER_BAR_MIN_HEIGHT,
  HEADER_LOGO_MAX_FONT_SIZE,
  MOBILE_NAV_SPACE,
} from "../utils/breakpoints";

/**
 * One step of the chain from the viewport edge to the measured content box.
 *
 * `x` is the **total** horizontal inset the step contributes - both sides. So
 * Tailwind's `px-4` is 32, and a 1px border on each side is 2. Writing the
 * total rather than a per-side figure is deliberate: every use of these
 * numbers sums them, and a per-side representation invites halving the answer
 * once.
 */
export interface ContainerInset {
  /** The utility or property responsible, for the printed derivation. */
  readonly name: string;
  readonly x: number;
}

export interface LayoutFixture {
  /** The `--fixture` argument. */
  readonly name: string;
  readonly summary: string;
  /**
   * The file the markup was copied from, as `path:line`. Read this before
   * trusting a measurement.
   */
  readonly source: string;
  /** The Jira issue whose criterion this reproduces. */
  readonly issue: string;
  /** The viewport width the recorded figures were taken at. */
  readonly viewportWidth: number;
  /**
   * The viewport **height** the recorded figures were taken at, for a fixture
   * whose criterion is vertical.
   *
   * Optional, and the asymmetry with `viewportWidth` is deliberate rather than
   * an omission. A fixture measuring a tap target or a container chain has no
   * height its figures depend on, and making it invent one would be a number
   * nothing checks. A fixture holding a percentage height has nothing *but*
   * that dependency: `#__next` is `100dvh`, so every `%` below it resolves
   * against this and a figure quoted without it is unreadable.
   */
  readonly viewportHeight?: number;
  /**
   * Viewport edge to the `widthProbe` element's **content** box, outermost
   * first, including that element's own padding as the last step.
   */
  readonly insets: readonly ContainerInset[];
  /**
   * The element whose `contentWidth` the insets predict. Named rather than
   * assumed, because the prediction is only checkable against the one box it
   * describes - compared against a `clientWidth` it is out by that element's
   * own padding, which is a mistake that looks like a layout finding.
   */
  readonly widthProbe: string;
  /** Mounted inside `#__next`, exactly as the app's tree is. */
  readonly markup: string;
  /** What to measure, as the `report()` spec the probe takes. */
  readonly probe: {
    readonly boxes: readonly string[];
    readonly footprint?: string;
    readonly against?: readonly string[];
  };
  /** The figures the issue recorded, and what reading them wrong looks like. */
  readonly recorded: readonly string[];
  /**
   * Class strings this fixture copies, each with the file that must still
   * contain it. The drift guard reads these.
   */
  readonly reproduces: readonly {
    readonly file: string;
    readonly className: string;
  }[];
}

/**
 * The content width a chain leaves for the measured row.
 *
 * Summed rather than measured so the harness can print a prediction beside the
 * browser's answer. They agree when the fixture's chain matches the app's; when
 * they do not, the fixture is wrong and every figure it produces is wrong with
 * it. That disagreement is the cheapest available check on a hand-copied
 * container chain, and it costs no browser.
 *
 * Floors at zero: a chain whose insets exceed the viewport describes an
 * overflowing layout, and a negative content width is not a measurement of it.
 */
export const composeContainerWidth = (
  viewportWidth: number,
  insets: readonly ContainerInset[],
): number =>
  Math.max(
    0,
    insets.reduce((remaining, inset) => remaining - inset.x, viewportWidth),
  );

/** The derivation, for printing beside the figure. */
export const describeContainerWidth = (
  viewportWidth: number,
  insets: readonly ContainerInset[],
): string => {
  const terms = insets.map((inset) => `${inset.name} ${inset.x}`).join(" − ");

  return `${composeContainerWidth(viewportWidth, insets)}px  (${viewportWidth}${
    terms ? ` − ${terms}` : ""
  })`;
};

/*
 * The destructive trigger on a group member card, which is SCRUM-480's
 * criterion and the smallest of the seven the harness was rebuilt for.
 *
 * The chain is the mobile group view: `MobileGroupView`'s `px-4` page gutter,
 * the members panel's 1px border on each side, the `divide-y` list (no
 * horizontal inset of its own), and the card's own `px-2`.
 * `GroupPage.tsx:708`, `:748`, `:755` and `GroupMemberCard.tsx:227`
 * respectively.
 *
 * The card's `sm:px-4` is left in the copied class string but does not apply
 * at 375px, which is the point of measuring at 375px.
 *
 * **Two rows, and which one carries `divide-y`'s pixel is the opposite of the
 * habit.** Tailwind v4 compiles `divide-y` to
 * `:where(.divide-y > :not(:last-child)) { border-bottom-width: 1px }` - read
 * out of this project's own compiled output, not from the docs. So the border
 * is on every row *except the last*, where v3's `& > * + *` put it on every
 * row except the *first*. Measured here: the first row is 73 by rect and 72 by
 * `clientHeight`, the last row is 72 by both. A fixture with a single row is
 * therefore the one case that shows no pixel at all, which is how a harness
 * would quietly stop demonstrating the edge it exists to demonstrate.
 */
const GROUP_MEMBER_ROW_CLASS = "flex items-center gap-3 px-2 py-3 sm:px-4";

const GROUP_MEMBER_TRIGGER_CLASS =
  "rounded-lg bg-red-100 p-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50";

const groupMemberCardTrigger: LayoutFixture = {
  name: "group-member-card-trigger",
  summary:
    "The destructive trigger on a group member card, at the mobile group view's width",
  source: "src/components/Group/GroupMemberCard.tsx:371",
  issue: "SCRUM-480",
  viewportWidth: 375,
  insets: [
    { name: "page px-4", x: 32 },
    { name: "panel border", x: 2 },
    { name: "card px-2", x: 16 },
  ],
  markup: `
    <div class="space-y-6 px-4 py-6">
      <div class="rounded-lg border border-gray-200 bg-white shadow-xs">
        <div class="divide-y divide-gray-100">
          <div class="${GROUP_MEMBER_ROW_CLASS}" data-probe="row-divided">
            <div class="flex-shrink-0">
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-200">
                <span class="text-lg font-medium text-gray-600">A</span>
              </div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="truncate text-base font-semibold text-gray-900">Alex Rivera</h3>
                <span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">Driver</span>
              </div>
              <p class="truncate text-sm text-gray-600">alex.rivera@northeastern.edu</p>
            </div>
            <div class="flex-shrink-0">
              <button type="button" class="${GROUP_MEMBER_TRIGGER_CLASS}" data-probe="trigger">Leave Group</button>
            </div>
          </div>
          <div class="${GROUP_MEMBER_ROW_CLASS}" data-probe="row-last">
            <div class="flex-shrink-0">
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-200">
                <span class="text-lg font-medium text-gray-600">S</span>
              </div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="truncate text-base font-semibold text-gray-900">Sam Okafor</h3>
                <span class="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">Rider</span>
              </div>
              <p class="truncate text-sm text-gray-600">sam.okafor@northeastern.edu</p>
            </div>
            <div class="flex-shrink-0">
              <button type="button" class="${GROUP_MEMBER_TRIGGER_CLASS}" data-probe="trigger-last">Remove</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='row-divided']",
  probe: {
    boxes: [
      "[data-probe='row-divided']",
      "[data-probe='row-last']",
      "[data-probe='trigger']",
    ],
    footprint: "[data-probe='trigger']",
  },
  recorded: [
    "trigger clientHeight 44 — the criterion. 12 + 20 (the text-sm line box) + 12.",
    "trigger rect height 44 too: the pixel below is the row's border, not the button's.",
    "row-divided clientHeight 72, rect height 73 — 48 from the h-12 avatar plus py-3, then divide-y's border. The 44px button fits inside without growing the row.",
    "row-last clientHeight 72, rect height 72 — no border. Two rows are in this fixture because one cannot show the difference.",
    "row-divided contentWidth 325, matching the predicted chain. clientWidth is 341; the 16px difference is the row's own px-2.",
    "trigger footprint reachable at all 9 probe points, nothing on top.",
  ],
  reproduces: [
    {
      file: "src/components/Group/GroupMemberCard.tsx",
      className: GROUP_MEMBER_TRIGGER_CLASS,
    },
    {
      file: "src/components/Group/GroupMemberCard.tsx",
      className: GROUP_MEMBER_ROW_CLASS,
    },
  ],
};

/*
 * SCRUM-484's two items, and the one thing they have in common: a
 * percentage-height container holding a fixed-pixel child.
 *
 * `#__next` is `height: 100dvh` (`globals.css`), `HeaderDiv` is a percentage
 * of it under a 44px floor, and every desktop content row is the `h-content-row`
 * remainder. So both
 * fixtures below are unreadable without a viewport *height*, which is why
 * `viewportHeight` exists on the interface above and why `--height` exists on
 * the script.
 *
 * **Both reproduce styled-components declarations, not Tailwind classes**, so
 * the compiled stylesheet the harness serves does not contain them and the
 * markup has to carry its own `<style>`. That is a second copy on top of the
 * copy every fixture already is, and the drift guard is what makes it
 * survivable: `reproduces` names the declaration text, and
 * `measure-layout.test.ts` fails when `Header.tsx` no longer contains it.
 * A declaration is a weaker anchor than a class string - `height: 111px` could
 * in principle move to another rule in the same file - but it is the only
 * anchor available, and it is strictly better than prose.
 */

/**
 * `HeaderDiv`, `Header.tsx:45`. The bar every page's content row sits under.
 *
 * The height is composed from the constant rather than restated, because after
 * SCRUM-484 it *is* the constant - `Header.tsx` reads the same export. The
 * `min-width: 640px` in the queries below is the opposite case and is written
 * literally on purpose: that boundary is an independent decision the fixture
 * should state rather than inherit, so that a fixture measured at 667 is
 * visibly measuring the desktop side of it. `breakpoints.test.ts` is what
 * holds the constant itself to 640.
 */
const HEADER_BAR_CSS = `
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
`;

/**
 * `Logo`, `Header.tsx:148`, mobile base plus the `desktop:` override.
 *
 * **This reproduces the fixed rule, not the defect**, which is the only state
 * a fixture can honestly hold: the drift guard reads `Header.tsx` as it is, so
 * a fixture frozen at the old declarations would fail `yarn test` rather than
 * document anything. The figures the defect produced are in `recorded` below,
 * measured before the change, next to the figures from after it.
 */
const HEADER_LOGO_CSS = `
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
`;

const HEADER_LOGO_DESKTOP_CSS = `
    font-size: min(48px, ${HEADER_LOGO_MAX_FONT_SIZE});
`;

/**
 * The content row the logo overflows into.
 *
 * `admin.tsx:120`'s string, and the choice of page does not affect the figure.
 * All four desktop rows - `admin.tsx:120`, `index.tsx:1039`,
 * `profile/index.tsx:491` and `AdminMobileNotice.tsx:82` - are `h-content-row`
 * siblings of the bar, so the edge this fixture measures against is the bar's
 * own bottom edge on every one of them. The row's own contents differ and are
 * not what is being measured.
 *
 * **The token is what makes that sentence true after SCRUM-496.** The bar now
 * has a 44px floor, so its height is a `max()` and the row's share is no longer
 * a fixed percentage - four hand-copied complements would have had to be
 * corrected in four places to keep this fixture honest, which is the drift the
 * token removes.
 */
const CONTENT_ROW_CLASS =
  "h-content-row relative flex w-full flex-row overflow-hidden";

const headerLogoBar: LayoutFixture = {
  name: "header-logo-bar",
  summary:
    "The 111px desktop logo inside the header's 8.5% bar, at a landscape phone's viewport",
  source: "src/components/Header.tsx:125",
  issue: "SCRUM-484",
  viewportWidth: 667,
  viewportHeight: 375,
  /* The bar's own content box, which is the one prediction available here: the
     logo is a flex item sized by its text, so no chain describes its width.
     `padding: 0 40px` is the `desktop:` value, which applies at 667. */
  insets: [{ name: "bar padding 0 40px", x: 80 }],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }
      [data-probe="logo"] {${HEADER_LOGO_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }

        [data-probe="logo"] {${HEADER_LOGO_DESKTOP_CSS}        }
      }
    </style>
    <div data-probe="bar">
      <h1 data-probe="logo">CarpoolNU</h1>
      <div class="flex items-center">
        <button class="rounded-xl pr-10 text-xl font-medium text-white">Home</button>
      </div>
    </div>
    <div class="${CONTENT_ROW_CLASS}" data-probe="content-row">
      <div class="h-full w-full bg-stone-100">
        <button data-probe="row-first-control" class="m-2 rounded bg-white px-4 py-2">
          Anything at the top of the row
        </button>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='bar']",
  probe: {
    boxes: [
      "[data-probe='bar']",
      "[data-probe='logo']",
      "[data-probe='content-row']",
      "[data-probe='row-first-control']",
    ],
    /* The logo is the footprint because the question is what its box covers,
       not what covers it. `against` then reports the share of that box lying
       over the content row. */
    footprint: "[data-probe='logo']",
    against: ["[data-probe='content-row']"],
  },
  recorded: [
    "bar rect height 31.875 at 375 tall — 8.5% of the viewport, the figure the whole item turns on. Unchanged by the fix; the bar was never the part that was wrong.",
    "AFTER: logo rect height 31.875 and top 0 — the box is the bar. Overflow below the bar 0, clipped above the viewport 0, overlap with the content row 0, against 39.5625 / 39.5625 / 0.356 before.",
    "AFTER: computed font-size 27.7174px, which is 375 * 0.085 / 1.15 — the cap binding, as designed. The text box measures 32.00 against a 31.875 bar, so it is inside it to within 0.06px.",
    "BEFORE: logo rect height 111 with top -39.5625. `align-items: center` split the 79px overflow, so the top 39.5625px was clipped off the screen — the logo was cut through the middle of its letters — and the bottom 39.5625px painted over the content row.",
    "BEFORE, and this is the finding the ticket did not have: the footprint hit test came back `reachable: false`, obstructed at all three lower probe points by the content row's own button. `z-index: 10` on `HeaderDiv` is inert because the element is `position: static`, so the logo painted over the row's *background* and under the row's *controls*. The overlap was a paint defect, not a stolen-click defect. It is `reachable: true` after.",
    "DESKTOP REGRESSION CHECK at 1440x900: font-size 48px, text box top 10.75 height 55 — identical before and after, and the text's centre is exactly the bar's centre. The 17.25px the 111px box used to overhang each way is now 0. Visually unchanged, geometrically correct.",
    "The cap stops binding at 650px of viewport height: measured there, the bar is 55.25 and a 48px line box is 55, so the design size still wins. Below that the logo tracks the bar.",
    "bar contentWidth 587, matching the predicted chain. clientWidth is 667; the 80px difference is the bar's own desktop padding.",
    "SIGN-IN CONTROL, measured separately because `sign-in.tsx` gives the bar no definite height: there the bar computes to 111px and the logo overflows it by 0, before and after. That page is why `SigninLogo` is untouched.",
  ],
  /*
   * Three anchors, because this fixture's CSS comes from two files.
   *
   * The two `Header.tsx` entries pin the *references* - that the bar still
   * takes its height from the constant and the logo still caps its font
   * against it. The `breakpoints.js` entry pins the 8.5% those references
   * resolve to, which is the figure every number above actually depends on.
   * Neither anchor alone is enough: the reference could stay while the value
   * moved, or the value could stay while `Header.tsx` went back to a literal.
   *
   * A declaration is a weaker anchor than a class string - it is not a token
   * list, and `toContain` would still pass if the same text appeared in a
   * different rule in the same file. It is the only anchor styled-components
   * offers, and it is what caught this fixture when `height: 8.5%` became a
   * template reference mid-ticket.
   */
  reproduces: [
    {
      file: "src/components/Header.tsx",
      className: "height: ${HEADER_BAR_HEIGHT};",
    },
    {
      file: "src/components/Header.tsx",
      className: "min-height: ${HEADER_BAR_MIN_HEIGHT};",
    },
    {
      file: "src/components/Header.tsx",
      className: "font-size: min(48px, ${HEADER_LOGO_MAX_FONT_SIZE});",
    },
    {
      file: "src/utils/breakpoints.js",
      className: "const HEADER_BAR_VIEWPORT_PERCENT = 8.5;",
    },
    { file: "src/pages/admin.tsx", className: CONTENT_ROW_CLASS },
  ],
};

/*
 * The admin console's tallest chart in the row it is given.
 *
 * `BarChartUserCounts.tsx:196` and `LineChartCount.tsx:220` are both
 * `min-h-[600px]`; this reproduces one of them, since two would measure the
 * same box twice. `BarChartDaysFrequency`'s `h-[500px]` is shorter and
 * therefore not the binding case.
 *
 * **The x-axis is a stand-in, and that is the honest limit of this fixture.**
 * The real axis is drawn by Chart.js into a canvas, which no static fixture
 * can reproduce - and a canvas has no measurable children even in a browser.
 * What is reproducible is the *box*: Chart.js draws its axis along the bottom
 * edge of the element it is given, so the marker below is pinned there and its
 * rect top is where the axis is. A criterion about the axis being below the
 * fold is a criterion about that edge.
 */
const ADMIN_CHART_CLASS = "relative min-h-[600px] w-full";

/**
 * `BarChartDaysFrequency.tsx:103` - the shortest of the four, and the one
 * `ADMIN_CONSOLE_MIN_HEIGHT_PX` is derived from.
 *
 * Both charts are in this fixture because the threshold's whole argument is
 * about which of them binds. A fixture holding only the 600px block could not
 * show that the gate is set where the *500px* one first fits, which is the
 * decision a reviewer is being asked to accept.
 *
 * ---
 *
 * **A fixture's markup ships as CSS, so it may only use utilities the app
 * already has.** Tailwind v4 scans this file like any other under `src/`, so a
 * class written here for a stand-in element is compiled into the bundle every
 * user downloads - applying to nothing, and costing them the bytes anyway.
 *
 * Measured rather than reasoned about: the first draft of the axis marker below
 * pushed itself down with an automatic top margin, and a selector-set diff of
 * the compiled output against `origin/main` came back with exactly one
 * addition - that margin utility, 39 bytes, applying to nothing. It is now a
 * `flex-1` spacer plus a fixed-height marker, which is the same geometry out of
 * utilities already in the output, and the diff is empty.
 *
 * **The utility is described here rather than named, and that is not
 * squeamishness** - writing it in this sentence would emit it again, which is
 * how the figure above came to be measured twice. `breakpoints.js` keeps the
 * same discipline for the same reason, and `measure-layout.test.ts` documents
 * the trap from the other direction, where naming an invented utility in a
 * comment grew the stylesheet by 52 bytes. This file is more exposed to it
 * than most, because carrying copied markup is its whole purpose.
 */
const ADMIN_SHORT_CHART_CLASS = "flex h-[500px] w-full shrink-0 flex-col";

const ADMIN_SCROLL_PORT_CLASS = "h-full w-full overflow-y-auto py-4";

const ADMIN_SCROLL_INNER_CLASS = "flex h-full w-full flex-col space-y-4 px-8";

const ADMIN_SIDEBAR_CLASS =
  "border-busy-red z-0 h-full max-w-[250px] min-w-[175px] flex-[1] border-r-4 bg-stone-100";

const adminConsoleChartFold: LayoutFixture = {
  name: "admin-console-chart-fold",
  summary:
    "The admin console's two chart heights inside the content row, at the height its gate is set to",
  source: "src/components/Admin/BarChartUserCounts.tsx:196",
  issue: "SCRUM-484",
  viewportWidth: 667,
  /*
   * The gate, not the defect - and the difference matters for what this
   * fixture is for. After SCRUM-484 a 375px-tall viewport is served
   * `AdminMobileNotice` and renders no chart at all, so 375 measures a layout
   * the app no longer produces; the figures it gave are kept in `recorded` as
   * the before-state. `ADMIN_CONSOLE_MIN_HEIGHT_PX` is the shortest viewport
   * that *does* still get the console, which makes it the one height where the
   * threshold's arithmetic is checkable against a browser.
   */
  viewportHeight: ADMIN_CONSOLE_MIN_HEIGHT_PX,
  /*
   * The sidebar's `min-w-[175px]` is the right inset at this width, and the
   * reason is the flex clamp rather than the declaration. `flex-[1]` beside
   * `flex-[3]` would give the sidebar a quarter of the 663px left after its
   * own border - 165.75px - which violates its minimum, so the sidebar
   * freezes at 175 and the content column takes the whole remainder. At a
   * wider viewport the quarter exceeds 175 and `max-w-[250px]` becomes the
   * binding term instead, so this chain is specific to 667 and
   * `describeViewportDimension` is what says so.
   */
  insets: [
    { name: "sidebar min-w-[175px]", x: 175 },
    { name: "sidebar border-r-4", x: 4 },
    { name: "AdminData px-8", x: 64 },
    /*
     * Not a CSS length, and the only inset here that is not. Before SCRUM-488
     * the scroll port never scrolled - the column's one shrinkable child
     * absorbed the whole overflow, so `scrollHeight` equalled `clientHeight`
     * and no scrollbar was laid out. Stopping that shrink is what gives the
     * port real scroll range, and a classic scrollbar takes width from the
     * content when it appears.
     *
     * 11px is Chromium's, measured here at both 667 and 1440. It is the one
     * figure in this fixture that is the environment's rather than the
     * stylesheet's: a platform with overlay scrollbars - macOS Safari, or
     * Chrome with them enabled - takes 0 instead, and Windows takes about 15.
     * It is listed so the predicted width matches the measured one, because a
     * reader told to treat a mismatch as a broken container chain should not
     * meet an 11px mismatch that is nobody's mistake.
     */
    { name: "scroll port's scrollbar (Chromium's, not CSS)", x: 11 },
  ],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }
      }
    </style>
    <div data-probe="bar"></div>
    <div class="${CONTENT_ROW_CLASS}" data-probe="content-row">
      <div class="${ADMIN_SIDEBAR_CLASS}"></div>
      <div class="h-full w-full flex-[3]">
        <div class="${ADMIN_SCROLL_PORT_CLASS}" data-probe="scroll-port">
          <div class="${ADMIN_SCROLL_INNER_CLASS}">
            <button class="bg-northeastern-red self-start rounded px-4 py-2 font-bold text-white">
              Download Data
            </button>
            <div class="${ADMIN_CHART_CLASS}" data-probe="chart">
              <div class="absolute inset-x-0 bottom-0 h-6" data-probe="chart-x-axis"></div>
            </div>
            <div class="${ADMIN_SHORT_CHART_CLASS}" data-probe="short-chart">
              <div class="flex-1"></div>
              <div class="h-6 w-full" data-probe="short-chart-x-axis"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='chart']",
  probe: {
    boxes: [
      "[data-probe='content-row']",
      "[data-probe='scroll-port']",
      "[data-probe='chart']",
      "[data-probe='chart-x-axis']",
      "[data-probe='short-chart']",
      "[data-probe='short-chart-x-axis']",
    ],
  },
  recorded: [
    "At 667x582 — the gate, the shortest viewport still served the console — content-row rect top 49.469 and height 532.523, which is 0.915 of 582 to three decimals.",
    "scroll-port rect top 49.469 and height 532.523 — the row's box exactly, top and bottom, and `portRect.bottom - rowRect.bottom` is 0. SCRUM-488 moved the 16px inside as `py-4`, so the port is no longer a `h-full` box wearing a margin inside an `overflow-hidden` parent. BEFORE it was top 65.469 for the same height, hanging 16px past the row's clip.",
    "The port's usable content height at the gate is 501 — `clientHeight` 533 less the 32px of `py-4` — against the 500px chart the gate is derived from. `ADMIN_CONSOLE_MIN_HEIGHT_PX` solves `0.915 * H - 32 >= 500` to 581.4 and rounds to 582, and that arithmetic is now what the box does rather than what it was hoped to do: scrolled to the maximum the short chart sits at rect top 81.969 and bottom 581.969, whole, inside a row that ends at 581.992.",
    "chart (`min-h-[600px]`) rect height 600 at every viewport measured. A minimum is a floor a flex shrink cannot cross, which is what makes this the console's real tallest block.",
    "short-chart (`h-[500px] shrink-0`) rect height 500 here and 500 at 1440x900, matching what its class string says. BEFORE, without the `shrink-0` SCRUM-488 added, it was 24 here and 151.5 at 1440x900: a shrinkable flex item in a column that always overflows renders at whatever is left, and `min-height: auto` does not stop it.",
    "The scroll range is the other half of that change, and it is the tell that the shrink was doing real work. BEFORE, `scrollHeight` equalled `clientHeight` at 824 at 1440x900 — the port did not scroll at all, because crushing one chart was enough to make the column fit. AFTER it is 1188 against 824, so the console scrolls, and an 11px Chromium scrollbar appears that was never laid out before. That is the `insets` entry above, and it is why this fixture's measured contentWidth is 413 at 667 where SCRUM-484 recorded 424.",
    "chart contentWidth 413, matching the predicted chain once the scrollbar is in it — 424 of CSS less Chromium's 11. Read the sidebar note on `insets` before reusing this at another width, and the scrollbar note before reading the 11 as a constant.",
    "BEFORE, at 667x375 — the viewport that now gets `AdminMobileNotice` instead: row 343.125, port 311.13 of usable window, chart 600, and the axis at rect top 679.875, some 305px below the fold.",
    "BEFORE, and the more serious half: scrolled fully to the bottom the axis's rect bottom was 390.875 against a viewport of 375, so it was *permanently* unreachable — `my-4` plus `h-full` made the port 16px taller than the row that clips it, so its last 16px was outside the clip at any scroll position. Measured at 1440x900 too, where it was also 16. Viewport-independent; fixed in SCRUM-488, and the overhang is 0 at both viewports above.",
  ],
  reproduces: [
    {
      file: "src/components/Admin/BarChartUserCounts.tsx",
      className: ADMIN_CHART_CLASS,
    },
    {
      file: "src/components/Admin/BarChartDaysFrequency.tsx",
      className: ADMIN_SHORT_CHART_CLASS,
    },
    {
      file: "src/components/Admin/AdminData.tsx",
      className: ADMIN_SCROLL_PORT_CLASS,
    },
    {
      file: "src/components/Admin/AdminData.tsx",
      className: ADMIN_SCROLL_INNER_CLASS,
    },
    { file: "src/pages/admin.tsx", className: ADMIN_SIDEBAR_CLASS },
    { file: "src/pages/admin.tsx", className: CONTENT_ROW_CLASS },
    {
      file: "src/utils/breakpoints.js",
      className: "const HEADER_BAR_VIEWPORT_PERCENT = 8.5;",
    },
    {
      file: "src/utils/breakpoints.js",
      className: "const ADMIN_SHORTEST_CHART_HEIGHT_PX = 500;",
    },
  ],
};

/* ===================== SCRUM-485 measurement fixtures ===================== */

/**
 * An inline box for a stand-in element, in CSS rather than utilities.
 *
 * **A fixture's markup ships as CSS, and a stand-in's box is the one part of a
 * fixture that must not.** The rule `adminConsoleChartFold` records above is
 * the same rule: Tailwind v4 scans this file, so a class written here for a
 * placeholder is compiled into the bundle every user downloads, applying to
 * nothing. That fixture could obey it by reaching for utilities the app
 * already had, because its stand-in needed no particular size.
 *
 * These fixtures cannot. A legend pin is 32x42 and a send icon 26x26 - figures
 * set by `width`/`height` props on a `next/image`, not by any utility - and
 * they are load-bearing, because the legend's total height is what item 4 is
 * about. Rounding them to the spacing scale would change the measurement;
 * writing them as arbitrary values would grow the bundle.
 *
 * Measured rather than assumed, and it caught this: the first draft of these
 * fixtures used arbitrary-value utilities, and a selector-set diff of the
 * compiled stylesheet against `origin/main` came back with eight additions -
 * two pin dimensions, two icon dimensions, and the four the Mapbox stand-in
 * needed. An inline style is invisible to the scanner, so the diff is now
 * exactly one line, and it is the `max-height` this ticket set out to remove.
 */
const standIn = (width: number, height: number): string =>
  `width:${width}px;height:${height}px`;

const PROFILE_GRID_CLASS =
  "h-content-row relative grid w-full grid-cols-[250px_repeat(2,1fr)] overflow-hidden";

const PROFILE_SIDEBAR_CLASS =
  "border-busy-red sticky top-0 col-start-1 col-end-2 h-full w-[250px] border-r-4 bg-stone-100 lg:w-[350px]";

const PROFILE_SCROLL_COLUMN_CLASS =
  "col-start-2 col-end-4 flex h-full shrink items-start justify-center overflow-x-hidden overflow-y-auto";

const PROFILE_SCROLL_INNER_CLASS = "mt-10 w-full max-w-2xl px-8";

const ACCOUNT_SECTION_DESKTOP_CLASS =
  "flex h-fit w-[700px] max-w-full flex-col justify-start";

/**
 * `AccountSection.tsx:89` composes its class through a ternary, so the desktop
 * string above never appears contiguously in the source and cannot anchor the
 * drift guard. The anchor is the ternary's own text instead - a weaker anchor
 * than a class string, for the same reason `Header.tsx`'s declarations are, and
 * the only one available where the branch is assembled rather than written.
 */
const ACCOUNT_SECTION_WIDTH_TERNARY =
  'flex h-fit ${isMobile ? "w-full" : "w-[700px]"} max-w-full flex-col justify-start';

const ACCOUNT_SAVE_BUTTON_CLASS =
  "bg-northeastern-red w-full rounded-lg py-3 text-lg text-white hover:bg-red-700";

/**
 * The co-op date row's desktop arm, and the ternary that assembles it.
 *
 * Two constants for one element for the same reason `AccountSection`'s width
 * needs them: the markup below wants the resolved class string, and the drift
 * guard can only anchor on text that appears in the source, where this branch
 * is built by a ternary and never written out contiguously.
 */
const ACCOUNT_DATE_ROW_DESKTOP_CLASS = "flex w-full gap-8";

const ACCOUNT_DATE_ROW_TERNARY =
  'flex ${isMobile ? "flex-col gap-4" : "w-full gap-8"}';

/**
 * `EntryLabel`'s own declarations, as an inline style.
 *
 * The labels either side of the date pickers are the criterion SCRUM-490 asks
 * about - whether narrowing the row truncates one - so a bare `<span>` would
 * measure the wrong thing: `EntryLabel` is a styled-component at 20px bold
 * Montserrat with `display: flex`, none of which Tailwind emits.
 *
 * **Inline rather than a `<style>` block, and the class beside it is real.**
 * A fixture's markup is scanned like any other file, so inventing a utility
 * here would ship a rule to the production bundle that applies to nothing -
 * the eight-rule mistake SCRUM-485 caught in its first draft. Inline styles
 * are invisible to the scanner. `!text-lg` is left as a class on purpose: it
 * is what the component actually passes, it is already in the bundle from
 * `AccountSection` itself, and its `!important` is what beats these inline
 * declarations for `font-size` - which is the cascade the real label resolves
 * through, not an approximation of it.
 *
 * The `@media (min-width: 834px)` padding in `EntryLabel` is deliberately
 * omitted: it is vertical only, and this fixture is measured at 667.
 */
const ENTRY_LABEL_STYLE = [
  /* Single-quoted on purpose. This string is interpolated into a
     double-quoted `style="..."` attribute, so a double quote here closes the
     attribute early and silently drops every declaration after it - which
     presents as a label measuring in the fallback font and reads as "the
     label fits". */
  "font-family: 'Montserrat', sans-serif",
  "font-style: normal",
  "font-weight: 700",
  "font-size: 20px",
  "line-height: 24px",
  "display: flex",
  "align-items: center",
].join("; ");

const USER_SECTION_ROLE_ROW_DESKTOP_CLASS = "flex h-24 w-[700px]";

const profileContentColumnWidth: LayoutFixture = {
  name: "profile-content-column-width",
  summary:
    "The profile page's two 700px desktop rows, now capped, inside the content column an overflow-x-hidden grid gives them",
  source: "src/components/Profile/AccountSection.tsx:89",
  /* SCRUM-485 built this fixture and recorded the defect; SCRUM-490 fixed it
     and re-measured against the same chain. The live criterion is 490's, so
     that is what the banner should name - 485's figures are kept below as the
     before, labelled, because a fixture that only carries the after cannot
     show that anything moved. */
  issue: "SCRUM-490",
  viewportWidth: 667,
  viewportHeight: 375,
  insets: [
    { name: "sidebar column 250px", x: 250 },
    { name: "inner px-8", x: 64 },
  ],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }
      }
    </style>
    <div data-probe="bar"></div>
    <div class="${PROFILE_GRID_CLASS}" data-probe="grid">
      <div class="${PROFILE_SIDEBAR_CLASS}"></div>
      <div class="${PROFILE_SCROLL_COLUMN_CLASS}" data-probe="scroll-column">
        <div class="${PROFILE_SCROLL_INNER_CLASS}" data-probe="scroll-inner">
          <div class="${USER_SECTION_ROLE_ROW_DESKTOP_CLASS} max-w-full items-end" data-probe="role-row">
            <div class="flex gap-8">
              <span>Viewer</span><span>Rider</span><span>Driver</span>
            </div>
            <div class="flex flex-1 flex-col">
              <span>Seat Availability</span>
              <input class="h-14 w-full self-end text-lg" data-probe="seat-field" />
            </div>
          </div>
          <div class="${ACCOUNT_SECTION_DESKTOP_CLASS}" data-probe="account-section">
            <div class="mt-2 w-full">
              <div class="${ACCOUNT_DATE_ROW_DESKTOP_CLASS}" data-probe="date-row">
                <div class="flex flex-1 flex-col">
                  <label class="!text-lg" style="${ENTRY_LABEL_STYLE}" data-probe="start-label">Start Date<span class="text-northeastern-red pl-1">*</span></label>
                  <div class="h-14 w-full rounded-md border border-gray-200 p-2 text-lg" data-probe="start-date">2026-01</div>
                </div>
                <div class="flex flex-1 flex-col">
                  <label class="!text-lg" style="${ENTRY_LABEL_STYLE}" data-probe="end-label">End Date<span class="text-northeastern-red pl-1">*</span></label>
                  <div class="h-14 w-full rounded-md border border-gray-200 p-2 text-lg" data-probe="end-date">2026-06</div>
                </div>
              </div>
              <div class="font-montserrat py-8">
                <button type="button" class="${ACCOUNT_SAVE_BUTTON_CLASS}" data-probe="save-button">
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='scroll-inner']",
  probe: {
    boxes: [
      "[data-probe='grid']",
      "[data-probe='scroll-column']",
      "[data-probe='scroll-inner']",
      "[data-probe='role-row']",
      "[data-probe='seat-field']",
      "[data-probe='account-section']",
      "[data-probe='date-row']",
      "[data-probe='end-date']",
      "[data-probe='save-button']",
    ],
    footprint: "[data-probe='save-button']",
    against: ["[data-probe='scroll-column']"],
  },
  recorded: [
    "AFTER SCRUM-490, at 667x375. Everything below is the fixed layout; the BEFORE lines at the end are SCRUM-485's, kept so the movement is readable.",
    "scroll-inner rect width 402, contentWidth 338 — 15px under the predicted 353, and the prediction is the one to trust. Capping the section makes its content taller than the 343px column, so `overflow-y-auto` draws a scrollbar, and a classic scrollbar in desktop Chromium is 15px. Before the fix the content was wide rather than tall, no scrollbar appeared, and 485 measured the full 417/353. The chain did not change. The insets deliberately do not encode that 15px: a touch device uses overlay scrollbars, which take no width, so on the landscape phone this criterion is about, the column really is 353 and the fixed section is 353 with its right edge at 635. 338 is the harness's answer rather than the device's, and it is the more pessimistic of the two — which is the right way round for a check that the section fits.",
    "account-section rect left 282 width 338 — right edge 620 against a viewport of 667. Fully on screen. Was 700 wide with its right edge at 982.",
    "save-button rect width 338, entirely on screen. `overlaps scroll-column` 1, and the footprint hit test probed all 9 of its points with 0 skipped and 9 on target. Was 0.55 with 3 of 9 skipped.",
    "end-date rect left 467 width 153 — right edge 620, inside the viewport. Was left 531.33 width 217.34 with its right edge at 748.66, so 81.66px hung off the screen.",
    "date-row rect width 338, each picker 153. The row no longer takes a fraction of the column: two thirds of the capped width gave each picker 96.66px, at which both `Start Date` and `End Date` wrap onto a second line — 56px tall instead of 28 — in Montserrat at the 18px the label asks for. At 153px each label is one line.",
    "No hidden overflow left: scroll-column scrollWidth 402 = clientWidth 402, where before it was 732 against 417. Nothing depends on a gesture the column does not offer.",
    "**The labels are measured in a font this page does not load.** The harness serves no webfont, so `EntryLabel`'s Montserrat falls back to the system sans — which is narrower, and measured both labels as fitting on one line at 96.66px when the real font wraps them. The figures above were taken after injecting the Google Fonts link `_document.tsx` carries. Anything read off this fixture about text width, rather than about boxes, has to do the same.",
    "DESKTOP, at 1440x900, and this one is a change rather than a fix: account-section and date-row both narrow from 700 to 608, which is exactly the content box `max-w-2xl` leaves. The declared 700px never fitted at any viewport — it overflowed the reading column on desktop too, just into a column wide enough that nothing clipped. 608 is what role-row has always measured, so the two sections now agree.",
    "BEFORE (SCRUM-485, the defect): scroll-inner contentWidth 353 / clientWidth 417; account-section 700 wide at left 282, 315px off-screen; save-button 700 wide with 385 on screen; end-date right edge 748.66; scroll-column scrollWidth 732 against clientWidth 417, with the document pinned at scrollLeft 0 so no gesture reached any of it.",
    'BEFORE, and not a defect: the save-button label survived, centred in the 700px box at x 632, inside 667. Reading that as "the label is cut off" was the easy mistake.',
    'role-row — `UserSection.tsx:93`, the item SCRUM-477 ranked High — is the counter-example and is untouched by this ticket: `max-w-full` already capped its declared 700px, and it measures 338 here for the same reason account-section now does. SCRUM-477\'s "64px overflow" was a misreading: `ProfilePicture` is not in this div, it is at `UserSection.tsx:175`.',
  ],
  reproduces: [
    { file: "src/pages/profile/index.tsx", className: PROFILE_GRID_CLASS },
    { file: "src/pages/profile/index.tsx", className: PROFILE_SIDEBAR_CLASS },
    {
      file: "src/pages/profile/index.tsx",
      className: PROFILE_SCROLL_COLUMN_CLASS,
    },
    {
      file: "src/pages/profile/index.tsx",
      className: PROFILE_SCROLL_INNER_CLASS,
    },
    {
      file: "src/components/Profile/AccountSection.tsx",
      className: ACCOUNT_SECTION_WIDTH_TERNARY,
    },
    {
      file: "src/components/Profile/AccountSection.tsx",
      className: ACCOUNT_DATE_ROW_TERNARY,
    },
    {
      file: "src/components/Profile/AccountSection.tsx",
      className: ACCOUNT_SAVE_BUTTON_CLASS,
    },
    {
      file: "src/components/Profile/UserSection.tsx",
      className: USER_SECTION_ROLE_ROW_DESKTOP_CLASS,
    },
  ],
};

const HEADER_NAV_BUTTON_CLASS =
  "rounded-xl px-4 py-header-nav-y font-medium text-xl text-white";

/**
 * The active tab, which is the state one of the four is always in.
 *
 * Composed here exactly as `Header.tsx` composes it, so the guard below can
 * check the *composition* rather than a string that appears nowhere: the
 * active class is a template literal in that file, so no literal of the joined
 * result exists to search for.
 *
 * Worth measuring rather than assuming, because `underline-offset-8` puts the
 * rule 8px below the baseline and the padding this ticket shrinks is what used
 * to sit under it.
 */
const HEADER_NAV_BUTTON_ACTIVE_CLASS = `underline underline-offset-8 ${HEADER_NAV_BUTTON_CLASS}`;

/**
 * The size classes lead here because `prettier-plugin-tailwindcss` sorts them
 * that way - it moved `flex` behind the pair when the file was formatted, and
 * the guard below compares against the file as it is written. Worth knowing
 * before hand-editing either copy.
 */
const HEADER_AVATAR_TRIGGER_CLASS =
  "h-header-control w-header-control flex items-center justify-center overflow-hidden rounded-full";

const headerControlRow: LayoutFixture = {
  name: "header-control-row",
  summary:
    "The header's controls - the logo, the tab buttons and the avatar trigger, all capped against the bar - inside a bar that now has a 44px floor under it",
  source: "src/components/DropDownMenu.tsx:76",
  issue: "SCRUM-496",
  viewportWidth: 667,
  viewportHeight: 375,
  insets: [{ name: "bar padding 0 40px", x: 80 }],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }
      [data-probe="logo"] {${HEADER_LOGO_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }

        [data-probe="logo"] {${HEADER_LOGO_DESKTOP_CSS}        }
      }
    </style>
    <div data-probe="bar">
      <h1 data-probe="logo">CarpoolNU</h1>
      <div class="flex items-center">
        <div class="pr-8">
          <button class="${HEADER_NAV_BUTTON_CLASS}" data-probe="nav-button">Explore</button>
          <button class="${HEADER_NAV_BUTTON_ACTIVE_CLASS}" data-probe="nav-button-active">Requests</button>
          <button class="${HEADER_NAV_BUTTON_CLASS}">My Group</button>
        </div>
        <div class="z-30">
          <button class="${HEADER_AVATAR_TRIGGER_CLASS}" data-probe="avatar-trigger">
            <span class="h-full w-full rounded-full bg-gray-400"></span>
          </button>
        </div>
      </div>
    </div>
    <div class="${CONTENT_ROW_CLASS}" data-probe="content-row">
      <div class="h-full w-full bg-stone-100">
        <button data-probe="row-first-control" class="m-2 rounded bg-white px-4 py-2">
          Anything at the top of the row
        </button>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='bar']",
  probe: {
    boxes: [
      "[data-probe='bar']",
      "[data-probe='logo']",
      "[data-probe='nav-button']",
      "[data-probe='nav-button-active']",
      "[data-probe='avatar-trigger']",
      "[data-probe='content-row']",
    ],
    footprint: "[data-probe='avatar-trigger']",
    against: ["[data-probe='content-row']"],
  },
  recorded: [
    "AFTER SCRUM-496, at 667x375, with a 44px floor under the bar. **Every control in this bar now measures 44px**, which is what the 8.5% ceiling made impossible: bar rect height 44, and logo, nav-button, nav-button-active and avatar-trigger all 44 at top 0. The trigger is 44 x 44, still square. contentWidth 587 as predicted, so the container chain is the one being described.",
    "SCRUM-496, the tabs in detail: rect 44 at top 0 with padding 8 top and bottom against a 28px line box - 8 + 28 + 8 is exactly the bar, so the cap still binds and now binds at the floor. The active tab measures identically, which is the point of it having its own probe.",
    "SCRUM-496, the row: content-row rect height 331 at top 44, so the bar and the row sum to exactly 375. The row paid the 12.125px the bar gained, which is the trade that ticket's decision comment weighs.",
    "SCRUM-496, the clicks: `overlaps content-row` is still 0, and the footprint hit test probed all 9 points with 0 skipped, 9 on target, reachable and unobstructed. Sweeping elementFromPoint down each control's centre line at 0.25px, all four answer to the bar's bottom edge - the last sample inside the box is 43.5 for the logo and both tabs and 43.75 for the trigger - and from 44 down every column returns the content row's own background div. **So the visible band and the clickable band are still the same, and they are now 44px rather than 31.875px.** SCRUM-491's property is preserved rather than re-earned.",
    "SCRUM-496, the logo: it followed the bar with no change of its own, because `Logo` declares `height: 100%` and therefore *is* the bar. Its font stays capped against the unfloored percentage, so the type is unchanged at this viewport and its box is 44px. That asymmetry is the correction SCRUM-496 had to make to its own Proposed Fix - the trigger and the tabs reconstruct the bar's height from `100dvh` and had to be given the floor explicitly.",
    "SCRUM-496, DESKTOP CONTROL at 1440x900, and it is unchanged rather than merely acceptable: bar 76.5, nav-button and nav-button-active 60 at top 8.25 with 16px of padding, avatar-trigger 56 at top 10.25, logo 76.5 at font-size 48px, content-row 823.5 at top 76.5 - summing to exactly 900. Identical to the figures below from before the floor, because the floor only wins below 517.65px of viewport height.",
    "SCRUM-496, RE-MEASURED after merging `origin/main` at 5eac02b, which brought in SCRUM-287 and SCRUM-494: identical at 667x375 - bar, logo, both tab probes and the trigger all 44 at top 0, row 331, sum exactly 375, bar contentWidth 587. Neither of those tickets touches this bar, and the figures confirm it rather than assuming it.",
    "SCRUM-496, MID-RANGE at 1366x660: bar 56.09375, nav-button 56.09375, avatar-trigger 56, row 603.8984375 - identical to SCRUM-491's figures at this viewport. Also measured here with inline styles, which the Tailwind scanner cannot see: a box at the old `91.5%` and a box at the row's new `calc(100% - max(8.5%, 44px))` both come back 603.8984375, byte for byte. **So the 0.0078125px by which the bar and the row fail to sum to 660 is Chromium quantising 8.5% to a 1/64px LayoutUnit, and it predates this change rather than being caused by it.** At 375 and at 900 the sum is exact.",
    "SCRUM-496, THE BAND BOUNDARY, which is where the floor hands back over to the percentage. At 800x517 the bar is 44 (the floor), the row 473, the sum exactly 517, and all controls 44. At 800x518 the bar is 44.0234375 - the percentage, matching a bare `8.5%` box measured beside it - the row 473.96875, and that row figure is identical to the old `91.5%` spelling. So the crossover is at the derived 517.647px and above it this change is a no-op.",
    "SCRUM-496, `/sign-in`, reproducing that page's real chain - a full-height centring flex, a `w-fit` auto-height flex column card, `HeaderDiv`, `SigninLogo` at its desktop `height: 111px`. The bar is 111px with the logo's box ending exactly on its bottom edge, an overflow of 0, and it is 111px **unchanged under the shipped `min-height` and also under the `height: max(8.5%, 44px)` spelling that was rejected**. The rejection's stated reason was wrong and is recorded as such: an empty child of an auto-height parent measures 0px for `8.5%`, for `max(8.5%, 44px)` and for `calc(100% - 10px)`, but 44px for a plain `44px` - so Chromium treats a math function whose percentage cannot resolve as `auto` for the whole function rather than substituting zero. Neither spelling touches that page.",
    "BELOW, from SCRUM-491 and SCRUM-485, kept so the movement is readable. Everything from here to the BEFORE block was measured against the 8.5% bar with no floor.",
    "bar rect height 31.875, logo 31.875 at top 0 — SCRUM-484's fix still holding, and untouched by this ticket.",
    "nav-button rect height 31.875 at top 0, padding 1.9375 top and bottom. Was 60 at top -14.0625. The cap is on the padding, so 2 * 1.9375 + 28 is exactly the bar.",
    "nav-button-active — the underlined state one of the four tabs is always in, added as its own probe because `Header.tsx` composes it as a second class string that could lose the cap on its own — measures identically: 31.875 at top 0, padding 1.9375.",
    "avatar-trigger rect 31.875 x 31.875 at top 0, still square. Was 56 x 56 at top -12.0625, hanging 12.06px above the screen and 12.06px into the row.",
    "`overlaps content-row` is 0, where it was 0.215. The footprint hit test probed all 9 of its points with 0 skipped as outside the viewport, 9 on target, reachable and unobstructed — before the fix it skipped 3 of 9 and found 6.",
    "**The clicks are back where the paint is, and that is the criterion this ticket turns on.** Sweeping elementFromPoint down each control's centre line at 0.25px: the tab answers from y 0 to y 31.25 and the content row's background from y 31.5 on; the avatar the same. At y 38 — below the bar, inside the row — both now return the row's own background div, where the avatar used to return its own span. Nothing in the bar hit-tests below the bar.",
    "Before the fix the tab painted a 45.94px visible band of which 31.875px responded, and the avatar's full 43.94px band responded, 12.06px of it inside the content row. After, every control's visible band and its clickable band are the same 31.875px.",
    "**31.875px is below the 44px Apple's HIG and WCAG 2.5.5 ask of a touch control, and no child of this bar could do better.** The bar was 8.5% of a 375px viewport; a 44px target needed the bar's own height changed, which moves the content row on `/`, `/profile` and `/admin`. That was out of SCRUM-491 and was filed as SCRUM-496, **which is done and is the AFTER block at the top of this list** - the floor is in and every control measures 44. What SCRUM-491 fixed was the mismatch: the target no longer claimed to be 45.94px, and it no longer took clicks meant for the page.",
    "**The label does not move at all.** Its content box top is 1.9375 both before and after — a 60px box centred in a 31.875px bar puts its 28px line exactly where a 31.875px box with 1.9375px of padding does. The tabs carry no background or border, so `rounded-xl` paints nothing either; at this viewport the whole change is in what responds to a tap. The avatar is the visible half: a 31.875px circle where a 56px one used to overhang.",
    "The probe reports nav-button contentHeight 28.125, which is derived from the rounded clientHeight of 32 rather than from the rect. The line box is 28: 31.875 less 2 * 1.9375.",
    "One thing the fix does not close, measured rather than assumed: `underline-offset-8` puts the active tab's rule 8px under a baseline at 23.4375, so about 0.56px of that 1px decoration paints below the bar's bottom edge. It is unchanged by this ticket — the line box did not move — it is decoration and does not hit-test, and closing it would mean capping `line-height`, which moves the label at every viewport. **That baseline is the one figure here that depends on the missing webfont** (ascent 19, descent 4, measured through canvas TextMetrics on the system fallback this harness serves). The box figures do not: `text-xl`'s line-height is an absolute 1.75rem, so the 28px holds whatever font arrives.",
    "DESKTOP CONTROL at 1440x900, and it is unchanged rather than merely acceptable: bar 76.5, nav-button 60 at top 8.25 with 16px of padding, nav-button-active 60, avatar-trigger 56 at top 10.25, overflow 0, clickable bands the full 60 and 56. Identical to the figures SCRUM-485 took here before the fix, which is what `min()` against the design size is for.",
    "MID-RANGE at 1366x660, the viewport SCRUM-485 used to argue this was mild: the bar is 56.094 and the tab now takes exactly that, padding 14.05, overhang 0 — it used to overhang 1.953px each way. The trigger's 56px still fits inside by 0.047px, so its cap has not engaged yet. The two thresholds are 706px of viewport height for the tab and 659px for the trigger, and above them nothing changes.",
    "bar contentWidth 587, matching the predicted chain; the 80px against clientWidth 667 is the bar's own desktop padding. Unchanged — this ticket touches no horizontal figure, and `px-4` is the horizontal half of the old `p-4` at the same 16px.",
    "A note for the next selector-set diff on this fixture: `h-14`, `w-14` and `p-4` are all still in the compiled stylesheet afterwards, because the comments explaining their removal name them and Tailwind v4 scans prose. Their absence from the output was never available as a check — see `tailwind.config.js`.",
    "BEFORE (SCRUM-485, the defect): bar 31.875 with logo 31.875 at top 0; avatar-trigger 56 at top -12.0625 with `overlaps content-row` 0.215 and 3 of 9 footprint points skipped; nav-button 60 at top -14.0625, being `rounded-xl p-4 text-xl` = 16 + 28 + 16.",
    "BEFORE, and this is the mechanism the fix had to respect: the two differed in whether the overlap was clickable, for a flex-item reason rather than a z-index one. At y 38 elementFromPoint returned the avatar's own span but the row's background div for the tab. `DropDownMenu`'s wrapper carries a z-index and is a flex item, and a flex item's z-index creates a stacking context even at `position: static`; the tab group's wrapper has none, so the positioned row painted and hit-tested above it.",
    "BEFORE, at 1440x900: bar 76.5, both fit with room to spare, overflow 0 — so this degraded continuously as the window shortened and was only worth acting on at the bottom of the range. SCRUM-477's Closeout recorded the same shape for the logo, which overflowed by 17.25px each way even at 1440x900; this was the milder version of that.",
  ],
  reproduces: [
    {
      file: "src/components/DropDownMenu.tsx",
      className: HEADER_AVATAR_TRIGGER_CLASS,
    },
    {
      file: "src/components/Header.tsx",
      className: HEADER_NAV_BUTTON_CLASS,
    },
    {
      file: "src/components/Header.tsx",
      className: "underline underline-offset-8 ${HEADER_NAV_BUTTON_CLASS}",
    },
    {
      file: "src/components/Header.tsx",
      className: "height: ${HEADER_BAR_HEIGHT};",
    },
    {
      file: "src/components/Header.tsx",
      className: "min-height: ${HEADER_BAR_MIN_HEIGHT};",
    },
    { file: "src/pages/admin.tsx", className: CONTENT_ROW_CLASS },
  ],
};

/**
 * The compact values are the base and `message-panel-tall:` restores the
 * full-size ones, so this one string carries both sides of SCRUM-489's fix and
 * the fixture measures whichever the viewport selects. Serve it at 667x375 for
 * the compact chrome and at 1440x900 for the full-size one.
 */
const MESSAGE_HEADER_DESKTOP_CLASS =
  "message-panel-tall:p-8 flex items-center justify-between border-b border-gray-200 bg-white px-2 py-1";

/**
 * The avatar, which is guarded now that its size is load-bearing rather than
 * decorative: 80px was the single largest block in a 145px header, and 56px is
 * the largest box that costs nothing, because the close control beside the name
 * is already `h-14`.
 */
const MESSAGE_HEADER_AVATAR_CLASS =
  "message-panel-tall:h-20 message-panel-tall:w-20 h-14 w-14 rounded-full";

const MESSAGE_CONTENT_CLASS =
  "flex h-full flex-1 flex-col overflow-x-hidden overflow-y-auto bg-white p-4";

/**
 * The date separator every group carries, and one message block, copied from
 * `MessageContent` so the conversation the fixture measures has the height a
 * real one does. The stand-in was a single `<p>`, which made
 * `message-content`'s `scrollHeight` an arbitrary number rather than the
 * height of something a user has to be able to read.
 */
const MESSAGE_DATE_SEPARATOR_CLASS = "my-2 text-center text-sm text-gray-500";

/*
  Two constants and not one, because the component composes the block's class
  from a template - the shared part and then a ternary on who sent the message.
  A single joined string would be a class string that exists only here, and the
  drift guard asserts these appear in the source *literally*, so it would fail
  rather than guard anything.
*/
const MESSAGE_BLOCK_CLASS = "mb-4 flex flex-col";

const MESSAGE_BLOCK_INCOMING_CLASS = "desktop:pl-10 items-start pl-4";

const MESSAGE_TIMESTAMP_CLASS = "mb-1 text-xs text-gray-500";

/**
 * The bubble's own width cap, which is a height term at a narrow panel: it does
 * not widen, it wraps. `message-panel-tall:` for the same reason the header's
 * padding is.
 */
const MESSAGE_BUBBLE_CLASS =
  "message-panel-tall:max-w-[50%] max-w-[85%] rounded-lg px-4 py-2 text-base break-words whitespace-pre-line lg:text-xl";

/**
 * Both of the bar's insets, on two different screens, which is why this fixture
 * is the only place the pair can be told apart: the horizontal one restores the
 * desktop figure above the panel's height threshold and the vertical one is cut
 * below it, so a landscape phone is the one viewport that takes the base of the
 * first and the override of the second. Serve at 667x375 for that, 375x667 for
 * the mobile base and 1440x900 for the full-size chrome.
 */
const SEND_BAR_CLASS =
  "message-panel-tall:px-6 message-panel-short:py-3 border-t border-gray-200 px-4 py-6";

const SEND_BAR_ROW_CLASS =
  "message-panel-tall:mx-10 mx-0 flex items-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100";

/**
 * The composer is a `contentEditable` div, not a `textarea`, and its height
 * comes from the inline `minHeight: 20px` rather than from any utility - so a
 * fixture that stands it in with a line of `text-lg` text measures 72px where
 * the real control measures 36. The first draft of this fixture did exactly
 * that and reported the send bar overflowing the viewport by 34px, which is an
 * artefact of the stand-in and not a fact about the app. The inline style is
 * reproduced on the element below for that reason.
 */
const SEND_BAR_COMPOSER_CLASS =
  "placeholder w-full flex-1 resize-none border-0 bg-gray-100 p-2 text-lg focus:outline-hidden";

const SEND_BAR_BUTTON_CLASS = "p-2 px-4 pt-3";

const messagePanelChrome: LayoutFixture = {
  name: "message-panel-chrome",
  summary:
    "The desktop message panel's header, tab strip and send bar inside the content row, and what is left for the conversation",
  source: "src/components/Messages/MessageHeader.tsx:450",
  issue: "SCRUM-489",
  viewportWidth: 667,
  viewportHeight: 375,
  /*
    `px-2` and not `p-8`: the chain is stated for the viewport the fixture
    records, and at 375px tall the header takes the compact padding SCRUM-489
    added. Serving this fixture at 1440x900 therefore prints a prediction that
    is 48px short of what it measures, which is the harness working as
    intended - the banner says the height is not the recorded one.
  */
  insets: [
    { name: "sidebar w-[25rem]", x: 400 },
    { name: "header px-2", x: 16 },
  ],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }
      }
    </style>
    <div data-probe="bar"></div>
    <div class="${CONTENT_ROW_CLASS}" data-probe="content-row">
      <div class="relative w-[25rem] bg-stone-100"></div>
      <div class="relative flex-auto">
        <div class="absolute inset-0 z-10 h-full w-full" data-probe="panel-slot">
          <div class="flex h-full w-full flex-col">
            <div>
              <div class="${MESSAGE_HEADER_DESKTOP_CLASS}" data-probe="message-header">
                <div class="flex items-center">
                  <span class="${MESSAGE_HEADER_AVATAR_CLASS} bg-gray-200" data-probe="avatar"></span>
                  <span class="font-montserrat pr-10 pl-10 font-semibold sm:text-lg md:text-xl lg:text-2xl">Alex</span>
                </div>
                <div class="relative flex items-center justify-between">
                  <button class="h-14 w-14 cursor-pointer items-center justify-center text-3xl text-black" data-probe="close-button">&times;</button>
                </div>
              </div>
              <div class="flex border-b border-gray-200 bg-white" data-probe="tab-strip">
                <button class="flex-1 py-3 text-center text-lg font-medium">Message</button>
                <button class="flex-1 py-3 text-center text-lg font-medium">Map</button>
              </div>
            </div>
            <div class="flex h-0 flex-1 flex-col bg-white" data-probe="content-area">
              <div class="${MESSAGE_CONTENT_CLASS}" data-probe="message-content">
                <div data-probe="date-group">
                  <div class="${MESSAGE_DATE_SEPARATOR_CLASS}" data-probe="date-separator">Tuesday, September 15, 2026</div>
                  <div class="${MESSAGE_BLOCK_CLASS} ${MESSAGE_BLOCK_INCOMING_CLASS}" data-probe="message-block">
                    <span class="${MESSAGE_TIMESTAMP_CLASS}">3:04 PM</span>
                    <div class="${MESSAGE_BUBBLE_CLASS} bg-gray-200 text-black" data-probe="bubble">Sounds good, see you at 8.</div>
                  </div>
                </div>
              </div>
              <div class="${SEND_BAR_CLASS}" data-probe="send-bar">
                <div class="${SEND_BAR_ROW_CLASS}" data-probe="composer-row">
                  <div
                    class="${SEND_BAR_COMPOSER_CLASS}"
                    data-probe="composer"
                    style="min-height: 20px; max-height: 100px; line-height: normal; display: inline-block; white-space: pre-wrap; overflow-y: auto; overflow-wrap: break-word;"
                  ></div>
                  <div class="h-10 w-px bg-gray-300"></div>
                  <button class="${SEND_BAR_BUTTON_CLASS}" data-probe="send-button">
                    <span class="block bg-gray-500" style="${standIn(26, 26)}"></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='message-header']",
  probe: {
    boxes: [
      "[data-probe='content-row']",
      "[data-probe='panel-slot']",
      "[data-probe='message-header']",
      "[data-probe='avatar']",
      "[data-probe='tab-strip']",
      "[data-probe='content-area']",
      "[data-probe='message-content']",
      "[data-probe='date-group']",
      "[data-probe='date-separator']",
      "[data-probe='message-block']",
      "[data-probe='bubble']",
      "[data-probe='send-bar']",
      "[data-probe='composer-row']",
      "[data-probe='composer']",
      "[data-probe='send-button']",
    ],
    footprint: "[data-probe='send-button']",
    against: ["[data-probe='content-row']"],
  },
  recorded: [
    "AFTER SCRUM-496, which put a 44px floor under the header bar and so took 12.125px off this row at a landscape phone. Re-measured at 667x375 on top of SCRUM-494: row 331 where it was 343.125, content-area 213 where it was 225.13, and the conversation port's content height **108 where SCRUM-494 left 120**. **Every criterion those two tickets set still holds** - `content-area` overflow is 0, the send bar's bottom is exactly 375.00, and scrolling the port to the bottom leaves the newest 64px bubble wholly inside it. SCRUM-494 more than paid for this: the same figure was 83 before it and would have been 71 had this ticket landed first.",
    "SCRUM-496, THE RE-DERIVED GATE, and this is the figure that moved. `MESSAGE_PANEL_MIN_HEIGHT_PX` went 489 to 491, because this threshold sits inside the floor's band and its row is now `H - 44` rather than `0.915 x H`. SCRUM-494 does not move it again - the five numerator terms still sum to 447, since 97 is the send bar's full-size figure and that ticket changed the compact one. Measured at 800x491: the full-size chrome applies, the row is **exactly 447** and the port's content height **exactly 120**, which is `MESSAGE_PANEL_DATED_MESSAGE_PX` - so the inequality is as tight at the new gate as SCRUM-489 found it at the old one. At 800x490 the compact chrome takes over, header 65 and row 446. The boundary is a boundary.",
    "AFTER SCRUM-494, which finished the send bar off; the header and bubble figures are still SCRUM-489's and were re-measured unchanged. The `BEFORE` lines are kept because this fixture's whole purpose is the comparison, and because two of them are the reason the threshold is where it is. Where a line carries two of them, `BEFORE 489` is the original defect and `BEFORE 494` is what SCRUM-489 left behind. **Every row figure from here down predates SCRUM-496's floor** and describes a 343.125px row at 667x375; read them as those tickets', not as current.",
    "message-header rect height 65 — `px-2 py-1` around an `h-14` avatar, plus the `border-b`. BEFORE: 145, from `p-8` around `h-20`. The height is set by the close control rather than the avatar below 56px, which is why the avatar stops at `h-14` and the padding does the rest.",
    "The chrome was the finding, not the header alone: header 65 + tab-strip 53 = 118 of a 343.125px row, leaving content-area 225.13. BEFORE: 198 of chrome and 145.13 of content-area.",
    "message-content rect height 152.13, clientHeight 152, `padding: 16px` — **contentHeight 120**. BEFORE 494: rect 115.13 and contentHeight 83. BEFORE 489: rect 32, clientHeight 32, **contentHeight 0** with a scrollHeight of 220 behind it. That is the defect it started as: the conversation was not cramped at 667x375, it was invisible.",
    "The newest message is readable, which is the criterion and not a proxy for it. Scroll the port to the bottom the way `MessageContent` does and the bubble is 64px tall with **all 64 inside the port**, and **32.13px of slack** under it. BEFORE 494: the same bubble was whole with 3px to spare, which met the criterion and left nothing over — 83 of content height against a 64px bubble plus the block's 16px `mb-4`. The 37px the bar gave back is what turned meeting the criterion into clearing it.",
    "send-bar rect height **73**, `padding: 12px 16px`, bottom at **375.00** against a viewport of 375 — nothing past the edge. BEFORE 494: 110, with `padding: 24px` on all four sides. BEFORE 489: 131.5 with its bottom at 393.38, so the last 18.38px sat under the screen with `#__next` at `100dvh` and no page scroll to reach it. Of the 37px between 110 and 73, 24 is the vertical padding the short screen cuts and 13 is the composer row no longer holding a wrapped hint.",
    "content-area scrollHeight equals its clientHeight — **overflow 0**. BEFORE: 179 against 145, the same 34px of overflow seen from the other side. The mechanism was that content-area is `flex h-0 flex-1 flex-col`, and a flex item will not shrink below its min-content height, so the 131.5px send bar took the space and message-content was left with its own padding.",
    "The bubble is 153x64. BEFORE: 90x112 — the half-column width cap, then applied on width alone, held it to 110px of a 220px column, so a 26-character message wrapped to four lines. The cap is a readability rule at a wide panel and a height multiplier at a narrow one, which is why it moved to the same screen as the rest of the chrome. (Both caps are named here as widths rather than as their utilities: this file is scanned, and a selector-set diff caught the `BEFORE` half of this very line keeping the retired rule alive in the shipped bundle.)",
    "The composer is **174x37.5 — one line** of `globals.css`'s `.placeholder:empty:before` hint. BEFORE 494: 158x59 and two lines. BEFORE 489: 78x80.5 and three. **The figure that settled it: the hint is 144.77px of text in this font and wants a 160.77px composer, so at 158 it was 2.77px short of one line.** SCRUM-489 estimated 200px and concluded no inset could find it in a 267px panel, which is why it left the wrap in place; measuring the string is what showed the container's own 8px a side was already enough. Anything read off this line is font-dependent and this harness serves no webfont — the trap `profile-content-column-width` records — but here the fallback is faithful rather than optimistic: the composer inherits no `font-family`, from Tailwind's preflight or from anything in `globals.css`, so the app renders that hint in the same system sans this page does. Checked on the element rather than reasoned about.",
    "send-button rect 58x46, fully inside the composer row and reachable — unchanged, and it was never the problem. An earlier draft of this fixture reported it clipped; that was the stand-in composer's fault, see SEND_BAR_COMPOSER_CLASS.",
    "message-header contentWidth 251, matching the predicted chain — 667 less the 400px sidebar less its own `px-2`. Note the chain is stated for *this* viewport, so serving the fixture at a tall one prints a prediction 48px short of what it measures.",
    "DESKTOP CONTROL at 1440x900, re-measured on SCRUM-494 and unchanged in every term: header 145 with `padding: 32px`, avatar 80, tab-strip 53, content-area 625.5, message-content contentHeight **497**, send-bar **97** with `padding: 24px` on all four sides and nothing past the viewport, composer 851x37.5 on one line, composer row margin `0px 40px`, bubble max-width `50%` at 44px tall. This is what `message-panel-tall:` is protecting, and the send bar is the term to watch: 97 is the figure `MESSAGE_PANEL_MIN_HEIGHT_PX` is derived from, so a vertical inset that leaked out of the short screen would move the threshold that selects it.",
    "THE BOUNDARY, both sides of it, at 667 wide: 489 gives the full-size chrome — header 145, send-bar 131.5 with `padding: 24px`, margin `0px 40px`, cap `50%`, contentHeight 86 — and 488 gives the compact one — header 65, send-bar 73 with `padding: 12px 16px`, margin `0px`, cap `85%`, contentHeight 224. Neither overflows. The two screens are exact complements, so this pair is also the whole of the evidence that no viewport falls between them: 489 matches the tall screen and not the short one, 488 the reverse.",
    "PORTRAIT CONTROL at 375x667, which is the viewport SCRUM-494 had to leave alone. **The surrounding layout here is not representative — this fixture hard-codes the 400px desktop sidebar, so the panel is crushed and every conversation figure at this width is an artefact.** What is measurable, and is the entire claim, is which queries the bar's own insets resolve through: neither screen matches, because both carry a 640px minimum width, and the bar keeps the base `padding: 24px 16px` it had before this ticket. A phone in portrait is unchanged by construction rather than by inspection.",
    "THE DERIVATION, checked where it was derived: at 1440x489 the conversation measures exactly 120px of content height against a dated message of exactly 120. `MESSAGE_PANEL_MIN_HEIGHT_PX` is tight at the threshold rather than approximately right, and the 86 above is the same threshold seen at a panel too narrow for a one-line composer.",
    "WEBFONT CONTROL, which this fixture needs because two of its figures are about wrapped text. `buildFixturePage` serves no font link, and the app gets Lato and Montserrat from `_document.tsx` - so a text measurement here can resolve in the narrower system fallback and report that something fits when it does not. It does not happen to bite here, and that was checked rather than assumed: the bubble and the composer carry no font utility and nothing sets one on `body`, so both resolve to Tailwind's preflight sans in the app exactly as they do here. Injecting both links and awaiting `document.fonts.ready` - with `document.fonts.check` confirming each arrived - re-measured every figure above identically, bubble 153x64 and composer 59 included. The header's name span is the one Montserrat element, and the header's height is set by the 56px close control, so the name would have to wrap to three lines to reach it.",
    "BEFORE, retained from SCRUM-485: contentHeight reached 0 at about 395px of viewport height, with 5px measured at 667x400. Below ~395 the send bar also left the screen. That band is landscape phones and nothing else, which is what kept this item's blast radius honest.",
  ],
  reproduces: [
    {
      file: "src/components/Messages/MessageHeader.tsx",
      className: MESSAGE_HEADER_DESKTOP_CLASS,
    },
    {
      file: "src/components/Messages/MessageHeader.tsx",
      className: MESSAGE_HEADER_AVATAR_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_CONTENT_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_DATE_SEPARATOR_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_BLOCK_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_BLOCK_INCOMING_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_TIMESTAMP_CLASS,
    },
    {
      file: "src/components/Messages/MessageContent.tsx",
      className: MESSAGE_BUBBLE_CLASS,
    },
    {
      file: "src/components/Messages/SendBar.tsx",
      className: SEND_BAR_CLASS,
    },
    {
      file: "src/components/Messages/SendBar.tsx",
      className: SEND_BAR_ROW_CLASS,
    },
    {
      file: "src/components/Messages/SendBar.tsx",
      className: SEND_BAR_COMPOSER_CLASS,
    },
    {
      file: "src/components/Messages/SendBar.tsx",
      className: SEND_BAR_BUTTON_CLASS,
    },
    { file: "src/pages/admin.tsx", className: CONTENT_ROW_CLASS },
  ],
};

const RECENTRE_DESKTOP_CLASS =
  "absolute right-[8px] bottom-[150px] z-10 flex h-8 w-8 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200";

const MAP_LEGEND_DESKTOP_CLASS =
  "text-base absolute bottom-8 left-2 z-10 flex flex-col rounded-xl border border-gray-200 bg-white p-2 md:text-lg";

const MAP_CONTAINER_CLASS =
  "pointer-events-auto relative z-0 h-full w-full flex-auto";

const mapOverlayAnchors: LayoutFixture = {
  name: "map-overlay-anchors",
  summary:
    "The desktop recentre button and the always-expanded legend against a map that is only the content row's share of a landscape phone",
  source: "src/components/Map/RecentreButton.tsx:53",
  issue: "SCRUM-485",
  viewportWidth: 667,
  viewportHeight: 375,
  insets: [{ name: "sidebar w-[25rem]", x: 400 }],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }
      }
    </style>
    <div data-probe="bar"></div>
    <div class="${CONTENT_ROW_CLASS}" data-probe="content-row">
      <div class="relative w-[25rem] bg-stone-100"></div>
      <div class="relative flex-auto">
        <div class="${MAP_CONTAINER_CLASS}" data-probe="map">
          <div class="${MAP_LEGEND_DESKTOP_CLASS}" data-probe="legend">
            <div class="my-1 flex flex-row items-center">
              <span class="block bg-gray-300" style="${standIn(32, 42)}"></span>
              <p class="mx-2">My Destination</p>
            </div>
            <div class="my-1 flex flex-row items-center">
              <span class="block bg-gray-300" style="${standIn(32, 42)}"></span>
              <p class="mx-2">Driver Destination</p>
            </div>
            <div class="my-1 flex flex-row items-center">
              <span class="block bg-gray-300" style="${standIn(32, 42)}"></span>
              <p class="mx-2">Rider Destination</p>
            </div>
          </div>
          <button class="${RECENTRE_DESKTOP_CLASS}" data-probe="recentre"></button>
          <div
            class="absolute bg-gray-200"
            style="right:10px;bottom:10px;${standIn(29, 87)}"
            data-probe="mapbox-nav"
          ></div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='map']",
  probe: {
    boxes: [
      "[data-probe='content-row']",
      "[data-probe='map']",
      "[data-probe='legend']",
      "[data-probe='recentre']",
      "[data-probe='mapbox-nav']",
    ],
    footprint: "[data-probe='recentre']",
    against: ["[data-probe='legend']", "[data-probe='mapbox-nav']"],
  },
  recorded: [
    "The map is 267x343.13 at 667x375 — the `w-[25rem]` sidebar takes 400 of the 667px width, so the map is 40% of the screen. Both items below are about overlays on that box.",
    'legend rect 195.69x168, top 143.13 within the map: 48.96% of its height and 73% of its width, so roughly a third of the map\'s area. SCRUM-477 said "roughly 45%" of the height and was close.',
    "recentre rect 32x32, top 161.13 within the map — its centre is 51.62% of the way down, which is the item as described: `bottom-[150px]` lands it mid-map.",
    "Both are nonetheless cosmetic, and the hit test is why. recentre is reachable and unobstructed, and `overlaps` against both the legend and Mapbox's own control is 0 — the 150px offset still clears the `bottom-right` NavigationControl by 53px at this height, because the offset and the control it avoids are measured from the same edge.",
    "So nothing here is unreachable, nothing is covered and nothing is off-screen. The map items are the clearest case in phase 4 for leaving the layout alone: the cost is an ugly anchor, and the risk of re-anchoring is a desktop regression on the platform where these controls work today.",
    "map contentWidth 267, matching the predicted chain.",
    "mapbox-nav is a stand-in for a control Mapbox draws itself, at the size and `bottom-right` offset `addMapEvents.tsx` asks for. It measures the clearance, not Mapbox's markup.",
  ],
  reproduces: [
    {
      file: "src/components/Map/RecentreButton.tsx",
      className: RECENTRE_DESKTOP_CLASS,
    },
    {
      file: "src/components/Map/MapLegend.tsx",
      className: MAP_LEGEND_DESKTOP_CLASS,
    },
    { file: "src/pages/index.tsx", className: MAP_CONTAINER_CLASS },
    { file: "src/pages/admin.tsx", className: CONTENT_ROW_CLASS },
  ],
};

const COMPLIANCE_CENTRING_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center p-4";

const COMPLIANCE_PANEL_CLASS =
  "flex h-4/6 w-5/6 flex-col content-center justify-center gap-4 rounded-md bg-white p-9 shadow-md sm:h-4/6 sm:w-4/6 md:h-3/6 md:w-3/6";

const GROUP_PANEL_CLASS =
  "flex h-4/6 w-4/6 flex-col content-center justify-start gap-1 overflow-y-auto rounded-md bg-white py-9 shadow-lg";

const UNSAVED_MODAL_PANEL_CLASS =
  "relative flex w-1/3 min-w-[min(22rem,100%)] flex-col justify-center rounded-lg bg-white px-6 py-16 text-center shadow-lg";

const centredDialogPanels: LayoutFixture = {
  name: "centred-dialog-panels",
  summary:
    "The three centred panels SCRUM-485 inherited, and whether a percentage-height panel can overflow the box centring it",
  source: "src/components/CompliancePortal.tsx:55",
  issue: "SCRUM-485",
  viewportWidth: 667,
  viewportHeight: 375,
  insets: [{ name: "centring container p-4", x: 32 }],
  markup: `
    <div class="${COMPLIANCE_CENTRING_CLASS}" data-probe="compliance-centring">
      <div class="${COMPLIANCE_PANEL_CLASS}" data-probe="compliance-panel">
        <h2 class="text-center text-2xl font-bold" data-probe="compliance-title">Carpool Terms and Conditions</h2>
        <div class="scroll overflow-y-auto" data-probe="compliance-scroll">
          <p>This application and any related transportation arrangements and services are provided on an AS IS basis and without any warranty or condition, express, implied or statutory. User agrees and acknowledges that they assume full, exclusive and sole responsibility for the use of and reliance on any services through this application.</p>
        </div>
        <button class="bg-northeastern-red rounded px-4 py-2 font-bold text-white" data-probe="compliance-agree">I Agree</button>
      </div>
    </div>
    <div class="fixed inset-0 flex items-center justify-center p-4" data-probe="group-centring">
      <div class="${GROUP_PANEL_CLASS}" data-probe="group-panel">
        <h2 class="text-center text-3xl font-bold">My Group</h2>
        <p class="px-9">Group details, the route preview and the destructive controls all live in here.</p>
      </div>
    </div>
    <div class="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-probe="unsaved-centring">
      <div class="${UNSAVED_MODAL_PANEL_CLASS}" data-probe="unsaved-panel">
        <h3 class="mb-6 text-xl font-semibold lg:text-2xl">You have unsaved changes!</h3>
        <p class="my-4 text-gray-700">Continue with or without saving?</p>
        <div class="flex justify-center space-x-4" data-probe="unsaved-buttons">
          <button class="rounded bg-gray-400 px-4 py-2 font-bold text-white" data-probe="unsaved-continue">Continue</button>
          <button class="bg-northeastern-red rounded px-4 py-2 font-bold text-white" data-probe="unsaved-save">Save and Continue</button>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='compliance-centring']",
  probe: {
    boxes: [
      "[data-probe='compliance-centring']",
      "[data-probe='compliance-panel']",
      "[data-probe='compliance-scroll']",
      "[data-probe='compliance-agree']",
      "[data-probe='group-panel']",
      "[data-probe='unsaved-panel']",
      "[data-probe='unsaved-buttons']",
      "[data-probe='unsaved-save']",
    ],
    footprint: "[data-probe='unsaved-save']",
    against: ["[data-probe='unsaved-panel']"],
  },
  recorded: [
    "compliance-panel and group-panel both measure 423.33x228.66 at top 73.16, bottom 301.83 — **fully inside the viewport**, and that is this fixture's main result.",
    "It falsifies a specific claim: SCRUM-485's opening comment listed all three of these as centred boxes needing `justify-center-safe` alongside a cap. Two of them cannot overflow at all. `h-4/6` is a percentage of the centring container, so the panel is always two thirds of the space available and there is no overflow for safe alignment to rescue. The pairing SCRUM-482 measured is real; it does not apply here.",
    "compliance-scroll clientHeight 53 against scrollHeight 192, and compliance-agree fully inside the viewport. So the terms are readable 53px at a time and the only control is reachable: cramped exactly as the ticket describes, with nothing lost.",
    "**The three unsaved-* figures below are SCRUM-492's, taken after it fixed this panel.** SCRUM-485 measured it overflowing — rect height 376 at top -0.5, bottom 375.5 against a viewport of 375, half a pixel each way and growing on any shorter viewport. It now measures 352x276 at top 49.5, bottom 325.5: fully inside, with 49.5px of clearance top and bottom.",
    "unsaved-buttons is 40px tall with contentWidth 304, so neither label wraps. SCRUM-485 had it at 88px in a 174px box.",
    "unsaved-save is 176.02x40, fully inside the viewport. It was 101.32x88 — the same button, squeezed to 101px and wrapping its label over three lines.",
    "The mechanism was never the one SCRUM-477 recorded. The survey blamed `py-16` and put the clipping threshold at ~280px; the padding is 128px and the panel was 376px, so something else supplied the other 248. It was the width: `w-1/3` is 222.33px at this viewport, and the panel now carries a floor of `min-w-[min(22rem,100%)]` — 352px, which is the button row's natural single-line width plus the panel's own `px-6`.",
    "**And the floor is not the arithmetic SCRUM-492's description gives**, which is the one figure here most likely to be re-derived wrongly. That ticket took the wrapped row's scrollWidth of 196, added the 48px of `px-6`, and proposed 244. scrollWidth is the overflow of a row that has *already* wrapped, not the width it needs in order not to; the row's natural single-line width is 293.34 (Continue 101.32 + gap 16 + Save and Continue 176.02), so a 244px panel still wraps both labels. 293.34 + 48 is where 352 comes from.",
    "The `min()` in that floor is load-bearing and was also measured. An unconditional 22rem floor puts the panel 16px past each edge of a 320px-wide viewport, symmetrically and so unreachably, and a minimum width beats a maximum one in CSS — a cap alongside it is inert. Capped inside the floor, the panel measures exactly 320 wide at that viewport and 352 from 375 upwards.",
    "This panel was the one centred box in this fixture that genuinely overflowed, and the fix means it no longer does at any viewport at or above 276px tall — so the `justify-center-safe` pairing SCRUM-477's Closeout describes is, in the end, not needed here either. Three for three: nothing in this fixture needs it.",
    "compliance-centring contentWidth 635, matching the predicted chain: 667 less its own `p-4`.",
  ],
  reproduces: [
    {
      file: "src/components/CompliancePortal.tsx",
      className: COMPLIANCE_CENTRING_CLASS,
    },
    {
      file: "src/components/CompliancePortal.tsx",
      className: COMPLIANCE_PANEL_CLASS,
    },
    {
      file: "src/components/Group/GroupPage.tsx",
      className: GROUP_PANEL_CLASS,
    },
    {
      file: "src/components/Profile/UnsavedModal.tsx",
      className: UNSAVED_MODAL_PANEL_CLASS,
    },
  ],
};

/**
 * The explore page's mobile content row, after SCRUM-503 removed the
 * "use desktop instead" banner it used to be pushed down by.
 *
 * `h-mobile-row` used to be `calc(100% - 1.5rem - MOBILE_NAV_SPACE)`, and the
 * row carried a matching `mt-6`. Both are gone: the token is now
 * `calc(100% - MOBILE_NAV_SPACE)` and the row has no top margin. This fixture
 * is what SCRUM-503's acceptance criterion asks for directly - the row starts
 * at y=0 and its height is the viewport less `MOBILE_NAV_SPACE` - measured
 * rather than read off the class names, per that ticket's own note that a
 * class no longer appearing in the output is not a valid check (SCRUM-419).
 *
 * The wrapper (`m-0 h-full w-full`) is included because the row's `100%` in
 * `h-mobile-row` resolves against *its* height, not `#__next`'s directly - so
 * a fixture measuring the row alone, without reproducing that ancestor, would
 * not actually test the chain the token depends on.
 */
const mobileContentRowHeight: LayoutFixture = {
  name: "mobile-content-row-height",
  summary:
    "The explore page's mobile content row, now that the desktop-nudge banner is gone",
  source: "src/pages/index.tsx:1053",
  issue: "SCRUM-503",
  viewportWidth: 375,
  viewportHeight: 667,
  insets: [],
  markup: `
    <div class="m-0 h-full w-full">
      <div class="flex overflow-hidden h-mobile-row" data-probe="content-row">
        <div class="h-full w-full bg-stone-100"></div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='content-row']",
  probe: {
    boxes: ["[data-probe='content-row']"],
  },
  recorded: [
    "Measured in Chromium at 375x667: content-row rect top 0, height 607, contentWidth 375 (matching the predicted chain, since insets is empty). 607 is the viewport's 667 less MOBILE_NAV_SPACE's 60px, with no banner allowance and no top margin left to account for. env(safe-area-inset-bottom) resolves to its 0px fallback in this headless browser, so MOBILE_NAV_SPACE is exactly 60px here.",
    "SCRUM-503's own ticket evidence measured the pre-removal chain at this same viewport: banner occupying y 0→24 and the row starting at y 24. This fixture's top 0 is the criterion that comparison was checking for.",
  ],
  reproduces: [
    { file: "src/pages/index.tsx", className: "m-0 h-full w-full" },
    { file: "src/pages/index.tsx", className: "h-mobile-row" },
    {
      file: "tailwind.config.js",
      className: "calc(100% - ${MOBILE_NAV_SPACE})",
    },
  ],
};

/**
 * SCRUM-528's fixture: how much of the explore map the mobile explore sheet
 * covers, expanded versus collapsed - the two detents the mobile tour's
 * second and third steps meet.
 *
 * The ticket's own arithmetic (519 of the map row's 607px, 85.5%) was CSS
 * arithmetic rather than a rect measurement, and its evidence says so
 * directly: "the exact rect driver.js computes for a zero-height element...
 * was not measured." This is that measurement.
 *
 * Reuses `mobile-content-row-height`'s wrapper and row, and adds the sheet as
 * two siblings of it rather than one toggled element, so a single page load
 * measures both detents at once - the two the fix forces the sheet through
 * (`WelcomeTutorial.tsx`'s `MOBILE_STEP_DETENTS`). Both are `absolute` with no
 * positioned ancestor between them and `#__next`, exactly as `sidebarRef`'s
 * div is in `pages/index.tsx` - see `expandedSheetHeightPx`'s docblock in
 * `sheetDetents.ts` for why that is load-bearing: an ancestor with its own
 * `position` would change what `bottom-mobile-nav` and `h-mobile-sheet`
 * resolve against.
 */
/**
 * The two literal fragments below are separate rather than one concatenated
 * string because that is how they actually sit in `pages/index.tsx`: an
 * interpolated conditional (`overscroll-y-contain`) sits between them, so a
 * single joined string would never match the drift guard's `toContain` -
 * the fixture would silently stop proving anything the moment it drifted,
 * which is exactly the failure mode `reproduces` exists to catch.
 */
const MOBILE_SHEET_BASE_CLASS =
  "absolute left-0 z-20 w-full overflow-y-auto rounded-t-3xl border-2 border-black bg-white shadow-lg";
const MOBILE_SHEET_TRANSITION_CLASS = "transition-all duration-300";

const mobileTourMapStepSheetOverlap: LayoutFixture = {
  name: "mobile-tour-map-step-sheet-overlap",
  summary:
    'How much of the mobile explore map the explore sheet covers, expanded vs. collapsed - the "This is the map" tour step',
  source: "src/pages/index.tsx:1107",
  issue: "SCRUM-528",
  viewportWidth: 375,
  viewportHeight: 667,
  insets: [],
  markup: `
    <div class="m-0 h-full w-full">
      <div class="flex overflow-hidden h-mobile-row" data-probe="content-row">
        <div class="h-full w-full bg-stone-100"></div>
      </div>
      <div class="${MOBILE_SHEET_BASE_CLASS} ${MOBILE_SHEET_TRANSITION_CLASS} bottom-mobile-nav h-mobile-sheet" data-probe="sheet-expanded"></div>
      <div class="${MOBILE_SHEET_BASE_CLASS} ${MOBILE_SHEET_TRANSITION_CLASS} bottom-mobile-nav pointer-events-none h-0 opacity-0" data-probe="sheet-collapsed"></div>
    </div>
  `,
  widthProbe: "[data-probe='content-row']",
  probe: {
    boxes: [
      "[data-probe='content-row']",
      "[data-probe='sheet-expanded']",
      "[data-probe='sheet-collapsed']",
    ],
    footprint: "[data-probe='content-row']",
    against: [
      "[data-probe='sheet-expanded']",
      "[data-probe='sheet-collapsed']",
    ],
  },
  recorded: [
    'Measured in Chromium at 375x667: content-row rect top 0, height 607 (same as mobile-content-row-height). sheet-expanded rect top 88, height 519 - the overlap fraction against content-row is 0.8550, matching the ticket\'s hand arithmetic of 519/607 = 85.5% almost exactly. sheet-collapsed rect height 4, not 0: `border-2` puts a 2px border on each edge even at `h-0`, since `clientHeight` (which is 0) excludes the border but `getBoundingClientRect()` does not. The overlap fraction against that 4px strip is 0.0066 (0.66%) - a residual sliver `h-0` cannot remove, negligible against the 85.50% it replaces, and the reason this fixture reports a measured rect rather than asserting the idealised "exactly 0" the class names alone would suggest.',
    "This is the rect measurement the ticket's evidence explicitly says was missing: the CSS-token arithmetic predicted 85.5% but was not checked against what driver.js's overlay cutout - and this fixture's overlapFraction - actually computes from the live boxes. It also caught something the arithmetic could not: the 4px border residue above.",
  ],
  reproduces: [
    { file: "src/pages/index.tsx", className: MOBILE_SHEET_BASE_CLASS },
    { file: "src/pages/index.tsx", className: MOBILE_SHEET_TRANSITION_CLASS },
    {
      file: "src/pages/index.tsx",
      className: "bottom-mobile-nav h-mobile-sheet",
    },
    {
      file: "src/pages/index.tsx",
      className: "bottom-mobile-nav pointer-events-none h-0 opacity-0",
    },
  ],
};

/*
 * SCRUM-502's fixture: `MobileNav` and `MobileNavItem`, `Header.tsx:115` and
 * `:168`. Both are styled-components, so - as SCRUM-484's comment above
 * explains for the desktop header - the markup carries its own `<style>` and
 * the drift guard reads `Header.tsx` for the declaration text rather than a
 * compiled class string.
 *
 * **One fixture covers both insets the criteria ask for, because the inset is
 * not something the fixture's CSS can vary at all.** The first draft here
 * tried to fake a 34px inset by giving `env(safe-area-inset-bottom)` a 34px
 * fallback, reasoning that a browser with no notch leaves the variable
 * undefined. Measured and wrong: Chromium defines it as an actual `0px`,
 * fallback or no, so `env(x, 34px)` resolved to `0px` there exactly as it does
 * with the real `0px` fallback `MobileNav` declares - the two fixtures were
 * reporting the same number under different names. The only way to make
 * Chromium report a nonzero inset is to tell it to, with the CDP call this
 * measures: `session.send("Emulation.setSafeAreaInsetsOverride", { insets: {
 * bottom: 34, bottomMax: 34 } })`, which `scripts/measure-layout.ts` does not
 * issue - it is a manual step, taken once per inset, against the one fixture
 * below. `recorded` carries both results.
 */
const MOBILE_NAV_CSS = `
  position: fixed;
  bottom: 0;
  left: 0;
  width: 100%;
  height: ${MOBILE_NAV_SPACE};
  display: flex;
  justify-content: space-around;
  align-items: center;
  background-color: #e6e6e6;
  padding-top: 0;
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  box-shadow: 0px -2px 6px rgba(0, 0, 0, 0.15);
  z-index: 100;
  border-top: 1px solid #d1d1d1;
`;

/**
 * `MobileNavItem`'s shared declarations, `border-bottom` excluded - that one
 * line is the whole active/inactive difference, and the fixture states it
 * with two ordinary attribute selectors below rather than trying to
 * reconstruct styled-components' prop interpolation in static HTML. The
 * `reproduces` entry for it copies the real conditional text separately.
 */
const MOBILE_NAV_ITEM_CSS = `
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
  cursor: pointer;
`;

/**
 * The literal source of `MobileNavItem`'s conditional `border-bottom`,
 * `Header.tsx:180`-181 - kept as a plain string, not a template literal, so
 * writing it here does not itself invoke the arrow function it names.
 */
const MOBILE_NAV_ITEM_BORDER_BOTTOM_SOURCE =
  "border-bottom: ${(props) =>\n" +
  '    props.$active ? "4px solid #000" : "4px solid transparent"};';

const mobileNavActiveUnderline: LayoutFixture = {
  name: "mobile-nav-active-underline",
  summary:
    "The mobile bottom nav's active-tab underline, against the real MobileNav/MobileNavItem CSS",
  source: "src/components/Header.tsx:168",
  issue: "SCRUM-502",
  viewportWidth: 375,
  viewportHeight: 667,
  /* No horizontal chain: the defect and the fix are both vertical, and the
     item's width (25% of the bar) is unrelated to either. */
  insets: [],
  markup: `
    <style>
      [data-probe="nav"] {${MOBILE_NAV_CSS}      }
      [data-probe="nav"] > button {${MOBILE_NAV_ITEM_CSS}      }
      [data-probe="nav"] > button[data-active="true"] {
        border-bottom: 4px solid #000;
      }
      [data-probe="nav"] > button[data-active="false"] {
        border-bottom: 4px solid transparent;
      }
    </style>
    <div data-probe="nav">
      <button type="button" data-active="true" data-probe="item-active">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">Explore</span>
        </span>
      </button>
      <button type="button" data-active="false" data-probe="item-inactive">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">Requests</span>
        </span>
      </button>
    </div>
  `,
  widthProbe: "[data-probe='nav']",
  probe: {
    boxes: ["[data-probe='nav']", "[data-probe='item-active']"],
  },
  recorded: [
    "0px inset (Chromium's real default, no CDP override) at 375x667: nav rect top 607 / bottom 667 / height 60. item-active rect top 608 / bottom 667 / height 59 - one pixel inside the bar's own top edge (its 1px border-top), and exactly at the bar's bottom edge. The 4px border-bottom therefore paints from 663 to 667, fully inside a 667-tall viewport. Before the fix this same fixture measured item top 603.5 / bottom 671.5 / height 68, 3.5px above the bar and 4.5px below the viewport's bottom edge - the underline entirely off-screen.",
    "0px inset at 320x568 (the other required viewport): nav top 508 / bottom 568 / height 60. item-active top 509 / bottom 568 / height 59 - identical shape to 375x667, confirming the fix is width-independent, as the defect was.",
    "34px inset at 375x667, `Emulation.setSafeAreaInsetsOverride({ bottom: 34, bottomMax: 34 })` applied first so `env(safe-area-inset-bottom, 0px)` resolves to the override rather than its fallback: nav rect top 573 / bottom 667 / height 94 (60 + 34, matching `MOBILE_NAV_SPACE`). item-active top 574 / bottom 633 / height 59 - unchanged from the 0px case except for the bar's own position, because the item's `height: 100%` is what pins it to the content box regardless of how much of the bar's own height the inset consumes. Border-bottom paints 629 to 633, 34px clear of the viewport's bottom edge and inside the band `padding-bottom` reserves for the home indicator - the inversion of the pre-fix figure, which had the underline sitting in that band rather than the tap target's whole box respecting it.",
    "item-active `clientHeight` 55 and `contentHeight` 39 at every inset and width measured: the tap target (border-box, 59px) still clears the 44px floor SCRUM-421/432/480 established, and the 9px the icon-plus-label still exceed the 39px content box by is absorbed into the item's own 8px top/bottom padding rather than pushing past the button's edges - confirmed by the rect matching the bar's content box exactly rather than overflowing it.",
  ],
  reproduces: [
    {
      file: "src/components/Header.tsx",
      className: "height: ${MOBILE_NAV_SPACE};",
    },
    {
      file: "src/components/Header.tsx",
      className: "padding-bottom: env(safe-area-inset-bottom, 0px);",
    },
    {
      file: "src/components/Header.tsx",
      className: "border-top: 1px solid #d1d1d1;",
    },
    {
      file: "src/components/Header.tsx",
      className:
        "  align-items: center;\n  justify-content: center;\n  height: 100%;\n  padding: 8px 0;\n  width: 25%;",
    },
    {
      file: "src/components/Header.tsx",
      className: MOBILE_NAV_ITEM_BORDER_BOTTOM_SOURCE,
    },
    {
      file: "src/components/Header.tsx",
      className: 'style={{ fontSize: "24px", display: "flex" }}',
    },
    {
      file: "src/components/Header.tsx",
      className: 'style={{ position: "relative", display: "block" }}',
    },
    {
      file: "src/components/Header.tsx",
      className: 'style={{ fontSize: "12px", fontWeight: "500" }}',
    },
    {
      file: "src/utils/breakpoints.js",
      className: "const MOBILE_NAV_HEIGHT_PX = 60;",
    },
  ],
};

/**
 * SCRUM-530's fixture: the same `MobileNav`/`MobileNavItem` pair above, all
 * four real tabs, at a landscape phone (667x375) with a horizontal
 * safe-area-inset applied.
 *
 * `viewport-fit=cover` opts every page into drawing under a notched or
 * Dynamic Island iPhone's sensor housing, and `env(safe-area-inset-bottom)`
 * was the only one of the four insets this repository read - `-left` and
 * `-right` appeared nowhere. In portrait the horizontal insets are 0, so that
 * was very nearly correct; in landscape a notched iPhone reports roughly 44px
 * on whichever side the housing rotated to, and before this fix nothing here
 * moved the four `space-around` tabs out from under it.
 *
 * Same reasoning as `mobileNavActiveUnderline` above for why one fixture
 * covers every inset the criteria ask for: Chromium only reports a nonzero
 * `env(safe-area-inset-*)` when told to with
 * `Emulation.setSafeAreaInsetsOverride`, so the BEFORE/AFTER pair below was
 * measured by hand against that CDP call rather than derived from a chain of
 * classes. BEFORE was measured by removing the three lines
 * `padding-right`/`padding-bottom`/`padding-left` from this markup and
 * restoring the single `padding: 0px 0;` shorthand `MobileNav` used to
 * declare instead.
 */
const mobileNavHorizontalSafeArea: LayoutFixture = {
  name: "mobile-nav-horizontal-safe-area",
  summary:
    "The mobile bottom nav's four tabs against a left/right safe-area inset in landscape",
  source: "src/components/Header.tsx:131",
  issue: "SCRUM-530",
  viewportWidth: 667,
  viewportHeight: 375,
  /* No Tailwind container chain above the bar - it is `position: fixed` and
     its own box is the viewport width. The safe-area inset is not a
     `ContainerInset`: it is a CDP override applied by hand, not a class this
     chain can name, which is why `insets` stays empty and the derivation this
     produces is only the zero-inset case. */
  insets: [],
  markup: `
    <style>
      [data-probe="nav"] {${MOBILE_NAV_CSS}      }
      [data-probe="nav"] > button {${MOBILE_NAV_ITEM_CSS}      }
    </style>
    <div data-probe="nav">
      <button type="button" data-probe="item-0">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">Explore</span>
        </span>
      </button>
      <button type="button" data-probe="item-1">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">Requests</span>
        </span>
      </button>
      <button type="button" data-probe="item-2">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">My Group</span>
        </span>
      </button>
      <button type="button" data-probe="item-3">
        <span style="font-size: 24px; display: flex;" aria-hidden="true">&#9675;</span>
        <span style="position: relative; display: block;">
          <span style="font-size: 12px; font-weight: 500;">Profile</span>
        </span>
      </button>
    </div>
  `,
  widthProbe: "[data-probe='nav']",
  probe: {
    boxes: [
      "[data-probe='nav']",
      "[data-probe='item-0']",
      "[data-probe='item-3']",
    ],
  },
  recorded: [
    "0px inset (no CDP override) at 667x375: nav rect left 0 / right 667, height 60. item-0 left 0 / right 166.75. item-3 left 500.25 / right 667. Identical whether measured before or after this fix - the zero-inset control the criteria require.",
    "AFTER, 44px left / 34px bottom (housing rotated to the left edge, home indicator band at the reduced landscape height SCRUM-502 already accounts for vertically): nav rect left 0 / right 667 - the bar's own box, and therefore its background, still spans the full viewport and covers the housing band. item-0 left 44 / right 199.75, width 155.75 - entirely inside the safe content box `[44, 667]` and well clear of the 44px WCAG/HIG floor. item-3 left 511.25 / right 667, also entirely inside.",
    "AFTER, 44px right / 34px bottom (housing rotated to the right edge): item-0 left 0 / right 155.75 - unaffected side, unchanged shape. item-3 left 467.25 / right 623, entirely inside the safe content box `[0, 623]`.",
    "BEFORE (the defect, reproduced by removing this fixture's `padding-right`/`padding-left` and restoring the single `padding: 0px 0;` MobileNav used to declare): 44px left / 34px bottom at 667x375 - item-0 left 0 / right 166.75, **unmoved by the inset**, because nothing in the unfixed CSS read it. 44px of that tab's 166.75px width sits under the housing band. 44px right / 34px bottom: item-3 left 500.25 / right 667, the same 44px of its width under the housing on the opposite edge. The bar's own rect was already full-width before the fix, so the background-coverage half of the criteria held even before this ticket - only the items were wrong.",
  ],
  reproduces: [
    {
      file: "src/components/Header.tsx",
      className: "padding-top: 0;",
    },
    {
      file: "src/components/Header.tsx",
      className: "padding-right: env(safe-area-inset-right, 0px);",
    },
    {
      file: "src/components/Header.tsx",
      className: "padding-left: env(safe-area-inset-left, 0px);",
    },
    {
      file: "src/components/Header.tsx",
      className: "justify-content: space-around;",
    },
    {
      file: "src/components/Header.tsx",
      className: "width: 25%;",
    },
  ],
};

/**
 * The profile dropdown, open, at the desktop widths SCRUM-517's Impact section
 * names - 1280x800 and 1440x900.
 *
 * `[data-probe='dropdown-wrapper']` is `relative z-30` - the fix - and is the
 * only positioned element between `[data-probe='panel']` and the viewport.
 * Before the fix it was a plain `z-30`, `right-0` resolved against the
 * viewport instead of the trigger, and the two right edges disagreed by
 * however far the trigger sat from the window's own right edge. Reproduced
 * with the fix in place, because a fixture holds the current source
 * (`layoutFixtures.ts`'s own header says so); the BEFORE figures below were
 * measured by removing `relative` from this same markup.
 *
 * `[data-probe="bar"]` and its inset are carried over from `header-control-row`
 * unchanged, so the same measurement that proves the panel's own alignment
 * also confirms this ticket touched no figure SCRUM-491 or SCRUM-484
 * established for that bar.
 */
const profileDropdownPanel: LayoutFixture = {
  name: "profile-dropdown-panel",
  summary:
    "The open profile menu panel, anchored to its trigger rather than the window",
  source: "src/components/DropDownMenu.tsx:105",
  issue: "SCRUM-517",
  viewportWidth: 1280,
  viewportHeight: 800,
  insets: [{ name: "bar padding 0 40px", x: 80 }],
  markup: `
    <style>
      [data-probe="bar"] {${HEADER_BAR_CSS}      }

      @media (min-width: 640px) {
        [data-probe="bar"] {
          padding: 0 40px;
        }
      }
    </style>
    <div data-probe="bar">
      <h1>CarpoolNU</h1>
      <div class="flex items-center">
        <div class="relative z-30" data-probe="dropdown-wrapper">
          <button class="${HEADER_AVATAR_TRIGGER_CLASS}" data-probe="avatar-trigger">
            <span class="h-full w-full rounded-full bg-gray-400"></span>
          </button>
          <div class="absolute right-0 mt-2 w-56 origin-top-right divide-y divide-gray-300 rounded-lg bg-white shadow-lg ring-1 ring-black/5 focus:outline-hidden" data-probe="panel">
            <div class="flex flex-col items-center justify-center p-6">
              <h1 class="text-lg font-bold">Jane Doe</h1>
              <p class="text-sm font-light text-gray-500">jane.doe@example.com</p>
              <button class="mt-4 w-4/5 rounded-2xl border border-gray-300 bg-white px-3 py-2 text-center hover:bg-gray-100">Profile</button>
            </div>
            <div class="flex flex-col items-center justify-center px-2 py-4">
              <button class="w-4/5 rounded border border-gray-300 bg-white px-3 py-2 text-center hover:bg-gray-100">Sign Out</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  widthProbe: "[data-probe='bar']",
  probe: {
    boxes: [
      "[data-probe='bar']",
      "[data-probe='avatar-trigger']",
      "[data-probe='panel']",
    ],
  },
  recorded: [
    "AFTER SCRUM-517, at 1280x800: bar rect 1280 x 68, contentWidth 1200 matching the predicted chain. avatar-trigger rect left 1184, width 56 - right edge 1240. panel rect left 1016, width 224 - right edge 1240. **The two right edges agree exactly.** Panel stays fully on screen, left 1016 to right 1240, inside 0-1280.",
    "AFTER SCRUM-517, at 1440x900: bar rect 1440 x 76.5 (clientHeight rounds to 77), contentWidth 1360 matching the predicted chain. avatar-trigger rect left 1344, width 56 - right edge 1400. panel rect left 1176, width 224 - right edge 1400. **The two right edges agree exactly**, and the bar's own height (76.5) and padding (40 each side) are unchanged from `header-control-row`'s desktop control for this same figure - this ticket touched no property of the bar itself.",
    "BEFORE (the defect, reproduced by removing `relative` from `[data-probe='dropdown-wrapper']` and otherwise measuring identically): at 1280x800, avatar-trigger right edge 1240, unchanged from AFTER since the trigger itself was never repositioned. panel rect left 1056, width 224 - right edge 1280, exactly the viewport width rather than the trigger's edge. **The two right edges disagree by 40px - the bar's own desktop padding, which is the Proposed Fix section's hypothesis and is now the measured mechanism, not an estimate.**",
    "BEFORE, at 1440x900: avatar-trigger right edge 1400, unchanged. panel rect left 1216, width 224 - right edge 1440, again exactly the viewport width. Same 40px disagreement at both widths, confirming the mechanism (no positioned ancestor, so `right-0` resolves against the initial containing block) rather than a fixed pixel offset that happened to match one viewport.",
    "The open transition's origin corner: `origin-top-right` is unchanged by this fix - only the box it pivots now has the right edge the class name assumes.",
  ],
  reproduces: [
    {
      file: "src/components/DropDownMenu.tsx",
      className: "relative z-30",
    },
    {
      file: "src/components/DropDownMenu.tsx",
      className: HEADER_AVATAR_TRIGGER_CLASS,
    },
    {
      file: "src/components/DropDownMenu.tsx",
      className:
        "absolute right-0 mt-2 w-56 origin-top-right divide-y divide-gray-300 rounded-lg bg-white shadow-lg ring-1 ring-black/5 focus:outline-hidden",
    },
  ],
};

export const LAYOUT_FIXTURES: readonly LayoutFixture[] = [
  groupMemberCardTrigger,
  headerLogoBar,
  adminConsoleChartFold,
  profileContentColumnWidth,
  headerControlRow,
  messagePanelChrome,
  mapOverlayAnchors,
  centredDialogPanels,
  mobileNavActiveUnderline,
  mobileNavHorizontalSafeArea,
  mobileContentRowHeight,
  mobileTourMapStepSheetOverlap,
  profileDropdownPanel,
];

export const findFixture = (name: string): LayoutFixture | undefined =>
  LAYOUT_FIXTURES.find((fixture) => fixture.name === name);

/**
 * The page served to the browser.
 *
 * Three things in here are load-bearing and were each paid for once:
 *
 *  - **`#__next`.** `globals.css` styles that id directly - `width: 100vw` and
 *    a `100dvh` height - so markup mounted outside it sits in a different
 *    layout than the app's. The fixture goes inside it, as the app's tree does.
 *  - **The stylesheet is this project's own compiled output**, served at
 *    `/styles.css`, not a CDN build and not a hand-written subset. A fixture
 *    measured against anything else is measuring that other thing.
 *  - **The probe is a `<script src>`**, not inlined. Same file `yarn test`
 *    requires; see the header of `layoutProbe.js` for why that matters.
 *
 * The `<meta name="viewport">` line is what the app ships, so that a mobile
 * emulation in the driver behaves the way the app does.
 */
export const buildFixturePage = (
  fixture: LayoutFixture,
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${fixture.name} — NUCarpool layout fixture</title>
    <link rel="stylesheet" href="/styles.css" />
    <script src="/probe.js"></script>
  </head>
  <body>
    <div id="__next">${fixture.markup}</div>
  </body>
</html>
`;
