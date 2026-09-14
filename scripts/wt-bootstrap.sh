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
# It is idempotent - re-running it on a prepared worktree does nothing, which
# it establishes by fingerprint rather than by guessing from the primary
# checkout. Dependencies and the generated Prisma client each record what they
# were built from, in `scripts/wt-state.sh`; re-running compares against those
# stamps. The first run after that mechanism was introduced regenerates once,
# because a worktree prepared before it has no stamp to check.
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

# Sourced before the `cd` so it is found relative to this script rather than to
# wherever it was invoked from. Holds the generated-state reconciliation shared
# with wt-recycle.sh, so a bootstrap and a recycle cannot disagree about
# whether the same directory is up to date.
script_dir=$(abspath "$(dirname "$0")")
[ -f "$script_dir/wt-state.sh" ] ||
  die "cannot find wt-state.sh beside this script (looked in $script_dir)."
. "$script_dir/wt-state.sh"

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

# A clone reflects the primary checkout's tree at the moment it was taken, so a
# branch whose manifests differ has to reconcile. That is decided by
# fingerprint rather than by comparing against the primary: the primary is one
# branch's state among many and has no authority over what this worktree needs.
wt_reconcile_dependencies

# ------------------------------------------------------------- prisma client
#
# The generated client lives in node_modules/.prisma/client, so a clone carries
# whichever client the primary checkout had - and, now, the fingerprint of the
# schema that produced it.
#
# This used to compare this worktree's `prisma/schema.prisma` against the
# *primary checkout's* copy, which is a statement about two working trees and
# not about the generated client (SCRUM-448). The primary may be on another
# branch, dirty, or itself never generated, so the comparison could report a
# match while the client was built from something else entirely.
step "prisma client"
wt_reconcile_prisma_client

# --------------------------------------------------------------------- husky
step "git hooks"
wt_reconcile_husky

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
