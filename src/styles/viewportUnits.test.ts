import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import ts from "typescript";
import postcss from "postcss";

/**
 * `src/` declares no `vh` length.
 *
 * The reasoning is `globals.css`'s and is not restated here: `vh` on a mobile
 * browser resolves against the *large* viewport - the height the page would
 * measure with the URL bar and toolbar retracted - so anything sized in it
 * over-measures on exactly the devices where that chrome comes and goes. `dvh`
 * tracks the viewport instead, and every browser in Tailwind v4's baseline
 * supports it.
 *
 * This is a guard rather than a discovery. The sites were converted one at a
 * time, and the last applied `vh` in the tree - the map connect portal's
 * desktop height budget - went with SCRUM-483. What this prevents is the next
 * one arriving, which nothing else would notice: a `vh` length is valid CSS and
 * valid Tailwind, it type-checks, it lints, and **jsdom resolves no viewport
 * units at all**, so no component test can see one either.
 *
 * ## Why this reads the syntax tree instead of grepping
 *
 * Because the documentation would be the first thing a grep reported. Four of
 * the five `vh` occurrences under `src/` when this was written were prose
 * *about* the unit, three of them explaining why it is not used - and those
 * comments cannot be reworded around the problem, since saying the word is why
 * they exist.
 *
 * Stripping comments first was the obvious answer and the wrong one. A regex
 * that removes `//` to end of line also eats the rest of any line holding a
 * `https://` URL, and TypeScript's own *scanner*, tried next, mis-tokenizes
 * `.tsx`: run over `setupNavigationPlacement.test.tsx` it returned the `"85vh"`
 * inside a block comment as a string literal, because raw scanning cannot tell
 * JSX text from code and desynchronises.
 *
 * So the files are parsed, and only string and template literals are examined.
 * A comment is not a node in a syntax tree, which makes it excluded by
 * construction rather than by pattern - there is nothing left to get wrong.
 * postcss does the same job for stylesheets, where a comment is its own node.
 *
 * ## What this cannot see
 *
 * Spellings only - but one of the two gaps this used to record is now closed.
 *
 * **The height utilities named after the viewport are the closed one.** They
 * compile to a `100vh` length while the source never says `vh`, so the literal
 * walk above cannot see them: SCRUM-483 left exactly one, on a div in
 * `src/pages/index.tsx`, as a known exemption for SCRUM-477's phase 4.
 * SCRUM-485 measured it inert - the div is a child of a `100dvh` `#__next`, and
 * the dynamic viewport is never larger than the large one - removed it, and
 * added `VIEWPORT_HEIGHT_ALIAS` below so the next one is rejected at source.
 *
 * That check is a spelling too, which is the point: catching aliases *by their
 * output* would mean asserting against the compiled stylesheet and putting a
 * Tailwind compile in the middle of every CI run. Matching the three class
 * names that produce the unit costs nothing and covers the way one would
 * actually arrive.
 *
 * **A unit glued on at runtime is the gap that remains.** A template literal
 * interpolating the number slips through, since no single literal then holds
 * both digit and unit. That shape is already discouraged for class names, for
 * the reason `tailwind.config.js` gives: the scanner cannot see a composed name
 * either, so it emits no CSS.
 */

const SRC = join(__dirname, "..");

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

const STYLE_EXTENSIONS = [".css"];

/**
 * A `vh` length, and nothing else.
 *
 * The digit before the unit is load-bearing in both directions. It is what
 * makes `100vh` match, and it is what keeps the units this project actually
 * wants - `dvh`, and `svh` and `lvh` with it - from matching, since each has a
 * letter in that position. A bare `vh` pattern would flag the correct unit as
 * the defect.
 */
const VH_LENGTH = /\d(?:\.\d+)?vh\b/;

/**
 * The height utilities Tailwind names after the viewport, which are `vh`
 * lengths under another name.
 *
 * All three compile to `100vh` - as a height, a floor and a ceiling - so each
 * is the thing `VH_LENGTH` exists to reject, written in a way it cannot see.
 * The width member of the same family is deliberately absent: it compiles to
 * `100vw`, and `globals.css` uses that unit on `#__next` on purpose.
 *
 * **Assembled from a token rather than written out, and that is mandatory
 * rather than tidy.** Tailwind v4 scans this file like any other under `src/`,
 * so spelling one of these names here - in a pattern, in a fixture or in a
 * comment - emits its declaration into the bundle every user downloads, which
 * is precisely the byte this guard exists to keep out. The alternation below
 * therefore never contains the whole name, and neither does any prose in this
 * file. `layoutFixtures.ts` and `index.tsx` keep the same discipline.
 *
 * The `\b` on each side matters: without the leading one this would also match
 * a project utility that merely ends in the same token, and there is no reason
 * to assume none will ever be added.
 */
const VIEWPORT_TOKEN = "screen";

