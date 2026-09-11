/**
 * Disposable git repositories for the worktree scripts' tests.
 *
 * `wt-recycle.sh` switches a branch and deletes another one, and `wt-state.sh`
 * runs `yarn install` and `yarn prisma generate`. None of that can be
 * exercised against this repository, so every test builds a throwaway one:
 * a bare "origin", a clone standing in for the primary checkout, and a linked
 * worktree standing in for a reusable slot.
 *
 * Two things make that safe rather than merely isolated:
 *
 *   - every repository is created under `os.tmpdir()`, and `removeTree`
 *     refuses to delete anything that is not;
 *   - `git` is invoked with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 *     pointed at `/dev/null`, so the developer's own config - `init.defaultBranch`,
 *     hooks, `core.autocrlf`, a global `user.email` - cannot change what the
 *     tests observe, and CI and a laptop agree.
 *
 * `yarn`, `gh` and `lsof` are shadowed by fakes on `PATH`. The fake `yarn`
 * records its arguments to a log the tests assert on, which is how
 * "regenerated" and "skipped" are told apart without waiting for a real
 * install. Shadowing `gh` also keeps the unmerged-branch path from reaching
 * the network.
 */

import { execFileSync, spawnSync, SpawnSyncReturns } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** One disposable world: a bare remote, a primary checkout, and a slot. */
export type Sandbox = {
  /** Root of everything this sandbox created. Always under `os.tmpdir()`. */
  root: string;
  /** The bare repository standing in for `origin`. */
  origin: string;
  /** The clone standing in for the primary checkout. */
  primary: string;
  /** `<primary>/.claude/worktrees` - where slots live. */
  worktreesRoot: string;
  /** Directory holding the fake `yarn`, `gh` and `lsof`. */
  fakeBin: string;
  /** File the fake `yarn` appends its arguments to, one invocation per line. */
  yarnLog: string;
};

/** Environment every git and script invocation in a sandbox runs under. */
const sandboxEnv = (box: Sandbox): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${box.fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
  WT_TEST_YARN_LOG: box.yarnLog,
});

