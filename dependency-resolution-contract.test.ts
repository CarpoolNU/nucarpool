import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, relative } from "path";

/**
 * A scoped `resolutions` entry and the top-level pin of the same package have
 * to agree, and the override has to be the copy that is actually installed.
 *
 * SCRUM-671 added `"next/postcss": "8.5.29"` because `next` declares `postcss`
 * as an *exact* dependency: without the override Yarn nests a second copy at
 * `node_modules/next/node_modules/postcss`, and that nested copy — not the
 * hoisted one — is what Next's CSS pipeline loads. Pinning the override
 * exactly is deliberate, so it can only ever resolve to a version someone
 * verified the compiled CSS against.
 *
 * The cost of pinning it exactly is that the two values drift independently.
 * Dependabot bumps the top-level `postcss` devDependency and has no reason to
 * touch `resolutions`, so the tree re-splits and every check stays green —
 * which is exactly what SCRUM-695 found in PR #561. Nothing was broken by it;
 * the point is that nothing *reported* it either.
 *
 * This file is that report. It fails on the Dependabot branch itself, which
 * turns a silent re-split into a one-line follow-up commit.
 *
 * Written against the `resolutions` block rather than against `postcss`, since
 * the same shape applies to any future `next` dependency that is both exact
 * and transitive. An entry whose key this cannot interpret fails loudly rather
 * than being skipped — a resolution that quietly checks nothing is the failure
 * mode this file exists to prevent.
 *
 * Checking under the parent alone proved too narrow. SCRUM-737 found PR #608
 * splitting postcss somewhere else: `@tailwindcss/postcss` widened its range,
 * and the regenerated lockfile resolved it to a fresh copy nested under
 * Tailwind's plugin instead of deduping onto the pin. Every assertion here
 * stayed green. Only `tsc` noticed, and only because one script happens to
 * hand Tailwind's plugin to the root postcss. So each overridden dependency
 * must also have exactly one installed copy, wherever a second would come
 * from.
 */

const repoRoot = __dirname;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
}

const manifest: Manifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);

/**
 * Split a `resolutions` key into the package that declares the dependency and
 * the dependency being overridden, allowing either to be scoped.
 *
 * Yarn Classic also accepts glob forms (`**\/pkg`, `a/**\/b`) and a bare
 * package name. None are in use here, and none state the "parent pins this
 * transitively" relationship this file checks, so they come back `null` and
 * the first test turns that into a failure.
 */
const parseResolutionKey = (
  key: string,
): { parent: string; dependency: string } | null => {
  const segments = key.split("/");

  // A scoped name spans two segments; an unscoped one, a single segment.
  const nameAt = (index: number): [string, number] =>
    segments[index]?.startsWith("@")
      ? [segments.slice(index, index + 2).join("/"), index + 2]
      : [segments[index] ?? "", index + 1];

  const [parent, afterParent] = nameAt(0);
  if (!parent || parent.includes("*") || afterParent >= segments.length) {
    return null;
  }

  const [dependency, afterDependency] = nameAt(afterParent);
  if (
    !dependency ||
    dependency.includes("*") ||
    afterDependency !== segments.length
  ) {
    return null;
  }

  return { parent, dependency };
};

/** The version of an installed package, as the tree beside `from` resolves it. */
const installedFrom = (
  name: string,
  from: string,
): { path: string; version: string } => {
  const path = require.resolve(`${name}/package.json`, { paths: [from] });
  const { version } = JSON.parse(readFileSync(path, "utf8")) as {
    version: string;
  };
  return { path, version };
};

/**
 * Every installed package directory in the tree, as paths relative to the
 * repository root, found the way Node looks for them. Each `node_modules`
 * holds packages, a scope directory holds more, and any package can carry a
 * `node_modules` of its own.
 *
 * Symlinks are skipped rather than followed, so a linked package cannot send
 * the walk round in a loop. Yarn Classic links nothing without workspaces or
 * `link:` dependencies, and this repository uses neither.
 */
