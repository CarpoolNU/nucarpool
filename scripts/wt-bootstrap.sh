#!/usr/bin/env bash
#
# Prepare a linked git worktree for real development.
#
# `git worktree add` checks out tracked files and nothing else, so a new
# worktree has no dependencies, no generated Prisma client and no husky hooks.
# `.worktreeinclude` brings `.env` across when Claude Code creates the
# worktree; this script does the rest. Run it from inside the new worktree:
#
#     cd .claude/worktrees/<name>
#     ./scripts/wt-bootstrap.sh
#
# It is idempotent - re-running it on a prepared worktree does nothing.
#
# What it deliberately does NOT do: create or remove worktrees, start or stop
# Docker, touch `.env`, create databases, or run `git push`/`commit`/`fetch`.
# It prints the first push command rather than running it.

set -euo pipefail

die() { printf 'wt-bootstrap: %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository."

# A linked worktree has its own git dir under the main repository's
# .git/worktrees/; the primary worktree's git dir *is* the common dir. That
# difference is the check, and it needs both paths resolved the same way.
abspath() { (cd "$1" >/dev/null 2>&1 && pwd -P); }
git_dir=$(abspath "$(git rev-parse --absolute-git-dir)")
common_dir=$(abspath "$(git rev-parse --git-common-dir)")
[ "$git_dir" != "$common_dir" ] || die "this is the primary worktree. Run it from .claude/worktrees/<name> instead."

worktree_root=$(git rev-parse --show-toplevel)
cd "$worktree_root"

# The first entry `git worktree list --porcelain` prints is always the primary
# worktree, which is how the primary checkout is located without hard-coding a
# path that is only right on one machine.
primary=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
[ -n "$primary" ] && [ -d "$primary" ] || die "could not locate the primary worktree."
[ "$primary" != "$worktree_root" ] || die "resolved the primary worktree as this one; refusing to continue."

branch=$(git symbolic-ref --quiet --short HEAD) || die "HEAD is detached. Check out a branch first."
case "$branch" in
  main|staging) die "refusing to bootstrap the '$branch' branch." ;;
esac

note "worktree: $worktree_root"
note "primary:  $primary"
note "branch:   $branch"

# ---------------------------------------------------------------- node_modules
#
# Never a symlink. `prisma generate` writes into node_modules/.prisma/client
# and `yarn install` writes through a link, so a shared tree would let one
# worktree silently re-generate another's client or rewrite its dependencies.
#
# `cp -c` asks APFS for a copy-on-write clone: a full, independent tree that
# costs almost no disk until something diverges. It fails on any filesystem or
# platform that cannot clone, and the install below is the fallback for that.
step "dependencies"
if [ -d node_modules ] && [ ! -L node_modules ]; then
  note "node_modules already present; leaving it alone."
elif [ -L node_modules ]; then
  die "node_modules is a symlink. Remove it and re-run: a shared tree is not safe here."
elif [ -d "$primary/node_modules" ]; then
  staging_dir="node_modules.wt-bootstrap.$$"
  rm -rf "$staging_dir"
  if cp -c -R "$primary/node_modules" "$staging_dir" 2>/dev/null; then
    mv "$staging_dir" node_modules
    note "cloned the primary checkout's node_modules (copy-on-write)."
  else
    rm -rf "$staging_dir"
    note "clone unavailable on this filesystem; installing instead."
    yarn install --frozen-lockfile
  fi
else
  note "the primary checkout has no node_modules; installing."
  yarn install --frozen-lockfile
fi

# A clone reflects the primary's lockfile at the moment it was taken, so a
# branch that changes dependencies has to reconcile.
if ! cmp -s package.json "$primary/package.json" || ! cmp -s yarn.lock "$primary/yarn.lock"; then
  step "dependency manifest differs from the primary checkout"
  yarn install --frozen-lockfile
fi

# ------------------------------------------------------------- prisma client
#
# The generated client lives in node_modules/.prisma/client, so a clone carries
# the primary's. That is correct until this branch changes the schema.
step "prisma client"
if ! cmp -s prisma/schema.prisma "$primary/prisma/schema.prisma"; then
  note "schema.prisma differs from the primary checkout; regenerating."
  yarn prisma generate
elif [ -d node_modules/.prisma/client ]; then
  note "generated client present and the schema matches the primary checkout."
else
  note "no generated client; generating."
  yarn prisma generate
fi

# --------------------------------------------------------------------- husky
#
# `.husky/_` is generated and gitignored, and `core.hooksPath` is relative, so
# it resolves per worktree. Without it git finds no hooks directory and skips
# the pre-commit formatter silently. `yarn prepare` is the repository's own
# husky invocation, so this follows whatever husky version is installed.
step "git hooks"
if [ -d .husky/_ ]; then
  note "husky hooks already generated."
else
  yarn prepare
  note "regenerated .husky/_"
fi

# ----------------------------------------------------------------------- env
#
# Never written or edited here - `.worktreeinclude` copies it at creation time.
# Only reported, because its absence explains a whole class of later failure.
step "environment"
if [ -f .env ]; then
  note ".env present."
else
  note "no .env. Lint, tsc and tests still run - they use placeholders from the"
  note "env contract - but the dev server, the Prisma CLI and yarn test:db need it."
fi
note "yarn test:db needs a TEST_DATABASE_URL naming a database no other worktree"
note "uses: the harness truncates every table and does not lock against a second run."

# -------------------------------------------------------------------- upstream
step "branch"
if upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  note "upstream: $upstream"
else
  note "upstream: none (correct for a --no-track branch)."
  note "First push, when you are ready:"
  printf '\n    git push -u origin %s\n' "$branch"
fi

printf '\nwt-bootstrap: done.\n'
