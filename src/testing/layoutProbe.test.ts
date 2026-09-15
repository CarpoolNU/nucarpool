/**
 * The layout probe's arithmetic, and the guard that keeps it honest.
 *
 * **In the `node` project, not `jsdom`, and that is the stronger claim.** Jest
 * splits the two by file extension, so a `.test.ts` runs with no DOM at all.
 * Nothing here needs one: the geometry is pure, and the three functions that
 * do touch a document take an injectable `{ document, window }` that these
 * tests fill with a stub. Running in jsdom would give the *appearance* of a
 * DOM while still measuring nothing - every rect zero, no layout - which is
 * the exact confusion `src/testing/viewport.ts` exists to warn about.
 *
 * What a browser is still needed for is the layout itself. These tests prove
 * the harness computes the right points and reports the right shape; only
 * Chromium can say what is actually at those points. See
 * `scripts/measure-layout.ts`.
 */

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ProbePoint {
  x: number;
  y: number;
  col: number;
  row: number;
}

interface StubElement {
  tagName: string;
  className: string;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => Rect;
  clientHeight: number;
  clientWidth: number;
  contains: (other: unknown) => boolean;
}

interface StubEnv {
  document: {
    querySelector: (selector: string) => StubElement | null;
    elementFromPoint: (x: number, y: number) => StubElement | null;
  };
  window: {
    innerWidth: number;
    innerHeight: number;
    getComputedStyle: (element: StubElement) => Record<string, string>;
  };
}

interface LayoutProbe {
  gridPoints: (rect: Rect, cols?: number, rows?: number) => ProbePoint[];
  isPointInViewport: (
    point: { x: number; y: number },
    viewport: { width: number; height: number },
  ) => boolean;
  plannedProbePoints: (
    rect: Rect,
    viewport: { width: number; height: number },
    cols?: number,
    rows?: number,
  ) => { points: ProbePoint[]; skipped: ProbePoint[]; measurable: boolean };
  intersectionArea: (a: Rect, b: Rect) => number;
  overlapFraction: (target: Rect, other: Rect) => number;
  measureBox: (
    selector: string,
    env?: StubEnv,
  ) => {
    selector: string;
    probe: string | null;
    rect: Rect;
    clientHeight: number;
    clientWidth: number;
    contentWidth: number;
    contentHeight: number;
    padding: { left: number; right: number; top: number; bottom: number };
  };
  probeFootprint: (
    selector: string,
    options?: { cols?: number; rows?: number },
    env?: StubEnv,
  ) => {
    measurable: boolean;
    probed: number;
    skippedOutsideViewport: number;
    onTarget: number;
    reachable: boolean;
    obstructedBy: ({ probe: string | null; tag: string } | null)[];
    points: (ProbePoint & { onTarget: boolean })[];
  };
  report: (
    spec: {
      boxes?: string[];
      footprint?: string;
      against?: string[];
      cols?: number;
      rows?: number;
    },
    env?: StubEnv,
  ) => {
    viewport: { width: number; height: number };
    boxes: Record<string, { clientHeight: number }>;
    footprint: { probed: number } | null;
    overlaps: Record<string, number>;
  };
}

/*
 * Required rather than imported, because this is the same plain-JS file the
 * measured page loads through a `<script src>`. Its header explains why it is
 * not TypeScript; the short version is that `target: es2017` would rewrite an
 * object spread into a helper the page does not have.
 */
const probe = require("./layoutProbe.js") as LayoutProbe;

const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
): Rect => ({ left, top, width, height });

/** A stub element. `padding` feeds the `getComputedStyle` the stub env hands back. */
const stubElement = (
  options: Partial<StubElement> & {
    probe?: string;
    box?: Rect;
    children?: StubElement[];
  } = {},
): StubElement => {
  const box = options.box || rect(0, 0, 0, 0);
  const children = options.children || [];
  const element: StubElement = {
    tagName: options.tagName || "BUTTON",
    className: options.className || "",
    getAttribute: (name: string) =>
      name === "data-probe" && options.probe ? options.probe : null,
    getBoundingClientRect: () => box,
    clientHeight:
      options.clientHeight === undefined ? box.height : options.clientHeight,
    clientWidth:
      options.clientWidth === undefined ? box.width : options.clientWidth,
    contains: (other: unknown) =>
      other === element || children.indexOf(other as StubElement) !== -1,
  };

  return element;
};