/** Run git in `cwd`, throwing with captured output when it fails. */
export const git = (box: Sandbox, cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: sandboxEnv(box),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Run git without throwing, for the cases where failure is the assertion. */
export const gitTry = (
  box: Sandbox,
  cwd: string,
  ...args: string[]
): SpawnSyncReturns<string> =>
  spawnSync("git", args, {
    cwd,
    env: sandboxEnv(box),
    encoding: "utf8",
  });

/**
 * The fakes. `yarn` records and succeeds; `gh` and `lsof` say nothing, so the
 * script's optional paths through them are deterministic and offline.
 *
 * `yarn` is a real file rather than a shell function because the scripts
 * invoke it as a command, and `command -v` has to find it.
 */
const writeFakes = (fakeBin: string): void => {
  fs.mkdirSync(fakeBin, { recursive: true });

  fs.writeFileSync(
    path.join(fakeBin, "yarn"),
    [
      "#!/usr/bin/env bash",
      '[ -n "${WT_TEST_YARN_LOG:-}" ] && printf \'%s\\n\' "$*" >> "$WT_TEST_YARN_LOG"',
      // The real `yarn prisma generate` creates this directory, and
      // wt-state.sh checks for it before recording a fingerprint. A fake that
      // skipped it would make every generate look like a failure.
      'if [ "$1" = "prisma" ] && [ "$2" = "generate" ]; then',
      "  mkdir -p node_modules/.prisma/client",
      "fi",
      // `yarn prepare` runs husky, which creates .husky/_.
      'if [ "$1" = "prepare" ]; then mkdir -p .husky/_; fi',
      '[ "${WT_TEST_YARN_FAIL:-}" = "1" ] && exit 1',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });

  // Reports nothing by default. A test that needs the busy-slot refusal
  // overwrites this with one that reports a process.
  fs.writeFileSync(
    path.join(fakeBin, "lsof"),
    "#!/usr/bin/env bash\nexit 1\n",
    { mode: 0o755 },
  );
};

/** Make `lsof` claim a process is sitting in the slot. */
export const makeSlotLookBusy = (box: Sandbox): void => {
  fs.writeFileSync(
    path.join(box.fakeBin, "lsof"),
    [
      "#!/usr/bin/env bash",
      "printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n'",
      "printf 'bash 4242 test cwd DIR 1,2 320 99 /slot\\n'",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
};

/**
 * The minimum tracked content the scripts read: manifests for the dependency
 * fingerprint and a schema for the Prisma one.
 */
const seedContent = (dir: string): void => {
  fs.mkdirSync(path.join(dir, "prisma"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sandbox", version: "1.0.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dir, "yarn.lock"), "# sandbox lockfile\n");
  fs.writeFileSync(
    path.join(dir, "prisma", "schema.prisma"),
    'generator client {\n  provider = "prisma-client-js"\n}\n',
  );
  fs.writeFileSync(path.join(dir, "README.md"), "sandbox\n");
  // Committed on `main`, so a freshly added slot sits exactly at origin/main
  // and is "already merged" by default. A test that wants an unmerged slot
  // makes its own commit.
  // Tracked, like the real one. A test that wrote it into the slot would make
  // the working tree dirty and get refused for the wrong reason.
  fs.writeFileSync(
    path.join(dir, ".env.example"),
    "DATABASE_URL=\nTEST_DATABASE_URL=\nMAPBOX_ACCESS_TOKEN=\n",
  );
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    "/node_modules\n/.next/\n/coverage\n.env\n.env.production\n",
  );
};

/** The scripts under test, copied in so the sandbox exercises real files. */
const installScripts = (primary: string, names: string[]): void => {
  const from = path.resolve(__dirname);
  const to = path.join(primary, "scripts");
  fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
    fs.chmodSync(path.join(to, name), 0o755);
  }
};

/**
 * Build a sandbox: bare origin with a `main` branch, a primary clone, and
 * `.claude/worktrees/` ready for slots.
 *
 * `withMain: false` produces an origin with no `main` at all, which is how the
 * missing-`origin/main` refusal is reached.
 */
export const makeSandbox = (
  opts: { withMain?: boolean; scripts?: string[] } = {},
): Sandbox => {
  const withMain = opts.withMain ?? true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-sandbox-"));
  const box: Sandbox = {
    root,
    origin: path.join(root, "origin.git"),
    primary: path.join(root, "primary"),
    worktreesRoot: path.join(root, "primary", ".claude", "worktrees"),
    fakeBin: path.join(root, "fakebin"),
    yarnLog: path.join(root, "yarn.log"),
  };

  writeFakes(box.fakeBin);
  fs.writeFileSync(box.yarnLog, "");

  git(
    box,
    root,
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    box.origin,
  );
  git(box, root, "clone", "--quiet", box.origin, box.primary);

  seedContent(box.primary);
  installScripts(box.primary, opts.scripts ?? ["wt-recycle.sh", "wt-state.sh"]);
  git(box, box.primary, "add", "-f", ".");
  git(box, box.primary, "commit", "--quiet", "-m", "sandbox base");

  if (withMain) {
    git(box, box.primary, "push", "--quiet", "origin", "main");
  } else {
    // An origin that has never had `main`. The clone's local branch is
    // renamed away so nothing can push it back by accident.
    git(box, box.primary, "branch", "--move", "trunk");
  }

  fs.mkdirSync(box.worktreesRoot, { recursive: true });
  git(box, box.primary, "fetch", "--quiet", "origin");
  return box;
};

/**
 * Add a slot worktree at `.claude/worktrees/<slot>` on a new branch, and give
 * it the untracked-but-ignored state a bootstrapped worktree has: `.env`,
 * `node_modules`, and build output.
 *
 * `base` defaults to `origin/main`; the no-main sandbox passes `trunk`.
 */
export const addSlot = (
  box: Sandbox,
  slot: string,
  branch: string,
  opts: { base?: string; env?: string; existing?: boolean } = {},
): string => {
  const target = path.join(box.worktreesRoot, slot);
  const base = opts.base ?? "origin/main";
  if (opts.existing) {
    // Check out a branch that already exists, which is the only way to put a
    // slot on `main` or `staging`. The primary has to be off that branch
    // first - git allows one worktree per branch.
    git(box, box.primary, "worktree", "add", "--quiet", target, branch);
  } else {
    git(
      box,
      box.primary,
      "worktree",
      "add",
      "--quiet",
      "--no-track",
      "-b",
      branch,
      target,
      base,
    );
  }

  fs.writeFileSync(
    path.join(target, ".env"),
    opts.env ??
      'DATABASE_URL="mysql://u:p@127.0.0.1:3306/nucarpool"\nTEST_DATABASE_URL="mysql://u:p@127.0.0.1:3306/nucarpool_test_scrum"\nMAPBOX_ACCESS_TOKEN="pk.test"\n',
  );
  fs.mkdirSync(path.join(target, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(target, "node_modules", "sentinel"), "warm\n");
  fs.mkdirSync(path.join(target, ".husky", "_"), { recursive: true });
  fs.mkdirSync(path.join(target, ".next"), { recursive: true });
  fs.writeFileSync(path.join(target, ".next", "build"), "stale\n");
  fs.mkdirSync(path.join(target, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(target, "coverage", "lcov.info"), "stale\n");

  return target;
};

/** Land a branch on the origin's `main`, the way a merged pull request would. */
export const mergeIntoOriginMain = (box: Sandbox, branch: string): void => {
  const merger = path.join(
    box.root,
    `merger-${branch.replace(/[^a-zA-Z0-9]/g, "-")}`,
  );
  git(box, box.root, "clone", "--quiet", box.origin, merger);
  git(
    box,
    merger,
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    `Merge ${branch}`,
    `origin/${branch}`,
  );
  git(box, merger, "push", "--quiet", "origin", "main");
  git(box, box.primary, "fetch", "--quiet", "origin");
};

/** The result of running one of the scripts under test. */
export type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for asserting on a message either may carry. */
  output: string;
};

/** Run a script from the sandbox's own `scripts/` directory. */
export const runScript = (
  box: Sandbox,
  script: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Run => {
  const result = spawnSync(
    "bash",
    [path.join(box.primary, "scripts", script), ...args],
    {
      cwd: opts.cwd ?? box.primary,
      env: { ...sandboxEnv(box), ...(opts.env ?? {}) },
      encoding: "utf8",
      // No terminal is attached, which is deliberate: nothing in these scripts
      // may depend on one.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
};

/**
 * Source a script from the sandbox's `scripts/` directory and run shell code
 * against it. This is how `wt-state.sh`'s functions are exercised directly,
 * rather than only through the callers that happen to use them.
 */
export const runInline = (
  box: Sandbox,
  cwd: string,
  body: string,
  opts: { env?: Record<string, string> } = {},
): Run => {
  const script = [
    "set -euo pipefail",
    `. "${path.join(box.primary, "scripts", "wt-state.sh")}"`,
    body,
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...sandboxEnv(box), ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
};

/** Every argument list the fake `yarn` was called with. */
export const yarnCalls = (box: Sandbox): string[] =>
  fs
    .readFileSync(box.yarnLog, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** Does a local branch exist? */
export const localBranchExists = (box: Sandbox, branch: string): boolean =>
  gitTry(
    box,
    box.primary,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ).status === 0;

/** Does a branch exist on the origin? Read from the bare repo itself. */
export const remoteBranchExists = (box: Sandbox, branch: string): boolean =>
  gitTry(
    box,
    box.origin,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ).status === 0;

/** Is `commit` reachable from `ref`? The no-commit-lost assertion. */
export const isReachableFrom = (
  box: Sandbox,
  commit: string,
  ref: string,
): boolean =>
  gitTry(box, box.primary, "merge-base", "--is-ancestor", commit, ref)
    .status === 0;

/**
 * Delete a sandbox, refusing any path that is not under the system temp
 * directory. The tests build and destroy directories in a loop, so this check
 * is the thing standing between a bug in a path calculation and a real
 * directory.
 */
export const removeTree = (target: string): void => {
  const resolved =
    fs.realpathSync(path.dirname(target)) + path.sep + path.basename(target);
  const tmp = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: not under ${tmp}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
};
