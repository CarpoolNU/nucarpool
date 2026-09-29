import fs from "fs";
import path from "path";
import { APP_NAME, pageTitle } from "./pageTitle";

/*
 * `document.title` cannot be asserted from a page's own render: `next/head`
 * does nothing without Next's head manager, so a bare `render(<Profile />)`
 * shows an empty title whether or not the page sets one. The honest check is
 * over the sources - every route file has to render a `PageTitle`, and no two
 * of them may name the same page - which is what the second block does.
 * `PageTitle.test.tsx` proves the component itself reaches the document.
 */

describe("pageTitle", () => {
  it("names the page ahead of the product", () => {
    expect(pageTitle("Profile")).toBe("Profile - CarpoolNU");
  });

  it("falls back to the bare product name", () => {
    expect(pageTitle()).toBe("CarpoolNU");
    expect(pageTitle("")).toBe("CarpoolNU");
  });

  it("spells the product the way the repository does", () => {
    expect(APP_NAME).toBe("CarpoolNU");
  });
});

const PAGES_DIR = path.join(__dirname, "..", "pages");

// Route files only: `_app`/`_document` are not routes and `api/` holds
// handlers, none of which render a page.
function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "api" ? [] : routeFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !entry.name.startsWith("_")
      ? [full]
      : [];
  });
}

// `<PageTitle />` or `<PageTitle page="Name" />` - the only two shapes a route
// is allowed to use, so a dynamic `page={...}` fails loudly here rather than
// slipping past a title-uniqueness check it cannot be read by.
const USAGE = /<PageTitle(?:\s+page="([^"]*)")?\s*\/>/g;

function titlesIn(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return Array.from(source.matchAll(USAGE)).map((m) => pageTitle(m[1]));
}

describe("route titles", () => {
  const files = routeFiles(PAGES_DIR);
  const rel = (f: string) => path.relative(PAGES_DIR, f);

  it("finds the routes it is meant to check", () => {
    // A guard against the scan silently matching nothing: an empty list would
    // make every assertion below pass.
    expect(files.map(rel).sort()).toEqual([
      "admin.tsx",
      "index.tsx",
      "profile/index.tsx",
      "profile/setup.tsx",
      "sign-in.tsx",
    ]);
  });

  it.each(files.map((f) => [rel(f), f]))(
    "%s renders a PageTitle, and only one title",
    (_name, file) => {
      const titles = titlesIn(file);
      expect(titles.length).toBeGreaterThan(0);
      expect(new Set(titles).size).toBe(1);
    },
  );

  it("gives no two routes the same title", () => {
    const titles = files.map((f) => titlesIn(f)[0]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps a bare default in _app for a page added without one", () => {
    const app = fs.readFileSync(path.join(PAGES_DIR, "_app.tsx"), "utf8");
    expect(app).toMatch(/<PageTitle\s*\/>/);
  });

  it("uses no route-level title other than PageTitle", () => {
    // A hand-written `<title>` would bypass the one spelling of the product.
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/<title>/);
    }
  });
});
