/**
 * The two class requests SCRUM-488 turns on, asserted from the source rather
 * than from a render.
 *
 * **Neither figure this ticket is about is observable in jsdom**, which
 * resolves no CSS and reports every rect as zero - `src/testing/viewport.ts`
 * says so at length, and both defects here were rects. The measurements live
 * in Chromium instead, through `scripts/measure-layout.ts` and the
 * `admin-console-chart-fold` fixture, and nothing runs that automatically. So
 * what is assertable in `yarn test` is the proxy: that the components still
 * *ask* for the utilities the measurement was taken against.
 *
 * Source-reading and not `render()`, for a reason particular to these two
 * components. `BarChartDaysFrequency` draws through Chart.js, which needs a
 * canvas context jsdom does not implement at all, and `AdminData` is a tRPC
 * consumer whose whole body is queries. Standing either one up would test the
 * mock harness rather than the class string, and the class string is the only
 * part in question.
 *
 * `scripts/measure-layout.test.ts` already guards that the fixture's copies of
 * these strings match the files they claim. That is a *drift* check between
 * two places, and it passes just as happily if both are reverted together.
 * This is the intent check: it says what the utilities are for, so a change
 * that removes one fails against the reason rather than against a copy.
 */
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const sourceOf = (file: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, file), "utf8");

/**
 * Every `className` list in a file that requests the given utility.
 *
 * Whole tokens rather than a substring search, which matters more here than it
 * looks: a plain `includes` for a margin would match one inside a longer
 * arbitrary value and report a margin that is not there.
 */
const classListsRequesting = (source: string, utility: string): string[] =>
  [...source.matchAll(/className="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((list) => list.split(/\s+/).includes(utility));

/** A top, bottom or shorthand-vertical margin, in Tailwind's token grammar. */
const VERTICAL_MARGIN = /^-?m[tby]-/;

describe("AdminData's scroll port", () => {
  const source = sourceOf("src/components/Admin/AdminData.tsx");
  const [port, ...others] = classListsRequesting(source, "overflow-y-auto");

  it("is the only scrolling box in the file, so the rest of this is unambiguous", () => {
    expect(port).toBeDefined();
    expect(others).toHaveLength(0);
  });

  it("still fills the content row and still scrolls", () => {
    const classes = port.split(/\s+/);

    expect(classes).toContain("h-full");
    expect(classes).toContain("w-full");
    expect(classes).toContain("overflow-y-auto");
  });

  it("spaces itself with padding, never a vertical margin", () => {
    /*
     * The defect, stated as the thing that must not come back. A `h-full` box
     * inside an `overflow-hidden` parent is exactly as tall as that parent, so
     * a vertical margin cannot make room - it pushes the box past the clip,
     * and the 16px that leaves the bottom is unreachable at any scroll
     * position rather than merely below the fold. Measured at 16px at 1440x900
     * and 667x582 alike before the fix, and at 0 at both after it.
     */
    const classes = port.split(/\s+/);

    expect(classes).toContain("py-4");
    expect(classes.filter((name) => VERTICAL_MARGIN.test(name))).toEqual([]);
  });

  it("would notice a vertical margin, so the assertion above can fail", () => {
    /*
     * The control. Without it the matcher could be wrong in the direction that
     * passes silently - a regex that matches nothing agrees with every file.
     *
     * The sample is the utility this element used to carry rather than an
     * invented one, and that is not fussiness: **Tailwind v4 scans this
     * repository, test files included, so naming a utility here emits it as
     * real CSS.** `my-4` is still in the bundle because `UnsavedModal` uses
     * it, so naming it costs nothing; an invented one would ship a rule that
     * applies to no element in the app, which `measure-layout.test.ts` records
     * having done once, at 52 bytes.
     */
    expect(VERTICAL_MARGIN.test("my-4")).toBe(true);
    expect(VERTICAL_MARGIN.test("py-4")).toBe(false);
  });
});

describe("BarChartDaysFrequency's root", () => {
  const source = sourceOf("src/components/Admin/BarChartDaysFrequency.tsx");
  const [root] = classListsRequesting(source, "h-[500px]");

  it("declares the height the console's gate is derived from", () => {
    expect(root).toBeDefined();
  });

  it("refuses to be shrunk out of it", () => {
    /*
     * `ADMIN_SHORTEST_CHART_HEIGHT_PX` derives the gate from this 500, and
     * before SCRUM-488 the box never rendered at it: as a flex item of a
     * column whose children always sum to more than the row, with
     * `flex-shrink` defaulting to 1 and `min-height: auto` not stopping it, it
     * was measured at 151.5px at 1440x900 and 24px at 667x582. The height and
     * the no-shrink are one request; either alone is the defect.
     */
    const classes = root.split(/\s+/);

    expect(classes).toContain("h-[500px]");
    expect(classes).toContain("shrink-0");
  });

  it("reads a real file, so a missing class fails rather than passing vacuously", () => {
    /* The positive control for the extractor: the query above has to be
       capable of coming back empty. `flex-row` is a real utility the app uses
       elsewhere - `admin.tsx`'s content row - and is deliberately not in this
       file, so one of these two must be empty and the other must not. */
    expect(classListsRequesting(source, "flex-col")).not.toHaveLength(0);
    expect(classListsRequesting(source, "flex-row")).toHaveLength(0);
  });
});
