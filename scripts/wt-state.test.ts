/**
 * `scripts/wt-state.sh` - the generated-state fingerprints.
 *
 * The defect these replace (SCRUM-448) is worth restating, because it is the
 * thing these tests exist to make impossible: `wt-bootstrap.sh` used to decide
 * whether `node_modules/.prisma/client` was current by comparing the
 * worktree's `prisma/schema.prisma` against the **primary checkout's** copy.
 * That compares two working trees and says nothing about which schema actually
 * generated the client, so a client built from a third schema could be
 * reported as current.
 *
 * So the assertions that matter most are the two the old logic got wrong:
 *
 *   - a client whose stamp does not match **this** schema is regenerated, even
 *     when the primary checkout's schema is byte-identical to this one;
 *   - a client whose stamp does match is skipped, even when the primary
 *     checkout's schema is completely different.
 *
 * Neither outcome depends on the primary checkout at all, which is the point.
 *
 * `yarn` is a fake that records its arguments, so "regenerated" and "skipped"
 * are directly observable.
 */

import * as fs from "fs";
import * as path from "path";

import {
  Sandbox,
  addSlot,
  git,
  makeSandbox,
  removeTree,
  runInline,
  yarnCalls,
} from "./wt-testkit";

let boxes: Sandbox[] = [];

const sandbox = (): Sandbox => {
  const box = makeSandbox({ scripts: ["wt-recycle.sh", "wt-state.sh"] });
  boxes.push(box);
  return box;
};

afterEach(() => {
  for (const box of boxes) {
    removeTree(box.root);
  }
  boxes = [];
});

const STAMP = path.join(
  "node_modules",
  ".prisma",
  "client",
  ".nucarpool-schema-hash",
);
const DEPS_STAMP = path.join("node_modules", ".nucarpool-deps-hash");
const SCHEMA = path.join("prisma", "schema.prisma");

/** A slot with a warm node_modules, standing in for a bootstrapped worktree. */
const slot = (box: Sandbox): string => addSlot(box, "scrum", "scrum-900-first");

/** Pretend a client was generated from whatever the schema currently says. */
const stampAsCurrent = (box: Sandbox, dir: string): string => {
  fs.mkdirSync(path.join(dir, "node_modules", ".prisma", "client"), {
    recursive: true,
  });
  const hash = git(box, dir, "hash-object", "--no-filters", "--", SCHEMA);
  fs.writeFileSync(path.join(dir, STAMP), hash + "\n");
  return hash;
};

const reconcilePrisma = (box: Sandbox, dir: string) =>
  runInline(box, dir, "wt_reconcile_prisma_client");

const reconcileDeps = (box: Sandbox, dir: string) =>
  runInline(box, dir, "wt_reconcile_dependencies");