const VIEWPORT_HEIGHT_ALIAS = new RegExp(
  `\\b(?:h|min-h|max-h)-${VIEWPORT_TOKEN}\\b`,
);

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

/**
 * `file:line` for every string or template literal holding a `vh` length.
 *
 * Takes the source rather than reading it, so the control cases below can
 * exercise the same code path on a fixture without putting a file on disk -
 * which in this repository would mean putting its class names in the CSS
 * bundle.
 */
const scriptHitsIn = (
  path: string,
  kind: ts.ScriptKind,
  source: string,
  pattern: RegExp = VH_LENGTH,
): string[] => {
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    kind,
  );

  const hits: string[] = [];

  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail;

    if (isLiteral && pattern.test((node as ts.LiteralLikeNode).text)) {
      const { line } = parsed.getLineAndCharacterOfPosition(
        node.getStart(parsed),
      );
      hits.push(`${label(path)}:${line + 1}`);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return hits;
};

/** The same, for a stylesheet: declarations and at-rule parameters. */
const styleHitsIn = (
  path: string,
  source: string,
  pattern: RegExp = VH_LENGTH,
): string[] => {
  const root = postcss.parse(source, { from: path });
  const hits: string[] = [];

  root.walkDecls((decl) => {
    if (pattern.test(decl.value)) {
      hits.push(`${label(path)}:${decl.source?.start?.line ?? 0}`);
    }
  });
  /* At-rule params are where an alias would turn up in CSS - an `@apply` of
     one of the utilities `VIEWPORT_HEIGHT_ALIAS` matches. Declarations are
     checked for it too, at no cost, rather than reasoning about which half of
     a stylesheet could hold it. */
  root.walkAtRules((at) => {
    if (pattern.test(at.params)) {
      hits.push(`${label(path)}:${at.source?.start?.line ?? 0}`);
    }
  });

  return hits;
};

const label = (path: string): string =>
  relative(SRC, path).split(sep).join("/");

const scannableFiles = (): string[] =>
  filesUnder(SRC).filter((path) => {
    const ext = extensionOf(path);
    return ext in SCRIPT_KINDS || STYLE_EXTENSIONS.includes(ext);
  });

const matchesUnder = (pattern: RegExp): string[] =>
  scannableFiles().flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const kind = SCRIPT_KINDS[extensionOf(path)];
    return kind === undefined
      ? styleHitsIn(path, source, pattern)
      : scriptHitsIn(path, kind, source, pattern);
  });

const appliedViewportHeights = (): string[] => matchesUnder(VH_LENGTH);

const viewportHeightAliases = (): string[] =>
  matchesUnder(VIEWPORT_HEIGHT_ALIAS);

/**
 * The detector's fixtures, assembled from a unit rather than written out.
 *
 * Not a stylistic choice. **Tailwind v4 scans the whole repository**, so a real
 * class name written here - fixture or not, test file or not - is emitted into
 * the bundle as live CSS, and a fixture spelling the budget SCRUM-483 removed
 * would have quietly put it back. Composing it leaves no candidate for the
 * scanner to find, and keeps this file out of its own results: no literal in it
 * holds a digit and a unit next to each other.
 *
 * `zz-h-` is likewise a deliberate non-utility. The bracket syntax is what the
 * matcher has to cope with; matching a real utility is not.
 */
const arbitraryValue = (unit: string): string => `zz-h-[calc(100${unit}-2rem)]`;
const declaration = (unit: string): string => `a { height: 100${unit}; }`;

/**
 * An alias fixture, composed for the same reason as the two above: the whole
 * class name must never appear as a literal in this file.
 *
 * `prefix` is passed in so the controls can exercise all three real prefixes
 * and a near-miss, without any call site spelling a complete utility.
 */
const alias = (prefix: string): string =>
  `flex ${prefix}-${VIEWPORT_TOKEN} w-full`;

