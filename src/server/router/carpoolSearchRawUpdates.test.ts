import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import ts from "typescript";

/**
 * Every raw `UPDATE carpool_search` under `src/` assigns `date_modified`.
 *
 * The column has no `ON UPDATE CURRENT_TIMESTAMP`. Prisma's `@updatedAt`
 * stamps it on Prisma's own writes and on nothing else, so a raw statement
 * that leaves it out changes the row while the column stands still. Five did,
 * until SCRUM-727; `src/server/db/README.md` records the rule and why the
 * column means "the row last changed".
 *
 * A guard rather than a behavioural test, because a missing assignment has no
 * behaviour to observe: no product code reads the column, so every procedure
 * still works. `carpoolSearchDateModified.db.test.ts` proves the effect
 * against MySQL for the statements a procedure can isolate. This covers all
 * of them, including the next one written.
 *
 * Files are parsed rather than grepped, for the reason
 * `src/styles/viewportUnits.test.ts` gives at length: the comments around
 * these statements say `UPDATE carpool_search` too, and a comment is not a
 * node in a syntax tree. Only string and template literals are read, with
 * each `${...}` replaced by a placeholder.
 *
 * Test files and `src/testing/` are skipped. A fixture that backdates the
 * column is a raw `UPDATE carpool_search` written to set it to something
 * other than now.
 */

const SRC = join(__dirname, "..", "..");

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
};

const UPDATE_CARPOOL_SEARCH = /\bUPDATE\s+`?carpool_search`?(?=\s)/i;
const ASSIGNS_DATE_MODIFIED = /\bdate_modified`?\s*=/i;

const isTestFile = (path: string) => /\.(test|spec)\.tsx?$/.test(path);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return path === join(SRC, "testing") ? [] : sourceFiles(path);
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return SCRIPT_KINDS[extension] && !isTestFile(path) ? [path] : [];
  });

type Statement = { site: string; text: string };

const literalText = (node: ts.Node): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => `?${span.literal.text}`).join("")
    );
  }
  return undefined;
};

const rawCarpoolSearchUpdates = (): Statement[] =>
  sourceFiles(SRC).flatMap((path) => {
    const extension = path.slice(path.lastIndexOf("."));
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      SCRIPT_KINDS[extension],
    );
    const found: Statement[] = [];
    const visit = (node: ts.Node) => {
      const text = literalText(node);
      if (text !== undefined && UPDATE_CARPOOL_SEARCH.test(text)) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        found.push({
          site: `${relative(SRC, path).split(sep).join("/")}:${line + 1}`,
          text,
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });

describe("raw UPDATE carpool_search statements", () => {
  const statements = rawCarpoolSearchUpdates();

  it("finds the statements it is meant to police", () => {
    // Membership, not a count: a scan that silently found nothing would pass
    // the real assertion below vacuously. These three files each hold at least
    // one raw `UPDATE carpool_search` today.
    const files = new Set(statements.map(({ site }) => site.split(":")[0]));
    for (const file of [
      "server/router/user.ts",
      "server/router/user/groups.ts",
      "server/router/user/admin.ts",
    ]) {
      expect(files.has(file)).toBe(true);
    }
  });

  it("assigns date_modified in every one", () => {
    const missing = statements
      .filter(({ text }) => !ASSIGNS_DATE_MODIFIED.test(text))
      .map(({ site }) => site);
    expect(missing).toEqual([]);
  });
});
