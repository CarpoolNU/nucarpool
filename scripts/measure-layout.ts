/**
 * Serve a layout fixture against this project's own compiled stylesheet, so a
 * real browser can measure it.
 *
 *   npx ts-node scripts/measure-layout.ts                                  # list fixtures
 *   npx ts-node scripts/measure-layout.ts group-member-card-trigger        # serve one
 *   npx ts-node scripts/measure-layout.ts group-member-card-trigger --width 320
 *
 * This is the harness SCRUM-481 committed. Eight tickets needed a real pixel,
 * hand-rolled the same four steps in their own session, and threw them away
 * (SCRUM-421, 432, 456, 458, 467, 474, 476, 480). The recipe was identical
 * every time and is now here instead of in ticket prose.
 *
 * **It touches no database.** Every other `.ts` script in this directory does;
 * this one reads two files and opens a local socket. There is no `--apply`, it
 * writes nothing anywhere, and pointing it at any environment is meaningless
 * because it does not connect to one.
 *
 * ---
 *
 * **What it proves.** That this project's real Tailwind output, at a given
 * viewport width, gives a reproduction of a component's markup the box you
 * think it does. That is the half jsdom cannot do at all: jsdom resolves no CSS
 * and reports every rect as zero (see `src/testing/viewport.ts`).
 *
 * **What it does not prove.** Three things, and the third is the one that
 * matters:
 *
 *  1. It measures a *copy* of the markup, not the component. The copy is
 *     guarded - `measure-layout.test.ts` fails in `yarn test` when a fixture's
 *     class string is no longer in the file it claims - but a guarded copy is
 *     still a copy, and nothing checks the container chain above it except the
 *     predicted-width comparison this prints.
 *  2. It says nothing about a real device. No touch, no safe-area inset, no
 *     browser chrome, and no `dvh` behaviour as that chrome moves.
 *  3. **Nothing runs it.** It is not in `yarn test`, not in CI, and not
 *     scheduled. A criterion measured through this is measured once, by a
 *     human who chose to. The regression protection those tickets left behind
 *     is still their class-name assertions, which are proxies and say so.
 *     Making this durable means a browser in CI, which means a new dev
 *     dependency - deliberately not done here (SCRUM-481 settles that in a
 *     comment) and not smuggled in later.
 *
 * ---
 *
 * **Why not `next build`.** The stylesheet is compiled by driving
 * `@tailwindcss/postcss` over `src/styles/globals.css` directly, which takes
 * about 200ms, needs no `.env` and writes no `.next`. It is the same plugin
 * `postcss.config.js` gives Next, over the same entry point, with the same
 * `@config` and the same repo-wide scan, so the emitted CSS is the build's.
 * Going via `next build` instead costs a minute, requires a populated `.env`
 * that a fresh worktree does not have, and adds a cache that has to be wiped
 * between runs or a scan-input change reads as no change at all.
 *
 * **Why the port is not fixed.** `server.listen(0)` asks the OS for a free
 * one. Concurrent sessions each hold ad-hoc local servers, and a hard-coded
 * port either collides - which presents as a 404 or as someone else's page,
 * neither of which looks like a port problem - or tempts a `pkill` that kills
 * another session's server. An OS-assigned port cannot collide.
 *
 * **Why HTTP at all, rather than opening the file.** Playwright refuses
 * `file:` URLs.
 */

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  buildFixturePage,
  describeContainerWidth,
  findFixture,
  LAYOUT_FIXTURES,
  LayoutFixture,
} from "../src/testing/layoutFixtures";

/** The repository root, from this file's location rather than `cwd`. */
export const REPO_ROOT = path.resolve(__dirname, "..");

export const STYLESHEET_ENTRY = path.join(
  REPO_ROOT,
  "src",
  "styles",
  "globals.css",
);

export const PROBE_SOURCE = path.join(
  REPO_ROOT,
  "src",
  "testing",
  "layoutProbe.js",
);

