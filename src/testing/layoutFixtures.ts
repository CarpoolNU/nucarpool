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

export const LAYOUT_FIXTURES: readonly LayoutFixture[] = [
  groupMemberCardTrigger,
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