describe("the `vh` detector", () => {
  /*
   * The guard below passes by finding nothing, which is also what it does when
   * it is broken. These are the control: the reason to read a green run as
   * "the tree is clean" rather than "the walk returned nothing".
   */

  it.each([
    ["vh", true],
    ["dvh", false],
    ["svh", false],
    ["lvh", false],
  ])(
    "treats a %s length in a script literal as applied: %s",
    (unit, flagged) => {
      expect(VH_LENGTH.test(arbitraryValue(unit))).toBe(flagged);
    },
  );

  it.each([
    ["vh", true],
    ["dvh", false],
  ])(
    "treats a %s declaration in a stylesheet as applied: %s",
    (unit, flagged) => {
      expect(VH_LENGTH.test(declaration(unit))).toBe(flagged);
    },
  );

  it("reports a script literal, with the line it is on", () => {
    const fixture = join(SRC, "testing", "__vh_fixture__.tsx");
    const hits = scriptHitsIn(
      fixture,
      ts.ScriptKind.TSX,
      ["const a = 1;", `const b = "${arbitraryValue("vh")}";`].join("\n"),
    );

    expect(hits).toEqual(["testing/__vh_fixture__.tsx:2"]);
  });

  it("ignores one that only appears in prose", () => {
    // The case a grep gets wrong, and the reason this parses. Both comment
    // syntaxes, since the tree uses both, and a JSX body to desynchronise a
    // raw scanner the way the real tree did.
    const fixture = join(SRC, "testing", "__vh_fixture__.tsx");
    const hits = scriptHitsIn(
      fixture,
      ts.ScriptKind.TSX,
      [
        "const C = () => <p>it's a viewport</p>;",
        `/* ${arbitraryValue("vh")} used to sit here */`,
        `// and so did ${declaration("vh")}`,
        "export default C;",
      ].join("\n"),
    );

    expect(hits).toEqual([]);
  });

  it("ignores a stylesheet comment", () => {
    expect(
      styleHitsIn(
        "control.css",
        `/* ${declaration("vh")} */\na { color: red; }`,
      ),
    ).toEqual([]);
  });

  it("reports a stylesheet declaration", () => {
    expect(styleHitsIn("control.css", declaration("vh"))).toEqual([
      "../control.css:1",
    ]);
  });
});

describe("the viewport-height alias detector", () => {
  /*
   * The same control discipline as above, and needed more here: this detector
   * guards a spelling rather than a unit, so its whole value rests on the
   * alternation covering the names that actually compile to `100vh`.
   */

  it.each([
    ["h", true],
    ["min-h", true],
    ["max-h", true],
    /* The width member of the family compiles to `100vw`, which `globals.css`
       uses on `#__next` deliberately. Flagging it would report a decision as a
       defect. */
    ["w", false],
    ["max-w", false],
    /* A project utility that merely ends in the same token is not an alias.
       None exists today; the leading `\b` is what keeps that true if one is
       added. */
    ["zz-h-off", false],
  ])("treats a %s- prefix as an alias: %s", (prefix, flagged) => {
    expect(VIEWPORT_HEIGHT_ALIAS.test(alias(prefix))).toBe(flagged);
  });

  it("reports an alias in a class literal, with the line it is on", () => {
    const fixture = join(SRC, "testing", "__alias_fixture__.tsx");
    const hits = scriptHitsIn(
      fixture,
      ts.ScriptKind.TSX,
      ["const a = 1;", `const b = "${alias("max-h")}";`].join("\n"),
      VIEWPORT_HEIGHT_ALIAS,
    );

    expect(hits).toEqual(["testing/__alias_fixture__.tsx:2"]);
  });

  it("ignores an alias that only appears in prose", () => {
    // The reason `index.tsx` describes the utility it removed instead of
    // naming it: a comment mentioning the name would emit the declaration.
    // The detector must not report that comment as the violation.
    const fixture = join(SRC, "testing", "__alias_fixture__.tsx");
    const hits = scriptHitsIn(
      fixture,
      ts.ScriptKind.TSX,
      [
        "const C = () => <p>it's a viewport</p>;",
        `/* ${alias("max-h")} used to sit here */`,
        "export default C;",
      ].join("\n"),
    );

    expect(hits).toEqual([]);
  });

  it("reports an alias applied through @apply in a stylesheet", () => {
    expect(
      styleHitsIn(
        "control.css",
        `a { @apply ${alias("min-h")}; }`,
        VIEWPORT_HEIGHT_ALIAS,
      ),
    ).toEqual(["../control.css:1"]);
  });
});

describe("applied viewport units in src/", () => {
  it("declares no `vh` length anywhere", () => {
    // `dvh` is the unit. The one height budget that used to be spelled in `vh`
    // is now a named token in `tailwind.config.js`, under `maxHeight`.
    expect(appliedViewportHeights()).toEqual([]);
  });

  it("names no viewport-height alias anywhere", () => {
    /* The gap the docblock used to record as open. One of these was live on a
       div in `src/pages/index.tsx` until SCRUM-485 measured it inert and
       removed it - it compiled to the only `100vh` left in the bundle, while
       the assertion above saw nothing, because the source named the viewport
       and not the unit. Use a `dvh` token from `tailwind.config.js` instead of
       reaching for one of these. */
    expect(viewportHeightAliases()).toEqual([]);
  });

  it("scanned the tree it claims to have scanned", () => {
    // Guards the guard against its likelier failure: a walk that finds nothing,
    // or an extension list that stops matching. Either makes the assertion
    // above vacuous rather than false.
    const scanned = scannableFiles();

    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned).toContain(join(SRC, "styles", "globals.css"));
    expect(scanned).toContain(
      join(SRC, "components", "Map", "MapConnectPortal.tsx"),
    );
    expect(scanned).toContain(join(SRC, "utils", "breakpoints.js"));
  });
});
