#!/usr/bin/env node
"use strict";

/**
 * Page-route hygiene check (SCRUM-269).
 *
 * Under src/pages/ a filename is also a URL. Next's default `pageExtensions`
 * is ["tsx", "ts", "jsx", "js"], so a co-located `auth.test.ts` is not a test
 * as far as Next is concerned - it is the route `/api/pusher/auth.test`, and
 * it gets compiled and shipped. That is exactly what happened in SCRUM-224:
 * the suite was built into .next/server/pages/api/pusher/auth.test.js, listed
 * in pages-manifest.json, and deployed.
 *
 * Nothing caught it. `next build` compiles the file happily, `yarn test` reads
 * source and never looks at the route table, and `yarn lint` has no opinion
 * about filenames. The repository convention of co-locating `*.test.ts` next
 * to its module is right everywhere else, which is what makes this a trap
 * rather than an obvious mistake.
 *
 * Two checks, because they fail at different times:
 *
 *   1. (default) Source scan. No build required, so it can gate a PR in
 *      milliseconds and name the offending file directly.
 *   2. `--manifest` additionally reads the build output and asserts no emitted
 *      route looks like a test. This is the property that actually matters,
 *      verified against the real artifact rather than inferred from filenames.
 *
 * Usage:
 *   node scripts/check-page-routes.js               # source scan only
 *   node scripts/check-page-routes.js --manifest    # also check build output
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "src", "pages");
const NEXT_CONFIG = path.join(ROOT, "next.config.js");
const MANIFESTS = [
  path.join(ROOT, ".next", "server", "pages-manifest.json"),
  path.join(ROOT, ".next", "server", "app-paths-manifest.json"),
];

/** Next's default when next.config.js does not override `pageExtensions`. */
const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/** `foo.test.ts`, `foo.spec.tsx`, and the bare `test.ts` / `spec.ts` forms. */
const TEST_FILE = /(^|\.)(test|spec)\./;

/** A route whose last segment ends in `.test` or `.spec`. */
const TEST_ROUTE = /\.(test|spec)\b/;

/**
 * Tripwire. If src/pages is restructured this check could silently start
 * scanning nothing and pass forever. Refuse to run a check that weak rather
 * than provide false assurance.
 */
const MIN_EXPECTED_PAGES = 5;

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(2);
}

/**
 * Read the extension list Next will actually use. Reading the real config
 * rather than assuming the default means that adopting the `page.tsx`
 * convention later makes this check correctly relax instead of lying.
 *
 * @returns {string[]}
 */
function pageExtensions() {
  if (!fs.existsSync(NEXT_CONFIG)) {
    // A different config format (.mjs, .ts) would need its own loader. Fall
    // back to the default list and say so, rather than skipping the check.
    console.log(
      "next.config.js not found; assuming Next's default pageExtensions",
    );
    return DEFAULT_PAGE_EXTENSIONS;
  }

  // Safe to execute: next.config.js in this repo is a plain object literal
  // with no imports and no side effects.
  const config = require(NEXT_CONFIG);
  const configured = config && config.pageExtensions;

  if (configured === undefined) {
    return DEFAULT_PAGE_EXTENSIONS;
  }

  if (
    !Array.isArray(configured) ||
    configured.some((e) => typeof e !== "string")
  ) {
    fail("next.config.js sets a pageExtensions value that is not a string[]");
  }

  return configured;
}

/**
 * @returns {string[]} repo-relative paths of every file under src/pages that
 *   Next will compile into a route
 */
function pageFiles(extensions) {
  if (!fs.existsSync(PAGES_DIR)) {
    fail(
      "src/pages not found. This check exists to police the Pages Router " +
        "directory, so scripts/check-page-routes.js needs updating.",
    );
  }

  const found = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(`.${ext}`))) {
        found.push(path.relative(ROOT, full));
      }
    }
  };

  walk(PAGES_DIR);

  if (found.length < MIN_EXPECTED_PAGES) {
    fail(
      `only ${found.length} page file(s) found under src/pages, expected at ` +
        `least ${MIN_EXPECTED_PAGES}. Refusing to run a check this weak.`,
    );
  }

  return found;
}

/**
 * @returns {string[]} route paths emitted by the last build
 */
function builtRoutes() {
  const present = MANIFESTS.filter((file) => fs.existsSync(file));

  if (present.length === 0) {
    fail(
      "--manifest was passed but no build output was found. Run `yarn build` " +
        "first, or drop the flag to run the source scan alone.",
    );
  }

  const routes = [];
  for (const file of present) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    routes.push(...Object.keys(manifest));
  }
  return routes;
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--manifest"].includes(arg));
  if (unknown.length) {
    fail(`unknown argument(s): ${unknown.join(", ")}`);
  }

  const extensions = pageExtensions();
  const pages = pageFiles(extensions);
  const offenders = pages.filter((file) => TEST_FILE.test(path.basename(file)));

  console.log(
    `${pages.length} file(s) under src/pages match pageExtensions ` +
      `[${extensions.join(", ")}]`,
  );

  if (offenders.length) {
    console.error(
      `\n✖ ${offenders.length} test file(s) under src/pages would be ` +
        `compiled into routes:`,
    );
    for (const file of offenders) {
      console.error(`    ${file}`);
    }
    console.error(
      "\nMove them out of src/pages and import the handler instead - see " +
        "src/server/pusherAuthEndpoint.test.ts. Under the Pages Router a " +
        "filename is a URL, so a co-located test ships as an endpoint.",
    );
    process.exit(1);
  }

  console.log("✔ no test files under src/pages");

  if (args.includes("--manifest")) {
    const routes = builtRoutes();
    const badRoutes = routes.filter((route) => TEST_ROUTE.test(route));

    console.log(`${routes.length} route(s) in the build manifest`);

    if (badRoutes.length) {
      console.error(
        `\n✖ ${badRoutes.length} emitted route(s) look like tests:`,
      );
      for (const route of badRoutes) {
        console.error(`    ${route}`);
      }
      process.exit(1);
    }

    console.log("✔ no test routes in the build manifest");
  }
}

main();
