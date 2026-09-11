/**
 * `scripts/wt-recycle.sh` - the refusals, the ordering, and what survives.
 *
 * This script switches a branch and deletes another one, so the property that
 * matters is not that it works but that **it cannot lose a commit**. These
 * tests are therefore weighted towards refusal: one case per condition the
 * script claims to refuse, each asserting both the exit status and that the
 * slot was left exactly as it was.
 *
 * Everything runs against disposable repositories built by `wt-testkit.ts`
 * under `os.tmpdir()`. Nothing here touches this repository, the nine real
 * worktrees, or any remote.
 *
 * `yarn` is a fake that records its arguments, which is how a regeneration is
 * told apart from a skip without waiting for a real install.
 */

import * as fs from "fs";
import * as path from "path";

import {
  Sandbox,
  addSlot,
  git,
  gitTry,
  isReachableFrom,
  localBranchExists,
  makeSandbox,
  makeSlotLookBusy,
  mergeIntoOriginMain,
  remoteBranchExists,
  removeTree,
  runScript,
  yarnCalls,
} from "./wt-testkit";

/** Sandboxes created by the active test, torn down afterwards. */
let boxes: Sandbox[] = [];

const sandbox = (opts?: Parameters<typeof makeSandbox>[0]): Sandbox => {
  const box = makeSandbox(opts);
  boxes.push(box);
  return box;
};

afterEach(() => {
  for (const box of boxes) {
    removeTree(box.root);
  }
  boxes = [];
});

/** The branch a slot currently has checked out. */
const slotBranch = (box: Sandbox, target: string): string =>
  git(box, target, "symbolic-ref", "--quiet", "--short", "HEAD");

/** A slot on a merged branch, ready to be recycled. The common starting point. */
const readySlot = (box: Sandbox, branch = "scrum-900-first") => {
  const target = addSlot(box, "scrum", branch);
  return target;
};

const TIMEOUT = 60000;

