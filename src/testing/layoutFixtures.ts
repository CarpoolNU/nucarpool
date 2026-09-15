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
              <div class="mt-auto h-6 w-full" data-probe="short-chart-x-axis"></div>
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

export const LAYOUT_FIXTURES: readonly LayoutFixture[] = [
  groupMemberCardTrigger,
  headerLogoBar,
  adminConsoleChartFold,
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
