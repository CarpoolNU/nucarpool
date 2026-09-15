/**
 * The in-page half of the layout measurement harness.
 *
 * jsdom does no layout, so the layout half of every mobile finding has to be
 * measured in a real browser. Eight tickets did that and threw the harness
 * away each time (SCRUM-481 lists them). This is that harness, committed.
 * `scripts/measure-layout.ts` is the entry point; start there.
 *
 * ---
 *
 * **Why this file is plain JavaScript in a TypeScript repository.** It runs in
 * two places — inside the measured page, and inside `yarn test` — and it must
 * be the *same bytes* in both, or the arithmetic the unit tests cover is not
 * the arithmetic the browser ran. Two ways to get that were tried and
 * rejected:
 *
 *  - Serializing compiled TypeScript functions with `String(fn)` into the
 *    page. `tsconfig.json` sets `"target": "es2017"`, which is *below* the
 *    es2018 that made object spread native — so TypeScript rewrites `{ ...a }`
 *    into a call to an injected `__assign` helper that does not exist in the
 *    page. The function serializes cleanly, evaluates, and throws
 *    `__assign is not defined` at the first spread. Nothing in the type system
 *    warns you, and the failure is at measurement time.
 *  - Keeping two copies, one typed and one for the page. That is the drift this
 *    ticket exists to stop.
 *
 * So: one plain-JS file, loaded by `<script src="/probe.js">` in the browser
 * and by `require` in `layoutProbe.test.ts`, with a two-line footer that
 * publishes it to whichever of the two it finds. `src/testing/` already holds
 * plain-JS modules (`staticImageStub.js`, `mixpanelBrowserStub.js`), so this is
 * the directory's existing convention rather than a new one.
 *
 * **What this proves and what it does not.** It measures the page it is given.
 * That page is a *reproduction* of a component's markup, not the component -
 * see `layoutFixtures.ts`, which carries the drift guard for that. And nothing
 * runs this on a schedule: it makes a measurement fast, consistent and
 * repeatable, and it stops no regression by itself.
 */

/*
 * Every rect in this file is `{ left, top, width, height }`, in CSS pixels,
 * relative to the viewport - the same frame `getBoundingClientRect()` uses.
 *
 * `right` and `bottom` are derived rather than stored. A `DOMRect` carries all
 * six, and a hand-built rect in a test that sets `width` without updating
 * `right` is a silent lie; deriving them means there is one representation and
 * it cannot disagree with itself.
 */

/** @typedef {{ left: number, top: number, width: number, height: number }} Rect */
/** @typedef {{ width: number, height: number }} Viewport */
/** @typedef {{ x: number, y: number, col: number, row: number }} ProbePoint */

/**
 * Normalise anything rect-shaped - a `DOMRect`, a plain object - to the four
 * numbers above.
 */
function toRect(source) {
  return {
    left: source.left,
    top: source.top,
    width: source.width,
    height: source.height,
  };
}

function rectRight(rect) {
  return rect.left + rect.width;
}

function rectBottom(rect) {
  return rect.top + rect.height;
}

function rectArea(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/**
 * The points to press inside a control's footprint: a grid, never a centre.
 *
 * `cols` x `rows` cells over the rect, one point at the centre of each cell -
 * so the default 3x3 probes the centre of each third in both axes. A point
 * lands at `(col + 0.5) / cols` across, which keeps every point strictly
 * inside the rect and off its edges, where a 1px rounding difference decides
 * which element `elementFromPoint` returns.
 *
 * **This is the mistake SCRUM-476 made, and it is the reason there is no
 * `centre` option here.** That ticket measured the centre of a control, found
 * nothing overlapping it, and recorded the control as safe. The hazard was in
 * its left third. A single probe answers a question nobody asked: a finger is
 * about 9mm across and lands where it lands. Sampling the thirds is the
 * cheapest thing that would have caught it.
 */
function gridPoints(rect, cols, rows) {
  const columns = cols || 3;
  const lines = rows || 3;
  const points = [];

  for (let row = 0; row < lines; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      points.push({
        x: rect.left + (rect.width * (col + 0.5)) / columns,
        y: rect.top + (rect.height * (row + 0.5)) / lines,
        col: col,
        row: row,
      });
    }
  }

  return points;
}

/**
 * Whether a point is somewhere `elementFromPoint` can answer about.
 *
 * **The whole reason this function exists:** `document.elementFromPoint()`
 * returns `null` for any point outside the viewport, and `null` is exactly
 * what it returns for a point that hit nothing. So an off-screen probe reads
 * as "nothing is there" - the most reassuring possible answer - and a control
 * scrolled out of view measures as unobstructed.
 *
 * The bounds are half-open on purpose. A viewport 375 wide has addressable x
 * from 0 to 374.999...; `x === 375` is the first column of the next screen and
 * returns `null`.
 */