describe("arguments", () => {
  it.each([
    ["no arguments", []],
    ["one argument", ["scrum"]],
    ["three arguments", ["scrum", "a", "b"]],
  ])(
    "refuses %s",
    (_label, args) => {
      const box = sandbox();
      const run = runScript(box, "wt-recycle.sh", args as string[]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("usage:");
    },
    TIMEOUT,
  );

  it(
    "prints usage for --help without touching anything",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const run = runScript(box, "wt-recycle.sh", ["--help"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("slot must be one of: scrum infra");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );
});

describe("the slot allowlist", () => {
  it(
    "refuses a slot name that is not on the allowlist",
    () => {
      const box = sandbox();
      addSlot(box, "mobile-audit", "audit-branch");
      const run = runScript(box, "wt-recycle.sh", [
        "mobile-audit",
        "scrum-901-next",
      ]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("is not a reusable slot");
      expect(localBranchExists(box, "audit-branch")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "does not infer a reusable slot from a path that looks like one",
    () => {
      const box = sandbox();
      readySlot(box);
      const run = runScript(box, "wt-recycle.sh", [
        ".claude/worktrees/scrum",
        "scrum-901-next",
      ]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("is not a reusable slot");
    },
    TIMEOUT,
  );

  it(
    "accepts 'infra' as a slot",
    () => {
      const box = sandbox();
      const target = addSlot(box, "infra", "infra-900-first");
      const run = runScript(box, "wt-recycle.sh", ["infra", "infra-901-next"]);
      expect(run.status).toBe(0);
      expect(slotBranch(box, target)).toBe("infra-901-next");
    },
    TIMEOUT,
  );
});

describe("which worktree it is", () => {
  it(
    "refuses when the slot path resolves to the primary checkout",
    () => {
      const box = sandbox();
      // A symlink is the reachable way to make the two paths resolve the same.
      fs.symlinkSync(box.primary, path.join(box.worktreesRoot, "scrum"));
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("primary checkout");
    },
    TIMEOUT,
  );

  it(
    "refuses to recycle the worktree it is running from",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"], {
        cwd: target,
      });
      expect(run.status).toBe(1);
      expect(run.output).toContain("must never");
      expect(run.output).toContain("recycle its own slot");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "refuses when no worktree is registered at the slot path",
    () => {
      const box = sandbox();
      fs.mkdirSync(path.join(box.worktreesRoot, "scrum"), { recursive: true });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("no worktree is registered");
    },
    TIMEOUT,
  );

  it(
    "refuses a prunable slot rather than resurrecting it",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.rmSync(target, { recursive: true, force: true });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("prunable");
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("locking is the ownership gate", () => {
  it(
    "refuses a locked slot and surfaces the lock reason",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      git(
        box,
        box.primary,
        "worktree",
        "lock",
        "--reason",
        "SCRUM-900 in progress",
        target,
      );
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("locked");
      expect(run.output).toContain("SCRUM-900 in progress");
      expect(run.output).toContain("git worktree unlock");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "recycles once the slot is unlocked, and only then",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      git(box, box.primary, "worktree", "lock", target);
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]).status,
      ).toBe(1);

      git(box, box.primary, "worktree", "unlock", target);
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(slotBranch(box, target)).toBe("scrum-901-next");
    },
    TIMEOUT,
  );
});

describe("the slot's git state", () => {
  it(
    "refuses a detached HEAD",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      git(box, target, "checkout", "--detach", "--quiet");
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("detached");
    },
    TIMEOUT,
  );

  it.each([["main"], ["staging"]])(
    "refuses a slot holding the protected branch %s",
    (protectedBranch) => {
      const box = sandbox();
      if (protectedBranch === "staging") {
        git(box, box.primary, "branch", "staging", "refs/remotes/origin/main");
      }
      // The primary has to let go of the branch before a slot can hold it.
      git(box, box.primary, "checkout", "--detach", "--quiet");
      const target = addSlot(box, "scrum", protectedBranch, { existing: true });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("Protected branches");
      expect(slotBranch(box, target)).toBe(protectedBranch);
      expect(localBranchExists(box, protectedBranch)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "refuses modified tracked files",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(path.join(target, "README.md"), "edited in the slot\n");
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("modified or untracked files");
      expect(run.output).toContain("README.md");
      expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toContain(
        "edited",
      );
    },
    TIMEOUT,
  );

  it(
    "refuses untracked files, which a branch switch would carry into the next ticket",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(
        path.join(target, "scratch-notes.md"),
        "half-finished\n",
      );
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("modified or untracked files");
      expect(fs.existsSync(path.join(target, "scratch-notes.md"))).toBe(true);
    },
    TIMEOUT,
  );

  it.each([
    ["a merge", "MERGE_HEAD", true],
    ["a cherry-pick", "CHERRY_PICK_HEAD", true],
    ["a revert", "REVERT_HEAD", true],
    ["a bisect", "BISECT_LOG", true],
    ["a rebase", "rebase-merge", false],
  ])(
    "refuses a slot part-way through %s",
    (_label, marker, isFile) => {
      const box = sandbox();
      const target = readySlot(box);
      const gitDir = git(box, target, "rev-parse", "--absolute-git-dir");
      if (isFile) {
        fs.writeFileSync(
          path.join(gitDir, marker),
          git(box, target, "rev-parse", "HEAD") + "\n",
        );
      } else {
        fs.mkdirSync(path.join(gitDir, marker), { recursive: true });
      }
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("operation in progress");
      expect(run.output).toContain(marker);
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("the shared stash", () => {
  it(
    "refuses entries taken from the branch being retired, and never touches them",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(path.join(target, "README.md"), "work in progress\n");
      git(box, target, "stash", "push", "-m", "wip on the finished ticket");
      const before = git(box, target, "stash", "list");
      expect(before).toContain("scrum-900-first");

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("shared stash holds entries");
      // The entry is still exactly where it was - not popped, dropped or cleared.
      expect(git(box, target, "stash", "list")).toBe(before);
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "leaves an unrelated stash entry alone and recycles anyway",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      // An entry from a different branch, which is the normal state of a shared
      // stack. A blanket refusal here would make the script unusable.
      git(
        box,
        box.primary,
        "checkout",
        "--quiet",
        "-b",
        "someone-elses-branch",
      );
      fs.writeFileSync(
        path.join(box.primary, "README.md"),
        "another worktree's wip\n",
      );
      git(box, box.primary, "stash", "push", "-m", "not mine");
      const before = git(box, box.primary, "stash", "list");

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(git(box, box.primary, "stash", "list")).toBe(before);
      expect(slotBranch(box, target)).toBe("scrum-901-next");
    },
    TIMEOUT,
  );
});

describe("environment files", () => {
  it(
    "refuses a slot with no .env",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.rmSync(path.join(target, ".env"));
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("no .env");
    },
    TIMEOUT,
  );

  it(
    "refuses a symlinked .env, because a shared one is not per-worktree",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.rmSync(path.join(target, ".env"));
      fs.writeFileSync(path.join(box.primary, ".env"), "SHARED=1\n");
      fs.symlinkSync(path.join(box.primary, ".env"), path.join(target, ".env"));
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("symlink");
    },
    TIMEOUT,
  );

  it(
    "refuses when .env.production exists in the slot",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(path.join(target, ".env.production"), "DEPLOYED=1\n");
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain(".env.production");
      expect(run.output).toContain("Amplify");
      // Refused, not deleted - removing a credentials file is the human's call.
      expect(fs.existsSync(path.join(target, ".env.production"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "reports names missing from .env by name only, and does not refuse",
    () => {
      const box = sandbox();
      // .env.example is tracked and names MAPBOX_ACCESS_TOKEN; this slot's .env
      // does not have it.
      addSlot(box, "scrum", "scrum-900-first", {
        env: 'DATABASE_URL="mysql://u:p@127.0.0.1:3306/nucarpool"\nTEST_DATABASE_URL="mysql://u:p@127.0.0.1:3306/nucarpool_test_scrum"\n',
      });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(run.output).toContain("MAPBOX_ACCESS_TOKEN");
      expect(run.output).toContain("values were not read or compared");
      // The value side of the slot's own .env is never echoed.
      expect(run.output).not.toContain('nucarpool_test_scrum"');
      expect(run.output).not.toContain("mysql://");
    },
    TIMEOUT,
  );

  it(
    "never rewrites the slot's .env",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const before = fs.readFileSync(path.join(target, ".env"), "utf8");
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]).status,
      ).toBe(0);
      expect(fs.readFileSync(path.join(target, ".env"), "utf8")).toBe(before);
    },
    TIMEOUT,
  );
});

describe("the integration database name", () => {
  const envWith = (db: string) =>
    `DATABASE_URL="mysql://u:p@127.0.0.1:3306/nucarpool"\nTEST_DATABASE_URL="mysql://u:p@127.0.0.1:3306/${db}"\n`;

  it.each([
    ["a production-looking name", "nucarpool_production_test", "prod"],
    ["a staging-looking name", "nucarpool_staging_test", "stag"],
  ])(
    "refuses %s, matching testDatabaseGuard.ts",
    (_label, db, word) => {
      const box = sandbox();
      addSlot(box, "scrum", "scrum-900-first", { env: envWith(db) });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain(word);
      expect(run.output).toContain("TRUNCATE");
    },
    TIMEOUT,
  );

  it(
    "refuses a name with no 'test' word",
    () => {
      const box = sandbox();
      addSlot(box, "scrum", "scrum-900-first", { env: envWith("nucarpool") });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("not marked as a test database");
    },
    TIMEOUT,
  );

  it(
    "warns but proceeds when the database is not yet the per-slot one",
    () => {
      const box = sandbox();
      addSlot(box, "scrum", "scrum-900-first", {
        env: envWith("nucarpool_test"),
      });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(run.output).toContain("nucarpool_test_scrum");
      expect(run.output).toContain("Deferred");
    },
    TIMEOUT,
  );

  it(
    "never prints the credentials in the URL",
    () => {
      const box = sandbox();
      addSlot(box, "scrum", "scrum-900-first", {
        env: 'TEST_DATABASE_URL="mysql://someuser:sup3rsecret@127.0.0.1:3306/nucarpool_test_scrum"\n',
      });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(run.output).not.toContain("sup3rsecret");
      expect(run.output).not.toContain("someuser");
      expect(run.output).toContain("nucarpool_test_scrum");
    },
    TIMEOUT,
  );
});

describe("advisory liveness", () => {
  it(
    "refuses when a process has its working directory in the slot",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      makeSlotLookBusy(box);
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("working directory inside that slot");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );
});

describe("the new branch name", () => {
  it.each([
    ["an invalid ref", "bad..name"],
    ["a name with a space", "bad name"],
    ["a leading dash", "-dashed"],
  ])(
    "refuses %s",
    (_label, name) => {
      const box = sandbox();
      const target = readySlot(box);
      const run = runScript(box, "wt-recycle.sh", ["scrum", name]);
      expect(run.status).toBe(1);
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it.each([["main"], ["staging"]])(
    "refuses the protected name %s",
    (name) => {
      const box = sandbox();
      const target = readySlot(box);
      const run = runScript(box, "wt-recycle.sh", ["scrum", name]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("protected branch");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "refuses recycling a slot onto the branch it already has",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-900-first"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("already checked out");
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "refuses a name that already exists locally",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      git(
        box,
        box.primary,
        "branch",
        "scrum-901-next",
        "refs/remotes/origin/main",
      );
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("already exists");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "refuses a name that already exists on the remote",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      // Pushed from a throwaway clone, so the primary has no local copy of it -
      // the local check must not be what catches this.
      const other = path.join(box.root, "pusher");
      git(box, box.root, "clone", "--quiet", box.origin, other);
      git(box, other, "checkout", "--quiet", "-b", "scrum-901-next");
      git(box, other, "push", "--quiet", "origin", "scrum-901-next");
      expect(localBranchExists(box, "scrum-901-next")).toBe(false);

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("already exists on the remote");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
      expect(remoteBranchExists(box, "scrum-901-next")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("merge evidence", () => {
  it(
    "refuses a branch whose commits are not reachable from origin/main",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(path.join(target, "feature.md"), "unmerged work\n");
      git(box, target, "add", "feature.md");
      git(box, target, "commit", "--quiet", "-m", "work that is nowhere else");
      const tip = git(box, target, "rev-parse", "HEAD");

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("not reachable from origin/main");
      expect(run.output).toContain("work that is nowhere else");
      // The whole point: the commit is still here and still on its branch.
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
      expect(git(box, target, "rev-parse", "HEAD")).toBe(tip);
      expect(slotBranch(box, target)).toBe("scrum-900-first");
    },
    TIMEOUT,
  );

  it(
    "recycles once that branch really is merged",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.writeFileSync(path.join(target, "feature.md"), "work\n");
      git(box, target, "add", "feature.md");
      git(box, target, "commit", "--quiet", "-m", "the ticket's work");
      git(box, target, "push", "--quiet", "origin", "scrum-900-first");
      const tip = git(box, target, "rev-parse", "HEAD");

      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]).status,
      ).toBe(1);

      mergeIntoOriginMain(box, "scrum-900-first");

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(0);
      expect(slotBranch(box, target)).toBe("scrum-901-next");
      expect(localBranchExists(box, "scrum-900-first")).toBe(false);
      // Deleted from the branch namespace, still reachable from main.
      expect(isReachableFrom(box, tip, "refs/remotes/origin/main")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "refuses when origin/main does not exist at all",
    () => {
      const box = sandbox({ withMain: false });
      const target = addSlot(box, "scrum", "scrum-900-first", {
        base: "trunk",
      });
      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("origin/main");
      expect(slotBranch(box, target)).toBe("scrum-900-first");
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("a successful recycle", () => {
  it(
    "switches to the new branch, deletes the old one, and keeps the warm state",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const oldTip = git(box, target, "rev-parse", "HEAD");
      git(box, target, "push", "--quiet", "origin", "scrum-900-first");

      const run = runScript(box, "wt-recycle.sh", [
        "scrum",
        "scrum-901-second",
      ]);
      expect(run.status).toBe(0);

      // The new branch is at fresh origin/main.
      expect(slotBranch(box, target)).toBe("scrum-901-second");
      expect(git(box, target, "rev-parse", "HEAD")).toBe(
        git(box, box.primary, "rev-parse", "refs/remotes/origin/main"),
      );
      // It is a --no-track branch: a bare `git push` must not aim at main.
      expect(
        gitTry(
          box,
          target,
          "rev-parse",
          "--abbrev-ref",
          "scrum-901-second@{upstream}",
        ).status,
      ).not.toBe(0);

      // The old local branch is gone, the remote branch is not.
      expect(localBranchExists(box, "scrum-900-first")).toBe(false);
      expect(remoteBranchExists(box, "scrum-900-first")).toBe(true);
      // And no commit was lost.
      expect(isReachableFrom(box, oldTip, "refs/remotes/origin/main")).toBe(
        true,
      );

      // Warm state survives; build output does not.
      expect(fs.existsSync(path.join(target, "node_modules", "sentinel"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(target, ".env"))).toBe(true);
      expect(fs.existsSync(path.join(target, ".next"))).toBe(false);
      expect(fs.existsSync(path.join(target, "coverage"))).toBe(false);
      expect(fs.existsSync(path.join(target, ".husky", "_"))).toBe(true);

      // The working tree is clean, so the next ticket starts from nothing of ours.
      expect(git(box, target, "status", "--porcelain")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "reconciles dependencies and the Prisma client against the new branch",
    () => {
      const box = sandbox();
      readySlot(box);
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      const calls = yarnCalls(box);
      expect(calls).toContain("install --frozen-lockfile");
      expect(calls).toContain("prisma generate");
    },
    TIMEOUT,
  );

  it(
    "does not modify yarn.lock or package.json",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const lock = fs.readFileSync(path.join(target, "yarn.lock"), "utf8");
      const pkg = fs.readFileSync(path.join(target, "package.json"), "utf8");
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      expect(fs.readFileSync(path.join(target, "yarn.lock"), "utf8")).toBe(
        lock,
      );
      expect(fs.readFileSync(path.join(target, "package.json"), "utf8")).toBe(
        pkg,
      );
      expect(git(box, target, "status", "--porcelain")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "restores .husky/_ when it is missing, so commit hooks are not silently off",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      fs.rmSync(path.join(target, ".husky", "_"), {
        recursive: true,
        force: true,
      });
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      expect(yarnCalls(box)).toContain("prepare");
      expect(fs.existsSync(path.join(target, ".husky", "_"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "leaves a symlinked generated directory alone rather than following it",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const outside = path.join(box.root, "precious");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "keep.txt"), "not build output\n");
      fs.rmSync(path.join(target, "coverage"), {
        recursive: true,
        force: true,
      });
      fs.symlinkSync(outside, path.join(target, "coverage"));

      const run = runScript(box, "wt-recycle.sh", [
        "scrum",
        "scrum-901-second",
      ]);
      expect(run.status).toBe(0);
      expect(run.output).toContain("symlink");
      expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "can be run twice in a row, holding three tickets in one directory",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-902-third"]).status,
      ).toBe(0);
      expect(slotBranch(box, target)).toBe("scrum-902-third");
      expect(localBranchExists(box, "scrum-900-first")).toBe(false);
      expect(localBranchExists(box, "scrum-901-second")).toBe(false);
      expect(fs.existsSync(path.join(target, "node_modules", "sentinel"))).toBe(
        true,
      );
    },
    TIMEOUT,
  );
});

describe("partial failure", () => {
  it(
    "deletes nothing when the switch itself fails",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      // `refs/heads/scrum-901-next/child` makes `refs/heads/scrum-901-next`
      // unlockable, so the switch fails after every check has passed. The
      // pre-checks cannot see it: scrum-901-next itself does not exist.
      git(
        box,
        box.primary,
        "branch",
        "scrum-901-next/child",
        "refs/remotes/origin/main",
      );
      expect(localBranchExists(box, "scrum-901-next")).toBe(false);

      const run = runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-next"]);
      expect(run.status).toBe(1);
      expect(run.output).toContain("Nothing was deleted");
      // The slot is untouched and the old branch is intact.
      expect(slotBranch(box, target)).toBe("scrum-900-first");
      expect(localBranchExists(box, "scrum-900-first")).toBe(true);
      expect(localBranchExists(box, "scrum-901-next")).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "keeps the old branch reachable when the branch delete is declined",
    () => {
      const box = sandbox();
      const target = readySlot(box);
      const oldTip = git(box, target, "rev-parse", "HEAD");
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      // Whatever happened, the commit the slot used to be on is still reachable.
      expect(isReachableFrom(box, oldTip, "refs/remotes/origin/main")).toBe(
        true,
      );
    },
    TIMEOUT,
  );
});

describe("what it never does", () => {
  it("uses no force, no reset, no clean and no remote deletion", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "wt-recycle.sh"),
      "utf8",
    );
    // Comments in this script discuss the commands it avoids, so the check is
    // against the executable lines only.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/branch\s+-D/);
    expect(code).not.toMatch(/worktree\s+remove/);
    expect(code).not.toMatch(/reset\s+--hard/);
    expect(code).not.toMatch(/git\s+clean/);
    expect(code).not.toMatch(/push\s+.*--force/);
    expect(code).not.toMatch(/--force-with-lease/);
    expect(code).not.toMatch(/push\s+.*--delete/);
    expect(code).not.toMatch(/^\s*git stash (pop|drop|clear)/m);
    // And no bypass of any of the refusals above.
    expect(code).not.toMatch(/--yes\b/);
    expect(code).not.toMatch(/ASSUME_YES|FORCE|SKIP_CHECK/);
  });

  it(
    "never pushes",
    () => {
      const box = sandbox();
      readySlot(box);
      const before = git(
        box,
        box.origin,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      );
      expect(
        runScript(box, "wt-recycle.sh", ["scrum", "scrum-901-second"]).status,
      ).toBe(0);
      expect(
        git(
          box,
          box.origin,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ),
      ).toBe(before);
    },
    TIMEOUT,
  );
});