const stubEnv = (options: {
  elements?: Record<string, StubElement | null>;
  at?: (x: number, y: number) => StubElement | null;
  viewport?: { width: number; height: number };
  padding?: Record<string, string>;
}): StubEnv => {
  const viewport = options.viewport || { width: 375, height: 812 };
  const padding = options.padding || {};

  return {
    document: {
      querySelector: (selector: string) => {
        const elements = options.elements || {};

        return selector in elements ? elements[selector] : null;
      },
      elementFromPoint: (x: number, y: number) =>
        options.at ? options.at(x, y) : null,
    },
    window: {
      innerWidth: viewport.width,
      innerHeight: viewport.height,
      getComputedStyle: () => ({
        paddingLeft: padding.paddingLeft || "0px",
        paddingRight: padding.paddingRight || "0px",
        paddingTop: padding.paddingTop || "0px",
        paddingBottom: padding.paddingBottom || "0px",
      }),
    },
  };
};

describe("gridPoints", () => {
  it("puts a 3x3 default at the centre of each third", () => {
    const points = probe.gridPoints(rect(100, 200, 90, 60));

    expect(points).toHaveLength(9);
    // Thirds of 90 are 30 wide, so centres sit at 15, 45 and 75 from the left.
    expect(points.map((point) => point.x)).toEqual([
      115, 145, 175, 115, 145, 175, 115, 145, 175,
    ]);
    // Thirds of 60 are 20 tall: 10, 30, 50 from the top.
    expect(points.map((point) => point.y)).toEqual([
      210, 210, 210, 230, 230, 230, 250, 250, 250,
    ]);
  });

  it("labels every cell with its own column and row", () => {
    const points = probe.gridPoints(rect(0, 0, 30, 30), 3, 3);

    expect(points.map((point) => `${point.col},${point.row}`)).toEqual([
      "0,0",
      "1,0",
      "2,0",
      "0,1",
      "1,1",
      "2,1",
      "0,2",
      "1,2",
      "2,2",
    ]);
  });

  it.each([
    [1, 1, 1],
    [2, 2, 4],
    [3, 3, 9],
    [4, 1, 4],
  ])("a %ix%i grid is %i points", (cols, rows, expected) => {
    expect(probe.gridPoints(rect(0, 0, 100, 100), cols, rows)).toHaveLength(
      expected,
    );
  });

  it("keeps every point strictly inside the rect, never on an edge", () => {
    const box = rect(10, 20, 44, 44);

    for (const point of probe.gridPoints(box, 3, 3)) {
      expect(point.x).toBeGreaterThan(box.left);
      expect(point.x).toBeLessThan(box.left + box.width);
      expect(point.y).toBeGreaterThan(box.top);
      expect(point.y).toBeLessThan(box.top + box.height);
    }
  });

  it("puts a 1x1 grid at the centre, which is the reading SCRUM-476 got wrong", () => {
    expect(probe.gridPoints(rect(0, 0, 100, 40), 1, 1)).toEqual([
      { x: 50, y: 20, col: 0, row: 0 },
    ]);
  });
});

describe("isPointInViewport", () => {
  const viewport = { width: 375, height: 812 };

  it.each([
    ["the origin", 0, 0, true],
    ["inside", 100, 400, true],
    ["the last addressable column", 374.9, 811.9, true],
    ["exactly the width", 375, 400, false],
    ["exactly the height", 100, 812, false],
    ["negative x, a control scrolled off the left", -1, 400, false],
    ["negative y, a control scrolled above the fold", 100, -0.5, false],
    ["both past the far corner", 400, 900, false],
  ])("%s is %s", (_label, x, y, expected) => {
    expect(probe.isPointInViewport({ x, y }, viewport)).toBe(expected);
  });
});

describe("plannedProbePoints", () => {
  const viewport = { width: 375, height: 812 };

  it("keeps every point of an on-screen rect", () => {
    const planned = probe.plannedProbePoints(rect(10, 10, 100, 44), viewport);

    expect(planned.points).toHaveLength(9);
    expect(planned.skipped).toHaveLength(0);
    expect(planned.measurable).toBe(true);
  });

  it("splits a rect hanging off the right edge", () => {
    /* 300 to 460 across a 375 viewport: the left column's centre is at 320 and
       inside, the middle at 380 and the right at 440 are not. */
    const planned = probe.plannedProbePoints(rect(300, 10, 160, 44), viewport);

    expect(planned.points).toHaveLength(3);
    expect(planned.skipped).toHaveLength(6);
    expect(planned.measurable).toBe(true);
    expect(planned.points.every((point) => point.col === 0)).toBe(true);
  });

  it("reports a fully off-screen rect as not measurable rather than as empty", () => {
    const planned = probe.plannedProbePoints(rect(0, 900, 100, 44), viewport);

    expect(planned.points).toHaveLength(0);
    expect(planned.skipped).toHaveLength(9);
    /* The distinction this whole guard exists for: nine points that could not
       be asked is not the same answer as nine points that found nothing. */
    expect(planned.measurable).toBe(false);
  });
});