function isPointInViewport(point, viewport) {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < viewport.width &&
    point.y < viewport.height
  );
}

/**
 * The grid, split into the points worth asking about and the points that would
 * have lied.
 *
 * Callers get `points` and never see the rest, which is what makes the guard
 * above impossible to forget rather than merely documented: the DOM half of
 * this file is only ever handed the visible list.
 *
 * `measurable` is false when the guard removed *every* point. That is a
 * distinct outcome from "probed and found nothing", and conflating the two is
 * the same defect the guard prevents, one level up - so it is reported rather
 * than left for the reader to infer from an empty array.
 */
function plannedProbePoints(rect, viewport, cols, rows) {
  const all = gridPoints(rect, cols, rows);
  const points = [];
  const skipped = [];

  for (let i = 0; i < all.length; i += 1) {
    if (isPointInViewport(all[i], viewport)) {
      points.push(all[i]);
    } else {
      skipped.push(all[i]);
    }
  }

  return { points: points, skipped: skipped, measurable: points.length > 0 };
}

/**
 * Area of the overlap between two rects, in square CSS pixels. Zero when they
 * do not touch.
 */
function intersectionArea(a, b) {
  const left = Math.max(a.left, b.left);
  const right = Math.min(rectRight(a), rectRight(b));
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(rectBottom(a), rectBottom(b));

  if (right <= left || bottom <= top) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

/**
 * How much of `target` the `other` rect covers, as a fraction of `target`.
 *
 * Asymmetric deliberately: the question these tickets ask is "what share of
 * the footprint my finger just pressed does the new control now occupy", which
 * is relative to the footprint, not to the union or to the other control. The
 * figures SCRUM-476 and SCRUM-480 recorded as percentages are this number.
 *
 * A zero-area target returns 0 rather than dividing by zero - an element with
 * no box cannot have a share of itself covered.
 */
function overlapFraction(target, other) {
  const area = rectArea(target);

  if (area === 0) {
    return 0;
  }

  return intersectionArea(target, other) / area;
}

/*
 * Below here the functions touch the DOM.
 *
 * Each takes an optional `env` of `{ document, window }`. In the page it is
 * omitted and the globals are read at call time; the unit tests pass a stub,
 * which is how the not-found and off-screen paths are covered without a
 * browser. Resolving lazily inside the call rather than at module scope is
 * load-bearing - this file is required in Jest's `node` project, where neither
 * global exists at import time.
 */

function resolveEnv(env) {
  if (env) {
    return env;
  }

  return { document: document, window: window };
}

function viewportOf(env) {
  const resolved = resolveEnv(env);

  return {
    width: resolved.window.innerWidth,
    height: resolved.window.innerHeight,
  };
}

/**
 * A short, stable description of an element, for saying *what* a probe hit.
 *
 * `data-probe` first: the fixtures label the elements a measurement is about,
 * so a result reads `"trigger"` rather than a class soup. Falls back to the
 * tag and class list for anything unlabelled, which is usually the answer to
 * "then what is on top of it".
 */
function describeElement(element) {
  if (!element) {
    return null;
  }

  const probe = element.getAttribute
    ? element.getAttribute("data-probe")
    : null;

  return {
    probe: probe,
    tag: String(element.tagName || "").toLowerCase(),
    className: String(element.className || ""),
  };
}

/**
 * Measure one element, in the three widths and heights that are not the same
 * question.
 *
 * All three are reported because picking the wrong one is how a correct
 * measurement becomes a wrong answer, and each has caught something:
 *
 *  - **`rect`** is the border box, from `getBoundingClientRect()`. Fractional,
 *    and the only one of the three that is.
 *  - **`clientHeight`/`clientWidth`** exclude the border and include the
 *    padding, and are integers. **A tap-target criterion wants
 *    `clientHeight`.** A container with `divide-y` gives every child *but the
 *    last* a 1px bottom border in Tailwind v4, so such a row measures 73 by
 *    rect and 72 by `clientHeight` - SCRUM-480 had to explain that pixel to
 *    itself, and `layoutFixtures.ts` reproduces both a bordered and an
 *    unbordered row so the difference is observable rather than asserted.
 *  - **`contentWidth`/`contentHeight`** subtract the element's own padding, via
 *    `getComputedStyle`. This is the one a container chain predicts: a chain of
 *    insets down to a row leaves that row's *content* box, and comparing a
 *    predicted 325 against a `clientWidth` of 341 is off by exactly the row's
 *    own `px-2`. That mistake was made while building this and is the reason
 *    the figure is reported rather than derived by the reader.
 *
 * A missing selector throws rather than returning null. `querySelector`
 * returning null for a fixture whose markup drifted would otherwise flow into
 * the report as an absent measurement, and an absent measurement is read as a
 * passing one.
 */
function measureBox(selector, env) {
  const resolved = resolveEnv(env);
  const element = resolved.document.querySelector(selector);

  if (!element) {
    throw new Error(
      "layoutProbe: no element matches " +
        selector +
        ". The fixture markup and the selector disagree; nothing was measured.",
    );
  }

  const style = resolved.window.getComputedStyle(element);
  const padding = {
    left: parseFloat(style.paddingLeft) || 0,
    right: parseFloat(style.paddingRight) || 0,
    top: parseFloat(style.paddingTop) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
  };

  return {
    selector: selector,
    probe: describeElement(element).probe,
    rect: toRect(element.getBoundingClientRect()),
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    contentWidth: element.clientWidth - padding.left - padding.right,
    contentHeight: element.clientHeight - padding.top - padding.bottom,
    padding: padding,
  };
}

/**
 * Press a grid of points over one element's footprint and report what is under
 * each.
 *
 * `hit` is what `elementFromPoint` returned; `onTarget` is whether that is the
 * element itself or something inside it - a child label absorbing the press
 * still counts, because the event reaches the control either way.
 * `obstructedBy` collects the descriptions of everything that was on top
 * instead, which is the answer the caller actually wants.
 */
function probeFootprint(selector, options, env) {
  const resolved = resolveEnv(env);
  const settings = options || {};
  const target = resolved.document.querySelector(selector);

  if (!target) {
    throw new Error(
      "layoutProbe: no element matches " +
        selector +
        ". Nothing was probed; this is not a clean result.",
    );
  }

  const viewport = viewportOf(resolved);
  const rect = toRect(target.getBoundingClientRect());
  const planned = plannedProbePoints(
    rect,
    viewport,
    settings.cols,
    settings.rows,
  );

  const results = [];
  const obstructedBy = [];
  let onTargetCount = 0;

  for (let i = 0; i < planned.points.length; i += 1) {
    const point = planned.points[i];
    const hit = resolved.document.elementFromPoint(point.x, point.y);
    const onTarget = Boolean(hit) && (hit === target || target.contains(hit));

    if (onTarget) {
      onTargetCount += 1;
    } else {
      obstructedBy.push(describeElement(hit));
    }

    results.push({
      x: point.x,
      y: point.y,
      col: point.col,
      row: point.row,
      onTarget: onTarget,
      hit: describeElement(hit),
    });
  }

  return {
    selector: selector,
    rect: rect,
    clientHeight: target.clientHeight,
    viewport: viewport,
    measurable: planned.measurable,
    probed: planned.points.length,
    skippedOutsideViewport: planned.skipped.length,
    onTarget: onTargetCount,
    reachable: planned.measurable && onTargetCount === planned.points.length,
    obstructedBy: obstructedBy,
    points: results,
  };
}

/**
 * Everything a measurement needs, in one `browser_evaluate` round trip.
 *
 * `spec.boxes` names elements to measure, `spec.footprint` the one to
 * hit-test, and `spec.against` the elements whose share of that footprint to
 * compute - the SCRUM-476 question. One call rather than three because the
 * page is re-rendered between calls by nothing at all, but a human driving
 * this by hand pastes three times as much.
 */
function report(spec, env) {
  const resolved = resolveEnv(env);
  const settings = spec || {};
  const boxes = {};
  const names = settings.boxes || [];

  for (let i = 0; i < names.length; i += 1) {
    boxes[names[i]] = measureBox(names[i], resolved);
  }

  const output = {
    viewport: viewportOf(resolved),
    boxes: boxes,
    footprint: null,
    overlaps: {},
  };

  if (settings.footprint) {
    output.footprint = probeFootprint(
      settings.footprint,
      { cols: settings.cols, rows: settings.rows },
      resolved,
    );

    const against = settings.against || [];

    for (let i = 0; i < against.length; i += 1) {
      const other = measureBox(against[i], resolved);
      output.overlaps[against[i]] = overlapFraction(
        output.footprint.rect,
        other.rect,
      );
    }
  }

  return output;
}

const api = {
  toRect: toRect,
  rectRight: rectRight,
  rectBottom: rectBottom,
  rectArea: rectArea,
  gridPoints: gridPoints,
  isPointInViewport: isPointInViewport,
  plannedProbePoints: plannedProbePoints,
  intersectionArea: intersectionArea,
  overlapFraction: overlapFraction,
  describeElement: describeElement,
  measureBox: measureBox,
  probeFootprint: probeFootprint,
  report: report,
};

/* The two homes named in the header: `yarn test` requires it, the page loads
   it. Both guards are needed - neither environment has the other's global. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

if (typeof window !== "undefined") {
  window.__nucarpoolLayoutProbe = api;
}