export interface Options {
  readonly fixture?: string;
  readonly width?: number;
  readonly host: string;
}

/**
 * `--width` overrides the fixture's recorded width, which is how a criterion
 * stated across a breakpoint band gets checked at both ends (SCRUM-456/458 did
 * that by hand). A width the fixture did not record is reported as such in the
 * banner, so a figure taken at one width is not read as the recorded one.
 */
export const parseArgs = (argv: readonly string[]): Options => {
  let fixture: string | undefined;
  let width: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--width") {
      const value = Number(argv[index + 1]);

      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `--width needs a positive number, got "${argv[index + 1]}"`,
        );
      }

      width = value;
      index += 1;
    } else if (arg.startsWith("--width=")) {
      const value = Number(arg.slice("--width=".length));

      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--width needs a positive number, got "${arg}"`);
      }

      width = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    } else if (fixture === undefined) {
      fixture = arg;
    } else {
      throw new Error(
        `Only one fixture at a time; got "${fixture}" and "${arg}"`,
      );
    }
  }

  return { fixture, width, host: "127.0.0.1" };
};

/**
 * Compile `globals.css` the way the build does.
 *
 * `from` is the real path on disk and not a placeholder: the `@config
 * "../../tailwind.config.js"` line in that file resolves relative to it, and
 * so does the repo-wide scan's root. Hand it a temp path and the theme silently
 * reverts to Tailwind's defaults - `screens` included, which is the one thing a
 * mobile measurement cannot afford to get wrong.
 *
 * A fresh plugin instance per call, because the caller recompiles on every
 * request so that editing a fixture's markup and refreshing emits the utility
 * the edit just introduced.
 *
 * **Both imports are inside the function, and moving either to module scope
 * breaks `yarn test`.** `@tailwindcss/postcss` calls `module.registerHooks()`
 * while being loaded, and Jest refuses that outright - the hooks would attach
 * to the loader running Jest rather than to the sandbox test code uses, and
 * would persist for every later file in the worker. Imported at module scope,
 * merely importing *this file* from `measure-layout.test.ts` throws during
 * module load, so the suite does not fail: it never runs, and `yarn test`
 * reports the tests that remain as passing. `jest.shared.config.js` documents
 * that same silent-loss shape at length for ESM-only dependencies. Here the
 * compiler is only needed when something is actually being compiled, so a lazy
 * import costs nothing and keeps the file testable.
 */
export const compileStylesheet = async (): Promise<string> => {
  const [{ default: postcss }, { default: tailwindcss }] = await Promise.all([
    import("postcss"),
    import("@tailwindcss/postcss"),
  ]);

  const source = fs.readFileSync(STYLESHEET_ENTRY, "utf8");
  const result = await postcss([tailwindcss()]).process(source, {
    from: STYLESHEET_ENTRY,
    to: path.join(REPO_ROOT, "measure-layout.css"),
  });

  return result.css;
};

const CONTENT_TYPES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/probe.js": "text/javascript; charset=utf-8",
};

/**
 * Three routes, nothing on disk.
 *
 * The page is built in memory and the probe is read from `src/testing/` on
 * every request, so there is no copy of either to go stale and no temp
 * directory to clean up. `.playwright-mcp/` - where the driver writes
 * screenshots - is the only thing a measurement leaves behind, and it is
 * gitignored (SCRUM-461, then SCRUM-473 for the same debris a second time).
 */
export const createFixtureServer = (
  fixture: LayoutFixture,
  compile: () => Promise<string>,
): http.Server =>
  http.createServer((request, response) => {
    const route = (request.url || "/").split("?")[0];

    const send = (body: string) => {
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[route],
        "Cache-Control": "no-store",
      });
      response.end(body);
    };

    if (route === "/") {
      send(buildFixturePage(fixture));
      return;
    }

    if (route === "/probe.js") {
      send(fs.readFileSync(PROBE_SOURCE, "utf8"));
      return;
    }

    /* 204 rather than a 404, so the console stays empty. The browser asks for
       this unprompted, and an error in the console of a measurement page
       should mean something - a stylesheet that failed to compile presents as
       an unstyled page, which measures as a very small control and reads as a
       finding. One habitual 404 is how that gets scrolled past. */
    if (route === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (route === "/styles.css") {
      compile().then(send, (error: Error) => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(`Tailwind compile failed: ${error.message}`);
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end(
      `No route ${route}. This server has /, /styles.css, /probe.js.`,
    );
  });

/** The `browser_evaluate` body to paste, built from the fixture's own spec. */
export const probeSnippet = (fixture: LayoutFixture): string => {
  const spec = JSON.stringify(fixture.probe, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `    ${line}`))
    .join("\n");

  return `() => window.__nucarpoolLayoutProbe.report(${spec})`;
};

export const banner = (
  fixture: LayoutFixture,
  url: string,
  width: number,
  cssBytes: number,
): string => {
  const recordedWidth = width === fixture.viewportWidth;

  return [
    ``,
    `  ${fixture.name}`,
    `  ${fixture.summary}`,
    ``,
    `  copied from   ${fixture.source}`,
    `  criterion     ${fixture.issue}`,
    `  url           ${url}`,
    `  width         ${width}px${
      recordedWidth
        ? ""
        : `  (recorded at ${fixture.viewportWidth}px, not this)`
    }`,
    `  stylesheet    ${cssBytes} bytes, compiled from src/styles/globals.css`,
    ``,
    `  predicted contentWidth of ${fixture.widthProbe}:`,
    `    ${describeContainerWidth(width, fixture.insets)}`,
    `  Check that against the measured contentWidth of that same box before`,
    `  reading anything else. If they disagree the fixture's container chain is`,
    `  wrong, and every figure under it is wrong with it. Note it is contentWidth`,
    `  and not clientWidth: the last inset is the box's own padding.`,
    ``,
    `  1. Open the url, resized to ${width} wide.`,
    `  2. Evaluate:`,
    ``,
    `  ${probeSnippet(fixture)}`,
    ``,
    `  What ${fixture.issue} recorded:`,
    ...fixture.recorded.map((line) => `    - ${line}`),
    ``,
    `  A screenshot lands in .playwright-mcp/, which is gitignored. Leave it there.`,
    `  Ctrl-C to stop.`,
    ``,
  ].join("\n");
};