describe("intersectionArea", () => {
  it.each([
    ["identical rects", rect(0, 0, 10, 10), rect(0, 0, 10, 10), 100],
    ["a quarter overlap", rect(0, 0, 10, 10), rect(5, 5, 10, 10), 25],
    ["one inside the other", rect(0, 0, 10, 10), rect(2, 2, 4, 4), 16],
    ["disjoint horizontally", rect(0, 0, 10, 10), rect(20, 0, 10, 10), 0],
    ["disjoint vertically", rect(0, 0, 10, 10), rect(0, 20, 10, 10), 0],
    [
      "edge to edge, touching but not overlapping",
      rect(0, 0, 10, 10),
      rect(10, 0, 10, 10),
      0,
    ],
    ["a zero-width rect", rect(0, 0, 0, 10), rect(0, 0, 10, 10), 0],
    ["a band across the middle", rect(0, 0, 10, 10), rect(-5, 4, 20, 2), 20],
  ])("%s", (_label, a, b, expected) => {
    expect(probe.intersectionArea(a, b)).toBe(expected);
    /* Symmetric, unlike overlapFraction below. Asserted rather than assumed,
       because the two functions differing in that respect is the trap. */
    expect(probe.intersectionArea(b, a)).toBe(expected);
  });
});

describe("overlapFraction", () => {
  it("is the share of the target, not of the other or of the union", () => {
    const target = rect(0, 0, 10, 10);
    const other = rect(0, 0, 5, 10);

    expect(probe.overlapFraction(target, other)).toBe(0.5);
    /* Same two rects the other way round: the small one is wholly covered. This
       asymmetry is the point - the question is always "what share of the
       footprint my finger pressed". */
    expect(probe.overlapFraction(other, target)).toBe(1);
  });

  it.each([
    ["no contact", rect(0, 0, 44, 44), rect(100, 100, 44, 44), 0],
    ["fully covered", rect(0, 0, 44, 44), rect(-10, -10, 100, 100), 1],
    [
      "the left third, the SCRUM-476 shape",
      rect(0, 0, 90, 30),
      rect(0, 0, 30, 30),
      1 / 3,
    ],
  ])("%s gives %f", (_label, target, other, expected) => {
    expect(probe.overlapFraction(target, other)).toBeCloseTo(expected, 10);
  });

  it("returns 0 for a target with no area instead of dividing by zero", () => {
    expect(probe.overlapFraction(rect(5, 5, 0, 0), rect(0, 0, 10, 10))).toBe(0);
  });
});

describe("measureBox", () => {
  it("reports content size with the element's own padding removed", () => {
    const row = stubElement({
      probe: "row",
      box: rect(17, 25, 341, 73),
      clientHeight: 72,
      clientWidth: 341,
    });
    const env = stubEnv({
      elements: { "[data-probe='row']": row },
      padding: {
        paddingLeft: "8px",
        paddingRight: "8px",
        paddingTop: "12px",
        paddingBottom: "12px",
      },
    });

    const measured = probe.measureBox("[data-probe='row']", env);

    expect(measured.probe).toBe("row");
    /* The three sizes that are not the same question, and the numbers the real
       fixture produces: the rect carries divide-y's border pixel, clientHeight
       does not, and contentWidth is what a container chain predicts. */
    expect(measured.rect.height).toBe(73);
    expect(measured.clientHeight).toBe(72);
    expect(measured.clientWidth).toBe(341);
    expect(measured.contentWidth).toBe(325);
    expect(measured.contentHeight).toBe(48);
  });

  it("treats a missing padding value as zero rather than NaN", () => {
    const element = stubElement({ box: rect(0, 0, 44, 44) });
    const env = stubEnv({
      elements: { "#x": element },
      padding: { paddingLeft: "auto", paddingRight: "" },
    });

    expect(probe.measureBox("#x", env).contentWidth).toBe(44);
  });

  it("throws when the selector matches nothing, rather than reporting no measurement", () => {
    const env = stubEnv({ elements: {} });

    expect(() => probe.measureBox("[data-probe='gone']", env)).toThrow(
      /no element matches \[data-probe='gone'\]/,
    );
  });
});

