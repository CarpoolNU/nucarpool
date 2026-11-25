/**
 * Community's development sign-in bypass must never reach `src/`.
 *
 * The standalone Community repository shipped with a scaffold for signing in
 * without Azure AD: an API route under `pages/api/dev/` that issued a session
 * from a cookie carrying no credential, a `useDevSession` hook that called it,
 * a `DevSignInStrip` switcher that drove the hook, and a `devStrip` slot in the
 * page shell that put the switcher on screen. Every file of it was marked
 * `SCAFFOLD — NOT MERGED`. In NUCarpool any piece of that would be a sign-in
 * bypass, so its return is a CI failure here rather than a review comment.
 *
 * **Why a test rather than the sibling's own script.** The sibling's
 * `scripts/assert-dev-auth-absent.js` refuses a build while three named files
 * exist. That catches the scaffold arriving whole, but not a piece of it
 * arriving under another name: a copied hook in a new file, or the shell's
 * slot re-added by a page that wants somewhere to put a control. So this
 * matches the identifiers and the marker the scaffold used, in file contents
 * and in file paths, across every file under `src/`. It runs inside
 * `yarn test`, which CI already gates on, so it needs no build step of its own.
 *
 * **This file names every pattern it forbids, so it must not scan itself.** It
 * sits at the repository root, outside `src/`, which is what keeps it out of
 * its own scan. If it is ever moved under `src/`, the scan still skips it and
 * the "lives outside the directory it scans" case fails instead, so the move
 * reads as a misplaced file rather than as patterns to delete.
 *
 * This runs in the `node` project: it reads files and matches strings.
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";

const repoRoot = __dirname;
const scanRoot = path.join(repoRoot, "src");

/**
 * The dev-auth surface, as the scaffold spelled it.
 *
 * Case-insensitive where the scaffold used one name in two cases: the
 * component is `DevSignInStrip` and its file is `devSignInStrip.tsx`; the hook
 * is `useDevSession` and the server half is `devSession.ts`.
 */
const FORBIDDEN: ReadonlyArray<{
  name: string;
  pattern: RegExp;
  /** A line in the shape the scaffold actually wrote, which must match. */
  sample: string;
}> = [
  {
    name: "the sign-in switcher",
    pattern: /devSignInStrip/i,
    sample: 'import { DevSignInStrip } from "./devSignInStrip";',
  },
  {
    name: "the dev session hook or module",
    pattern: /devSession/i,
    sample: "const { user } = useDevSession();",
  },
  {
    name: "the shell's slot for the switcher",
    pattern: /devStrip/i,
    sample: "  devStrip?: ReactNode;",
  },
  {
    name: "the dev sign-in API route",
    // Bounded so that a real route such as `api/devices` would not match,
    // while `api/dev/session`, `api/dev"` and a bare `api/dev` all do.
    pattern: /\bapi\/dev(?![\w-])/,
    sample: 'await fetch("/api/dev/session");',
  },
  {
    name: "the scaffold marker",
    pattern: /SCAFFOLD\s*[—–-]+\s*NOT\s+MERGED/i,
    sample: " * SCAFFOLD — NOT MERGED, AND DELETED AT MERGE.",
  },
];

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

const scannedFiles = filesUnder(scanRoot).filter((file) => file !== __filename);

const findings = (relativePath: string, contents: string): string[] =>
  FORBIDDEN.flatMap(({ name, pattern }) => {
    const hits: string[] = [];
    if (pattern.test(relativePath)) {
      hits.push(`${relativePath}: path matches ${name} (${pattern})`);
    }
    contents.split("\n").forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${relativePath}:${index + 1}: ${name} (${pattern})`);
      }
    });
    return hits;
  });

describe("the development sign-in bypass is absent from src/", () => {
  /*
   * Membership, not a count: a scan that silently read nothing would pass
   * every assertion below. Naming the frame every Community page renders
   * proves the scan reaches the file the slot was removed from.
   */
  it("scans the files the bypass would live in", () => {
    const scanned = scannedFiles.map((file) => path.relative(repoRoot, file));
    expect(scanned).toEqual(
      expect.arrayContaining([
        path.join("src", "components", "community", "shell.tsx"),
        path.join("src", "pages", "_app.tsx"),
        path.join("src", "server", "router", "index.ts"),
      ]),
    );
  });

  it("lives outside the directory it scans", () => {
    expect(path.relative(scanRoot, __filename).startsWith("..")).toBe(true);
  });

  /*
   * A pattern edited into one that matches nothing fails here, rather than
   * turning the scan below into a vacuous pass.
   */
  it.each(FORBIDDEN)(
    "$name is recognised in a line the scaffold wrote",
    ({ pattern, sample }) => {
      expect(pattern.test(sample)).toBe(true);
    },
  );

  it("does not mistake an unrelated route for the dev one", () => {
    expect(findings("src/example.ts", 'fetch("/api/devices")')).toEqual([]);
  });

  it("finds no trace of it in any file under src/", () => {
    const hits = scannedFiles.flatMap((file) =>
      findings(path.relative(repoRoot, file), readFileSync(file, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});
