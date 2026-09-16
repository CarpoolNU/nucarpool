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
  HEADER_LOGO_MAX_FONT_SIZE,
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
 * `#__next` is `height: 100dvh` (`globals.css`), `HeaderDiv` is `height: 8.5%`
 * of it, and every desktop content row is the `h-[91.5%]` remainder. So both
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
 * All three desktop rows - `admin.tsx:120`, `index.tsx:1039`,
 * `profile/index.tsx:491` - are `h-[91.5%]` siblings of the bar, so the edge
 * this fixture measures against is at 8.5% of the viewport on every one of
 * them. The row's own contents differ and are not what is being measured.
 */
const CONTENT_ROW_CLASS =
  "relative flex h-[91.5%] w-full flex-row overflow-hidden";

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
const ADMIN_SHORT_CHART_CLASS = "flex h-[500px] w-full flex-col";

const ADMIN_SCROLL_PORT_CLASS = "my-4 h-full w-full overflow-y-auto";

const ADMIN_SCROLL_INNER_CLASS = "flex h-full w-full flex-col space-y-4 px-8";

const ADMIN_SIDEBAR_CLASS =
  "border-busy-red z-0 h-full max-w-[250px] min-w-[175px] flex-[1] border-r-4 bg-stone-100";

const adminConsoleChartFold: LayoutFixture = {
  name: "admin-console-chart-fold",
  summary:
    "The admin console's two chart heights inside the 91.5% content row, at the height its gate is set to",
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
    "scroll-port rect top 65.469 and height 532.523: the same height as the row, pushed 16px down by `my-4`. The largest slice of scroll content that can be on screen at once is therefore 516.523, and the 500px chart the gate is derived from fits inside it — scrolled to the top of the port, its axis lands at 581.969 against a viewport of 582.",
    "chart (`min-h-[600px]`) rect height 600 at every viewport measured. A minimum is a floor a flex shrink cannot cross, which is what makes this the console's real tallest block.",
    "short-chart (`h-[500px]`) rect height 24 here and 151.5 at 1440x900 — **not 500 at either**. It is a shrinkable flex item in a column that always overflows, so it renders at whatever is left. Separate defect, filed, not fixed here; `ADMIN_SHORTEST_CHART_HEIGHT_PX` explains why the gate still uses the declared 500.",
    "chart contentWidth 424, matching the predicted chain. Read the sidebar note on `insets` before reusing this at another width.",
    "BEFORE, at 667x375 — the viewport that now gets `AdminMobileNotice` instead: row 343.125, port 311.13 of usable window, chart 600, and the axis at rect top 679.875, some 305px below the fold.",
    "BEFORE, and the more serious half: scrolled fully to the bottom the axis's rect bottom was 390.875 against a viewport of 375, so it was *permanently* unreachable — `my-4` plus `h-full` makes the port 16px taller than the row that clips it, so its last 16px is outside the clip at any scroll position. Measured at 1440x900 too, where it is also 16. Viewport-independent, separate defect, filed.",
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
  "relative grid h-[91.5%] w-full grid-cols-[250px_repeat(2,1fr)] overflow-hidden";

const PROFILE_SIDEBAR_CLASS =
  "border-busy-red sticky top-0 col-start-1 col-end-2 h-full w-[250px] border-r-4 bg-stone-100 lg:w-[350px]";

const PROFILE_SCROLL_COLUMN_CLASS =
  "col-start-2 col-end-4 flex h-full shrink items-start justify-center overflow-x-hidden overflow-y-auto";

const PROFILE_SCROLL_INNER_CLASS = "mt-10 w-full max-w-2xl px-8";

const ACCOUNT_SECTION_DESKTOP_CLASS =
  "flex h-fit w-[700px] flex-col justify-start";

/**
 * `AccountSection.tsx:80` composes its class through a ternary, so the desktop
 * string above never appears contiguously in the source and cannot anchor the
 * drift guard. The anchor is the ternary's own text instead - a weaker anchor
 * than a class string, for the same reason `Header.tsx`'s declarations are, and
 * the only one available where the branch is assembled rather than written.
 */
const ACCOUNT_SECTION_WIDTH_TERNARY =
  'flex h-fit ${isMobile ? "w-full" : "w-[700px]"} flex-col justify-start';

const ACCOUNT_SAVE_BUTTON_CLASS =
  "bg-northeastern-red w-full rounded-lg py-3 text-lg text-white hover:bg-red-700";

const USER_SECTION_ROLE_ROW_DESKTOP_CLASS = "flex h-24 w-[700px]";

const profileContentColumnWidth: LayoutFixture = {
  name: "profile-content-column-width",
  summary:
    "The profile page's two 700px desktop rows inside the content column an overflow-x-hidden grid gives them",
  source: "src/components/Profile/AccountSection.tsx:80",
  issue: "SCRUM-485",
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
              <div class="flex w-2/3 gap-8 lg:w-full" data-probe="date-row">
                <div class="flex flex-1 flex-col">
                  <span>Start Date</span>
                  <div class="h-14 w-full rounded-md border border-gray-200 p-2 text-lg" data-probe="start-date">2026-01</div>
                </div>
                <div class="flex flex-1 flex-col">
                  <span>End Date</span>
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
    "scroll-inner contentWidth 353, matching the predicted chain. clientWidth is 417; the 64px difference is its own px-8.",
    "account-section rect left 282 width 700 — right edge at 982 against a viewport of 667. 315px of it is outside the screen.",
    "save-button rect width 700, of which 385 is on screen. `overlaps scroll-column` 0.55, and the footprint hit test skipped 3 of its 9 points as outside the viewport. The 6 it could press are reachable, so the button works — it is just 45% off-screen.",
    'save-button label survives: centred in the 700px box it lands at x 632, which is inside 667. Reading this as "the label is cut off" is the easy mistake; it is not.',
    "end-date rect left 531.33 width 217.34 — right edge 748.66, so 81.66px of the End Date picker is off-screen. This is the item's real cost: a form control, not blank box.",
    "The overflow is not reachable by any gesture. scroll-column is `overflow-x-hidden` with scrollWidth 732 against clientWidth 417, and the document itself has scrollWidth 667 = clientWidth 667 with scrollLeft pinned at 0. Setting scrollLeft programmatically does move it, which is why keyboard focus rescues the control and a finger does not: scrollIntoView on end-date takes the column to 81.5.",
    "role-row — `UserSection.tsx:93`, the item SCRUM-477 ranked High — measures 353 wide and 96 tall, and is the counter-example. `max-w-full` caps its declared 700px, so it does not overflow at all, and the 56px seat field ends at 167.875, exactly the row's own bottom edge. SCRUM-477's \"64px overflow\" was a misreading: `ProfilePicture` is not in this div, it is at `UserSection.tsx:175`.",
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
      className: ACCOUNT_SAVE_BUTTON_CLASS,
    },
    {
      file: "src/components/Profile/UserSection.tsx",
      className: USER_SECTION_ROLE_ROW_DESKTOP_CLASS,
    },
  ],
};