export const fixtureList = (): string =>
  [
    ``,
    `  Layout fixtures:`,
    ``,
    ...LAYOUT_FIXTURES.map(
      (fixture) =>
        `    ${fixture.name}\n      ${fixture.summary}\n      ${fixture.issue}, from ${fixture.source}`,
    ),
    ``,
    `  npx ts-node scripts/measure-layout.ts <name> [--width <px>]`,
    ``,
  ].join("\n");

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));

  if (!options.fixture) {
    process.stdout.write(fixtureList());
    return;
  }

  const fixture = findFixture(options.fixture);

  if (!fixture) {
    process.stderr.write(
      `\n  No fixture named "${options.fixture}".\n${fixtureList()}`,
    );
    process.exitCode = 1;
    return;
  }

  /* Compiled once here so a broken stylesheet fails now, with a stack, rather
     than as a 500 the browser shows as an unstyled page - which measures as a
     very small control and looks like a finding. */
  const css = await compileStylesheet();

  const server = createFixtureServer(fixture, compileStylesheet);

  await new Promise<void>((resolve) => {
    server.listen(0, options.host, resolve);
  });

  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const width = options.width || fixture.viewportWidth;

  process.stdout.write(
    banner(fixture, `http://${options.host}:${port}/`, width, css.length),
  );
};

if (require.main === module) {
  main().catch((error: Error) => {
    process.stderr.write(`\n  ${error.message}\n\n`);
    process.exitCode = 1;
  });
}