const listInstalledPackages = (): string[] => {
  const found: string[] = [];

  const subdirectories = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);

  const walk = (nodeModules: string): void => {
    for (const name of subdirectories(nodeModules)) {
      const packageDirs = name.startsWith("@")
        ? subdirectories(join(nodeModules, name)).map((scoped) =>
            join(nodeModules, name, scoped),
          )
        : [join(nodeModules, name)];

      for (const packageDir of packageDirs) {
        found.push(relative(repoRoot, packageDir));

        const nested = join(packageDir, "node_modules");
        if (existsSync(nested)) {
          walk(nested);
        }
      }
    }
  };

  walk(join(repoRoot, "node_modules"));
  return found;
};

let installedPackages: string[] | undefined;

/**
 * The installed copies of `name`, matched on each manifest's `name` field and
 * not on the directory. `@tailwindcss/postcss` lives in a directory called
 * `postcss` without being postcss, and an npm alias installs a package under
 * a directory named for the alias.
 */
const installedCopiesOf = (name: string): string[] => {
  installedPackages ??= listInstalledPackages();

  return installedPackages.filter((packageDir) => {
    const manifestPath = join(repoRoot, packageDir, "package.json");
    if (!existsSync(manifestPath)) {
      return false;
    }
    const { name: declared } = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as { name?: string };
    return declared === name;
  });
};

const resolutions = Object.entries(manifest.resolutions ?? {});

describe("the resolutions block", () => {
  /**
   * `describe.each` over an empty list registers nothing and reports a pass,
   * so an emptied or renamed `resolutions` block would delete every assertion
   * below without failing anything.
   */
  it("declares at least one resolution to check", () => {
    expect(resolutions.length).toBeGreaterThan(0);
  });

  it("states every resolution as a parent/dependency pair", () => {
    const uninterpretable = resolutions
      .map(([key]) => key)
      .filter((key) => parseResolutionKey(key) === null);

    expect(uninterpretable).toEqual([]);
  });
});

describe.each(resolutions)("the %s resolution", (key, pinned) => {
  const parsed = parseResolutionKey(key);

  it("pins an exact version", () => {
    // A range would reintroduce the drift from the other side: the lockfile
    // could satisfy it with a version nobody checked the CSS output against.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  if (parsed === null) {
    // Reported by "states every resolution as a parent/dependency pair" above.
    return;
  }

  const { parent, dependency } = parsed;

  const declaredTopLevel =
    manifest.devDependencies?.[dependency] ??
    manifest.dependencies?.[dependency];

  if (declaredTopLevel !== undefined) {
    it(`agrees with the top-level ${dependency} pin`, () => {
      // The assertion SCRUM-695 is about. Bumping one without the other is
      // what splits the tree.
      expect(pinned).toBe(declaredTopLevel);
    });
  }

  /**
   * The manifest is what a reviewer reads; the installed tree is what the
   * build loads. Yarn applies `resolutions` at install time, so a lockfile
   * written before an edit to this block satisfies the manifest and still
   * links the old copy.
   */
  it(`installs ${dependency} at the pinned version`, () => {
    const parentDir = dirname(
      require.resolve(`${parent}/package.json`, { paths: [repoRoot] }),
    );

    expect(installedFrom(dependency, parentDir).version).toBe(pinned);
  });

  it(`leaves no copy of ${dependency} nested under ${parent}`, () => {
    const parentDir = dirname(
      require.resolve(`${parent}/package.json`, { paths: [repoRoot] }),
    );

    // Node resolution walks up from the asking package, so a nested copy
    // wins and these two paths differ. Comparing resolved paths states the
    // invariant directly, and does not depend on where Yarn chose to hoist.
    expect(installedFrom(dependency, parentDir).path).toBe(
      installedFrom(dependency, repoRoot).path,
    );
  });

  it(`installs exactly one copy of ${dependency} anywhere in the tree`, () => {
    // The test above checks only under the parent. A split that some
    // other package pulls in leaves it green, and leaves the build loading
    // two copies whose types do not match (SCRUM-737).
    expect(installedCopiesOf(dependency)).toEqual([
      join("node_modules", dependency),
    ]);
  });
});
