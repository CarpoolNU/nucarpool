import * as path from "path";
import { isTestPath } from "./check-page-routes";

/**
 * Which paths under `src/pages` the route guard calls test code.
 *
 * Under the Pages Router a filename is a URL, so this predicate is the whole
 * check: anything it misses gets compiled into a route and deployed. It used to
 * read `path.basename` alone, which meant it only ever saw the `.test.` naming
 * convention. `jest.config.js` also collects a `__tests__` directory
 * recursively, whatever the files inside it are named, so
 * `src/pages/__tests__/foo.ts` was a suite Jest ran *and* the live route
 * `/__tests__/foo`, and the guard passed it.
 *
 * The move from basename to full path is the kind of widening that invites
 * false positives, so the negative cases below are as load-bearing as the
 * positive ones: a directory or filename that merely contains the letters
 * "test" is not test code.
 *
 * `path.join` throughout rather than literal `/`, because the predicate splits
 * on `path.sep` and the values it is given come from `path.relative`.
 */
const page = (...segments: string[]) => path.join("src", "pages", ...segments);

describe("isTestPath", () => {
  describe("test code, which must never become a route", () => {
    it("rejects a suite in a __tests__ directory", () => {
      // The defect this check was extended for: an innocent basename.
      expect(isTestPath(page("__tests__", "foo.ts"))).toBe(true);
    });

    it("rejects a suite in a __tests__ directory nested deeper", () => {
      expect(isTestPath(page("api", "pusher", "__tests__", "auth.ts"))).toBe(
        true,
      );
    });

    it("rejects a __mocks__ directory", () => {
      expect(isTestPath(page("__mocks__", "handler.ts"))).toBe(true);
    });

    it("rejects the co-located naming convention", () => {
      // The original incident: this shipped as /api/pusher/auth.test.
      expect(isTestPath(page("api", "pusher", "auth.test.ts"))).toBe(true);
      expect(isTestPath(page("profile.spec.tsx"))).toBe(true);
    });

    it("rejects the bare test.ts and spec.ts forms", () => {
      // Jest's default naming pattern collects these too - the extension is
      // preceded by nothing at all - so the guard has to know about them.
      expect(isTestPath(page("test.ts"))).toBe(true);
      expect(isTestPath(page("api", "spec.ts"))).toBe(true);
    });
  });

  describe("real pages, which must keep passing", () => {
    it("accepts ordinary pages", () => {
      expect(isTestPath(page("index.tsx"))).toBe(false);
      expect(isTestPath(page("profile.tsx"))).toBe(false);
      expect(isTestPath(page("api", "trpc", "[trpc].ts"))).toBe(false);
    });

    it("accepts a filename that merely contains the letters test", () => {
      // `contest.ts` holds "test" but not as a dot-delimited part, which is
      // what the basename pattern has always required.
      expect(isTestPath(page("contest.ts"))).toBe(false);
      expect(isTestPath(page("latest.tsx"))).toBe(false);
    });

    it("accepts a directory that merely contains the letters test", () => {
      // The risk the full-path read introduces. A segment has to be exactly
      // `__tests__` or `__mocks__`, not merely contain one.
      expect(isTestPath(page("latest", "index.tsx"))).toBe(false);
      expect(isTestPath(page("contest", "entry.tsx"))).toBe(false);
      expect(isTestPath(page("my__tests__dir", "page.tsx"))).toBe(false);
    });
  });
});