describe("probeFootprint", () => {
  it("counts a press on the element itself and on its children as on target", () => {
    const label = stubElement({ tagName: "SPAN", probe: "label" });
    const trigger = stubElement({
      probe: "trigger",
      box: rect(100, 100, 90, 60),
      children: [label],
    });
    const env = stubEnv({
      elements: { "#trigger": trigger },
      /* The middle column returns the inner label, as a text node's parent
         would in a real browser. */
      at: (x: number) => (x > 140 && x < 160 ? label : trigger),
    });

    const result = probe.probeFootprint("#trigger", undefined, env);

    expect(result.probed).toBe(9);
    expect(result.onTarget).toBe(9);
    expect(result.reachable).toBe(true);
    expect(result.obstructedBy).toEqual([]);
  });

  it("names what is on top when something else answers", () => {
    const sheet = stubElement({
      tagName: "DIV",
      probe: "sheet",
      className: "fixed",
    });
    const trigger = stubElement({ probe: "trigger", box: rect(0, 0, 90, 30) });
    const env = stubEnv({
      elements: { "#trigger": trigger },
      /* Covers the left third only - the hazard SCRUM-476's single centre
         probe missed. */
      at: (x: number) => (x < 30 ? sheet : trigger),
    });

    const result = probe.probeFootprint("#trigger", { cols: 3, rows: 1 }, env);

    expect(result.probed).toBe(3);
    expect(result.onTarget).toBe(2);
    expect(result.reachable).toBe(false);
    expect(result.obstructedBy).toEqual([
      { probe: "sheet", tag: "div", className: "fixed" },
    ]);
    expect(result.points[0].onTarget).toBe(false);
    expect(result.points[1].onTarget).toBe(true);
  });

  it("never asks the document about a point outside the viewport", () => {
    const trigger = stubElement({
      probe: "trigger",
      box: rect(0, 900, 90, 30),
    });
    const asked: number[] = [];
    const env = stubEnv({
      elements: { "#trigger": trigger },
      viewport: { width: 375, height: 812 },
      at: (_x: number, y: number) => {
        asked.push(y);

        return trigger;
      },
    });

    const result = probe.probeFootprint("#trigger", undefined, env);

    /* The structural half of the guard. `elementFromPoint` returns null for an
       off-screen point, which is indistinguishable from "nothing is there" -
       so the off-screen points are never put to it at all. */
    expect(asked).toEqual([]);
    expect(result.measurable).toBe(false);
    expect(result.probed).toBe(0);
    expect(result.skippedOutsideViewport).toBe(9);
    /* And `reachable` is false for an unmeasurable element, not true-by-vacuum
       from "zero points failed". */
    expect(result.reachable).toBe(false);
  });

  it("reports a hit of null as an obstruction rather than as on target", () => {
    const trigger = stubElement({ probe: "trigger", box: rect(0, 0, 30, 30) });
    const env = stubEnv({
      elements: { "#trigger": trigger },
      at: () => null,
    });

    const result = probe.probeFootprint("#trigger", { cols: 1, rows: 1 }, env);

    expect(result.onTarget).toBe(0);
    expect(result.reachable).toBe(false);
    expect(result.obstructedBy).toEqual([null]);
  });
});

describe("report", () => {
  it("measures every named box and the footprint in one call", () => {
    const trigger = stubElement({ probe: "trigger", box: rect(0, 0, 90, 44) });
    const row = stubElement({ probe: "row", box: rect(0, 0, 341, 72) });
    const env = stubEnv({
      elements: { "#trigger": trigger, "#row": row },
      at: () => trigger,
    });

    const result = probe.report(
      { boxes: ["#trigger", "#row"], footprint: "#trigger" },
      env,
    );

    expect(result.viewport).toEqual({ width: 375, height: 812 });
    expect(result.boxes["#trigger"].clientHeight).toBe(44);
    expect(result.boxes["#row"].clientHeight).toBe(72);
    expect(result.footprint && result.footprint.probed).toBe(9);
  });

  it("computes each `against` element's share of the footprint", () => {
    const trigger = stubElement({ probe: "trigger", box: rect(0, 0, 100, 40) });
    const confirm = stubElement({ probe: "confirm", box: rect(0, 0, 50, 40) });
    const env = stubEnv({
      elements: { "#trigger": trigger, "#confirm": confirm },
      at: () => trigger,
    });

    const result = probe.report(
      { boxes: [], footprint: "#trigger", against: ["#confirm"] },
      env,
    );

    expect(result.overlaps["#confirm"]).toBe(0.5);
  });

  it("does nothing with a footprint it was not given", () => {
    const env = stubEnv({ elements: {} });

    const result = probe.report({}, env);

    expect(result.footprint).toBeNull();
    expect(result.boxes).toEqual({});
    expect(result.overlaps).toEqual({});
  });
});