const HEADER_NAV_BUTTON_CLASS = "rounded-xl p-4 font-medium text-xl text-white";

const HEADER_AVATAR_TRIGGER_CLASS =
  "flex h-14 w-14 items-center justify-center overflow-hidden rounded-full";

const headerControlRow: LayoutFixture = {
  name: "header-control-row",
  summary:
    "The header's right-hand controls - the tab buttons and the 56px avatar trigger - inside the 8.5% bar",
  source: "src/components/DropDownMenu.tsx:58",
  issue: "SCRUM-485",
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
          <button class="${HEADER_NAV_BUTTON_CLASS}">Requests</button>
          <button class="${HEADER_NAV_BUTTON_CLASS}">My Group</button>
        </div>
        <div class="z-30">
          <button class="${HEADER_AVATAR_TRIGGER_CLASS}" data-probe="avatar-trigger">
            <span class="h-14 w-14 rounded-full bg-gray-400"></span>
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
      "[data-probe='avatar-trigger']",
      "[data-probe='content-row']",
    ],
    footprint: "[data-probe='avatar-trigger']",
    against: ["[data-probe='content-row']"],
  },
  recorded: [
    "bar rect height 31.875 at 375 tall, and logo rect height 31.875 at top 0 — SCRUM-484's fix still holding. Everything below is what that ticket did not reach.",
    "avatar-trigger rect height 56 at top -12.0625: the top 12.06px is above the viewport and the bottom 12.06px is below the bar. `overlaps content-row` 0.215.",
    "nav-button rect height 60 at top -14.0625 — the four desktop tabs are the taller offender, and they are `rounded-xl p-4 text-xl`: 16 + 28 + 16.",
    "The two differ in whether the overlap is clickable, and the reason is a flex-item rule rather than a z-index one. At y 38 — below the bar, inside the row — elementFromPoint returns the avatar's own span, but for the nav button it returns the row's background div. `DropDownMenu`'s wrapper carries a z-index and is a flex item, and a flex item's z-index creates a stacking context even at `position: static`; the tab group's wrapper has none. So the avatar keeps its full 43.94px of visible target and each tab is left with 31.875px, the bar's height, against the 44px this repository asks of a touch control.",
    "avatar-trigger footprint skipped 3 of 9 points as outside the viewport and found the remaining 6 reachable and unobstructed.",
    "Not strictly landscape-specific — the bar is 8.5% of the viewport, so the 60px tab overflows below 706px of viewport height and the 56px trigger below 659px — but the band matters far less than that sounds, and the measurement is what says so. At 1366x660 the bar is 56.094, the tab overhangs by 1.953px each way and the trigger fits exactly (-0.047). Two pixels is not a defect. It is only at a landscape phone's 31.875px bar that the figures become the 12-14px above.",
    "DESKTOP CONTROL at 1440x900: bar 76.5, both fit with room to spare, overflow 0. So the honest statement is that this degrades continuously as the window shortens and is only worth acting on at the bottom of the range. SCRUM-477's Closeout recorded the same shape for the logo, which overflowed by 17.25px each way even at 1440x900 — this is the milder version of that.",
    "bar contentWidth 587, matching the predicted chain; the 80px against clientWidth 667 is the bar's own desktop padding.",
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
      className: "height: ${HEADER_BAR_HEIGHT};",
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
const MESSAGE_DATE_SEPARATOR_CLASS = "text-md my-2 text-center text-gray-500";

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

const SEND_BAR_CLASS = "desktop:px-6 border-t border-gray-200 px-4 py-6";

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
    "The desktop message panel's header, tab strip and send bar inside the 91.5% row, and what is left for the conversation",
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
    "AFTER SCRUM-489. Every figure below was re-measured on the fix; the `BEFORE` lines are kept because this fixture's whole purpose is the comparison, and because two of them are the reason the threshold is where it is.",
    "message-header rect height 65 — `px-2 py-1` around an `h-14` avatar, plus the `border-b`. BEFORE: 145, from `p-8` around `h-20`. The height is set by the close control rather than the avatar below 56px, which is why the avatar stops at `h-14` and the padding does the rest.",
    "The chrome was the finding, not the header alone: header 65 + tab-strip 53 = 118 of a 343.125px row, leaving content-area 225.13. BEFORE: 198 of chrome and 145.13 of content-area.",
    "message-content rect height 115.13, clientHeight 115, `padding: 16px` — **contentHeight 83**. BEFORE: rect 32, clientHeight 32, **contentHeight 0** with a scrollHeight of 220 behind it. That is the defect: the conversation was not cramped at 667x375, it was invisible.",
    "The newest message is readable, which is the criterion and not a proxy for it. Scroll the port to the bottom the way `MessageContent` does and the bubble is 64px tall with **all 64 inside the port** — 83 of content height is the 64px bubble plus the block's 16px `mb-4`, with 3 to spare. At `py-2` on the header it would be 75 and the bubble's top 5px would be clipped, which is the whole argument for the 4px.",
    "send-bar rect height 110, bottom at **375.00** against a viewport of 375 — nothing past the edge. BEFORE: 131.5 with its bottom at 393.38, so the last 18.38px sat under the screen with `#__next` at `100dvh` and no page scroll to reach it.",
    "content-area scrollHeight equals its clientHeight — **overflow 0**. BEFORE: 179 against 145, the same 34px of overflow seen from the other side. The mechanism was that content-area is `flex h-0 flex-1 flex-col`, and a flex item will not shrink below its min-content height, so the 131.5px send bar took the space and message-content was left with its own padding.",
    "The bubble is 153x64. BEFORE: 90x112 — the half-column width cap, then applied on width alone, held it to 110px of a 220px column, so a 26-character message wrapped to four lines. The cap is a readability rule at a wide panel and a height multiplier at a narrow one, which is why it moved to the same screen as the rest of the chrome. (Both caps are named here as widths rather than as their utilities: this file is scanned, and a selector-set diff caught the `BEFORE` half of this very line keeping the retired rule alive in the shipped bundle.)",
    "The composer is 158px wide and 59px tall, two lines of `globals.css`'s `.placeholder:empty:before` hint. BEFORE: 78x80.5 and three lines. The hint needs about 200px for one line, which a 267px panel cannot give it at any inset — so dropping the row's 40px side margins relieves the height cost rather than removing it. The remaining crowding, and the unconditional `py-6` this ticket could not reach, are SCRUM-494.",
    "send-button rect 58x46, fully inside the composer row and reachable — unchanged, and it was never the problem. An earlier draft of this fixture reported it clipped; that was the stand-in composer's fault, see SEND_BAR_COMPOSER_CLASS.",
    "message-header contentWidth 251, matching the predicted chain — 667 less the 400px sidebar less its own `px-2`. Note the chain is stated for *this* viewport, so serving the fixture at a tall one prints a prediction 48px short of what it measures.",
    "DESKTOP CONTROL at 1440x900, unchanged in every term: header 145 with `padding: 32px`, avatar 80, tab-strip 53, content-area 625.5, message-content contentHeight **497**, send-bar **97** with nothing past the viewport, composer 37.5 on one line, composer row margin `0px 40px`, bubble max-width `50%` at 44px tall. This is what `message-panel-tall:` is protecting.",
    "THE BOUNDARY, both sides of it, at 667 wide: 489 gives the full-size chrome — header 145, margin `0px 40px`, cap `50%`, contentHeight 86 — and 488 gives the compact one — header 65, margin `0px`, cap `85%`, contentHeight 187. Neither overflows.",
    "THE DERIVATION, checked where it was derived: at 1440x489 the conversation measures exactly 120px of content height against a dated message of exactly 120. `MESSAGE_PANEL_MIN_HEIGHT_PX` is tight at the threshold rather than approximately right, and the 86 above is the same threshold seen at a panel too narrow for a one-line composer.",
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
  "text-md absolute bottom-8 left-2 z-10 flex flex-col rounded-xl border border-gray-200 bg-white p-2 md:text-lg";

const MAP_CONTAINER_CLASS =
  "pointer-events-auto relative z-0 h-full w-full flex-auto";

const mapOverlayAnchors: LayoutFixture = {
  name: "map-overlay-anchors",
  summary:
    "The desktop recentre button and the always-expanded legend against a map that is only 91.5% of a landscape phone",
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
  "relative flex w-1/3 flex-col justify-center rounded-lg bg-white px-6 py-16 text-center shadow-lg";

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
    "unsaved-panel is the exception and the one that does overflow: rect height 376 at top -0.5, bottom 375.5 against a viewport of 375. Half a pixel each way now, growing on any shorter viewport — this is the centred box `justify-center-safe` would be for.",
    "Its mechanism is not the one SCRUM-477 recorded. The survey blamed `py-16` and put the clipping threshold at ~280px; the padding is 128px and the panel is 376px, so something else supplies the other 248. It is the width: `w-1/3` is 222.33px here, leaving 174 of content for a button row whose two labels need 196 (scrollWidth 196 against clientWidth 174), so both labels wrap and unsaved-buttons measures 88px tall instead of ~40.",
    "unsaved-save is fully inside the viewport at 101.32x88, so the modal is answerable — it is the panel's own top and bottom edges that leave the screen, by half a pixel at this height.",
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

export const LAYOUT_FIXTURES: readonly LayoutFixture[] = [
  groupMemberCardTrigger,
  headerLogoBar,
  adminConsoleChartFold,
  profileContentColumnWidth,
  headerControlRow,
  messagePanelChrome,
  mapOverlayAnchors,
  centredDialogPanels,
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