describe("the Prisma client fingerprint", () => {
  it("generates when there is no client at all", () => {
    const box = sandbox();
    const dir = slot(box);
    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("no generated client");
    expect(yarnCalls(box)).toContain("prisma generate");
    expect(fs.existsSync(path.join(dir, STAMP))).toBe(true);
  });

  it("generates when a client exists but carries no fingerprint", () => {
    const box = sandbox();
    const dir = slot(box);
    // Exactly the state of every worktree bootstrapped before this mechanism.
    fs.mkdirSync(path.join(dir, "node_modules", ".prisma", "client"), {
      recursive: true,
    });
    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("no schema fingerprint");
    expect(yarnCalls(box)).toContain("prisma generate");
  });

  it("skips when the fingerprint matches the schema", () => {
    const box = sandbox();
    const dir = slot(box);
    stampAsCurrent(box, dir);
    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("matches");
    expect(yarnCalls(box)).not.toContain("prisma generate");
  });

  it("generates when the fingerprint does not match the schema", () => {
    const box = sandbox();
    const dir = slot(box);
    fs.mkdirSync(path.join(dir, "node_modules", ".prisma", "client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, STAMP),
      "0000000000000000000000000000000000000000\n",
    );
    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("built from a different schema");
    expect(yarnCalls(box)).toContain("prisma generate");
  });

  it("generates again after the schema changes under a matching client", () => {
    const box = sandbox();
    const dir = slot(box);
    stampAsCurrent(box, dir);
    expect(reconcilePrisma(box, dir).output).toContain("matches");
    expect(yarnCalls(box)).not.toContain("prisma generate");

    fs.appendFileSync(
      path.join(dir, SCHEMA),
      "\nmodel Added {\n  id String @id\n}\n",
    );

    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("built from a different schema");
    expect(yarnCalls(box)).toContain("prisma generate");
  });

  it("is idempotent: a second run straight after a generate skips", () => {
    const box = sandbox();
    const dir = slot(box);
    expect(reconcilePrisma(box, dir).status).toBe(0);
    const afterFirst = yarnCalls(box).filter(
      (c) => c === "prisma generate",
    ).length;
    expect(afterFirst).toBe(1);

    expect(reconcilePrisma(box, dir).output).toContain("matches");
    expect(yarnCalls(box).filter((c) => c === "prisma generate").length).toBe(
      1,
    );
  });

  it("records no fingerprint when the generate fails", () => {
    const box = sandbox();
    const dir = slot(box);
    const run = runInline(box, dir, "wt_reconcile_prisma_client", {
      env: { WT_TEST_YARN_FAIL: "1" },
    });
    expect(run.status).not.toBe(0);
    // A stamp written before the generate would claim a client that was never
    // produced - the original bug with extra steps.
    expect(fs.existsSync(path.join(dir, STAMP))).toBe(false);
  });

  it("keeps the fingerprint out of git's view", () => {
    const box = sandbox();
    const dir = slot(box);
    expect(reconcilePrisma(box, dir).status).toBe(0);
    expect(fs.existsSync(path.join(dir, STAMP))).toBe(true);
    // Inside node_modules, which .gitignore covers. It must never be
    // committable and must never make a worktree look dirty.
    expect(git(box, dir, "status", "--porcelain")).toBe("");
    expect(git(box, dir, "status", "--porcelain", "--ignored=no")).toBe("");
  });
});

describe("the primary checkout is not consulted (SCRUM-448)", () => {
  it("regenerates a mismatched client even when the primary's schema is identical", () => {
    const box = sandbox();
    const dir = slot(box);
    // The condition the old check read as "fresh": the two working trees agree.
    expect(fs.readFileSync(path.join(dir, SCHEMA), "utf8")).toBe(
      fs.readFileSync(path.join(box.primary, SCHEMA), "utf8"),
    );
    // But the client here was built from something else.
    fs.mkdirSync(path.join(dir, "node_modules", ".prisma", "client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, STAMP),
      "1111111111111111111111111111111111111111\n",
    );

    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(yarnCalls(box)).toContain("prisma generate");
  });

  it("skips a matching client even when the primary's schema is completely different", () => {
    const box = sandbox();
    const dir = slot(box);
    stampAsCurrent(box, dir);
    // The condition the old check read as "stale": the primary has diverged.
    fs.writeFileSync(
      path.join(box.primary, SCHEMA),
      'generator client {\n  provider = "prisma-client-js"\n}\n\nmodel Unrelated {\n  id String @id\n}\n',
    );

    const run = reconcilePrisma(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("matches");
    expect(yarnCalls(box)).not.toContain("prisma generate");
  });
});

describe("the dependency fingerprint", () => {
  it("installs when the tree carries no manifest fingerprint", () => {
    const box = sandbox();
    const dir = slot(box);
    const run = reconcileDeps(box, dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain("no manifest fingerprint");
    expect(yarnCalls(box)).toContain("install --frozen-lockfile");
    expect(fs.existsSync(path.join(dir, DEPS_STAMP))).toBe(true);
  });

  it("skips when the fingerprint matches both manifests", () => {
    const box = sandbox();
    const dir = slot(box);
    expect(reconcileDeps(box, dir).status).toBe(0);
    const first = yarnCalls(box).length;

    const run = reconcileDeps(box, dir);
    expect(run.output).toContain("matches package.json and yarn.lock");
    expect(yarnCalls(box).length).toBe(first);
  });

  it.each([["package.json"], ["yarn.lock"]])(
    "installs again after %s changes",
    (manifest) => {
      const box = sandbox();
      const dir = slot(box);
      expect(reconcileDeps(box, dir).status).toBe(0);
      const first = yarnCalls(box).filter(
        (c) => c === "install --frozen-lockfile",
      ).length;
      expect(first).toBe(1);

      fs.appendFileSync(
        path.join(dir, manifest),
        "\n# changed on this branch\n",
      );

      const run = reconcileDeps(box, dir);
      expect(run.status).toBe(0);
      expect(run.output).toContain("changed since the last install");
      expect(
        yarnCalls(box).filter((c) => c === "install --frozen-lockfile").length,
      ).toBe(2);
    },
  );

  it("uses --frozen-lockfile, so a reconcile can never rewrite yarn.lock", () => {
    const box = sandbox();
    const dir = slot(box);
    expect(reconcileDeps(box, dir).status).toBe(0);
    for (const call of yarnCalls(box).filter((c) => c.startsWith("install"))) {
      expect(call).toContain("--frozen-lockfile");
    }
  });
});

describe("husky", () => {
  it("regenerates .husky/_ when it is absent", () => {
    const box = sandbox();
    const dir = slot(box);
    fs.rmSync(path.join(dir, ".husky", "_"), { recursive: true, force: true });
    const run = runInline(box, dir, "wt_reconcile_husky");
    expect(run.status).toBe(0);
    expect(yarnCalls(box)).toContain("prepare");
    expect(fs.existsSync(path.join(dir, ".husky", "_"))).toBe(true);
  });

  it("leaves existing hooks alone", () => {
    const box = sandbox();
    const dir = slot(box);
    const run = runInline(box, dir, "wt_reconcile_husky");
    expect(run.status).toBe(0);
    expect(run.output).toContain("already generated");
    expect(yarnCalls(box)).not.toContain("prepare");
  });
});

describe("fingerprinting", () => {
  it("refuses to fingerprint a missing file rather than returning an empty hash", () => {
    const box = sandbox();
    const dir = slot(box);
    // An empty fingerprint would compare equal to another empty one and report
    // a match, which is the silent-staleness failure mode all over again.
    const run = runInline(
      box,
      dir,
      'wt_fingerprint "prisma/nonexistent.prisma"',
    );
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("cannot fingerprint missing file");
  });

  it("is stable across runs and independent of core.autocrlf", () => {
    const box = sandbox();
    const dir = slot(box);
    const first = runInline(
      box,
      dir,
      `wt_fingerprint "${SCHEMA}"`,
    ).stdout.trim();
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    // --no-filters is what makes this hold: without it the hash would run the
    // path's gitattributes and autocrlf through the content, so two machines
    // could disagree about whether the same file had changed.
    git(box, dir, "config", "core.autocrlf", "true");
    const second = runInline(
      box,
      dir,
      `wt_fingerprint "${SCHEMA}"`,
    ).stdout.trim();
    expect(second).toBe(first);
  });
});
