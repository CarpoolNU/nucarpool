#!/usr/bin/env bash
#
# Retire a finished task worktree - the teardown counterpart to wt-bootstrap.sh.
#
#     ./scripts/wt-cleanup.sh <worktree-or-task-name>
#
# Removes one linked worktree under `.claude/worktrees/` and deletes the local
# branch it had checked out. Built to refuse rather than guess: every one of
# these must hold before anything is removed.
#
#   - the target is a registered *linked* worktree, exactly one level under
#     <primary>/.claude/worktrees/, and is neither locked nor prunable
#   - it is neither the primary checkout nor the worktree this is running from
#   - HEAD there is a branch rather than detached, and that branch is not
#     `main` or `staging`
#   - `git status --porcelain` in it is empty - no modified files and no
#     untracked ones, which is the same test `git worktree remove` applies
#   - no other worktree has that branch checked out
#   - every commit on the branch is already reachable from `origin/main`
#
# Both removals are the plain, non-force git commands, so git's own refusals
# stay the last line of defence: if git declines, this declines. It never runs
# `git worktree remove --force`, `git branch -D`, `git reset --hard`,
# `git clean` or `rm -rf`, and it never touches the remote - no push, no remote
# branch deletion. GitHub's delete-on-merge already owns that.
#
# It does not fetch, so `origin/main` is however stale your last fetch left it.
# That only ever makes the merge test refuse more, never less.
#
# Re-running it on an already-removed target is a no-op.

set -euo pipefail

die() { printf 'wt-cleanup: %s\n' "$1" >&2; exit 1; }
refuse() { printf 'wt-cleanup: refusing - %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

usage() {
  printf 'usage: %s <worktree-or-task-name>\n' "${0##*/}" >&2
  printf '\n  e.g. %s scrum-443                     (a name under .claude/worktrees/)\n' "${0##*/}" >&2
  printf '       %s .claude/worktrees/scrum-443    (or the path itself)\n' "${0##*/}" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
case "$1" in -h | --help | '') usage ;; esac
target_arg=$1

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository."

# Resolve a path to its physical form. Falls back to resolving the parent when
# the leaf does not exist, which is what makes the already-removed target
# reportable rather than a crash.
abspath() {
  local p=$1 dir base
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ "${p}" != "/" ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
  if [ -d "$p" ]; then (cd "$p" >/dev/null 2>&1 && pwd -P); return; fi
  dir=$(dirname "$p")
  base=$(basename "$p")
  if [ -d "$dir" ]; then dir=$(cd "$dir" >/dev/null 2>&1 && pwd -P); fi
  printf '%s/%s\n' "${dir%/}" "$base"
}

# The worktree table, once, as path<TAB>branch<TAB>flags. `branch` is empty for
# a detached HEAD; `flags` collects locked/prunable, both of which make removal
# something to report rather than attempt.
worktree_table() {
  git worktree list --porcelain | awk '
    function emit() { if (p != "") printf "%s\t%s\t%s\n", p, b, f }
    /^worktree /  { emit(); p = substr($0, 10); b = ""; f = "" }
    /^branch /    { b = substr($0, 8); sub(/^refs\/heads\//, "", b) }
    /^locked/     { f = f "locked " }
    /^prunable/   { f = f "prunable " }
    END           { emit() }
  '
}

table=$(worktree_table)

# The first entry `git worktree list` prints is always the primary worktree.
# That is how the primary is located without hard-coding a path that is only
# right on one machine.
primary=$(printf '%s\n' "$table" | head -1 | cut -f1)
[ -n "$primary" ] && [ -d "$primary" ] || die "could not locate the primary worktree."
primary=$(abspath "$primary")
worktrees_root="$primary/.claude/worktrees"

# A bare name means "under .claude/worktrees/"; anything with a slash is taken
# as a path, so both `scrum-443` and `.claude/worktrees/scrum-443` work.
case "$target_arg" in
  */*) target=$(abspath "$target_arg") ;;
  *) target=$(abspath "$worktrees_root/$target_arg") ;;
esac
name=${target##*/}

step "target"
note "worktree: $target"
note "primary:  $primary"

# ------------------------------------------------------------------ the target
#
# Checked before containment so that naming the primary explains itself rather
# than reporting a directory that happens to sit outside .claude/worktrees/.
[ "$target" != "$primary" ] ||
  refuse "that is the primary checkout. It is not a task worktree and is never removed here."

here=$(abspath "$(git rev-parse --show-toplevel)")
[ "$target" != "$here" ] ||
  refuse "that is the worktree this script is running from. Run it from the primary checkout instead:
             cd $primary && ./scripts/wt-cleanup.sh $name"

# Exactly one level under .claude/worktrees/, so a deeper path, a sibling
# directory or a traversal out of the tree cannot be reached.
[ "${target%/*}" = "$worktrees_root" ] ||
  refuse "$target is not directly under $worktrees_root.
             Only task worktrees one level inside that directory are removable here."
case "$name" in
  '' | . | ..) refuse "'$target_arg' does not name a worktree directory." ;;
esac

# --------------------------------------------------------------- registration
entry=$(printf '%s\n' "$table" | awk -F'\t' -v t="$target" '$1 == t')

if [ -z "$entry" ]; then
  # Idempotence: a target that is neither registered nor present is already
  # cleaned up, and saying so is not an error. A typo'd name is the identical
  # state and cannot be told apart from it, so the registered worktrees are
  # listed here - that is what makes a typo visible instead of looking like a
  # successful no-op.
  if [ ! -d "$target" ]; then
    step "nothing to do"
    note "no worktree is registered at that path and the directory does not exist."
    remaining=$(printf '%s\n' "$table" | awk -F'\t' -v r="$worktrees_root/" '
      index($1, r) == 1 { printf "%s (%s)\n", substr($1, length(r) + 1), ($2 == "" ? "detached" : $2) }')
    if [ -n "$remaining" ]; then
      note "task worktrees that do exist, in case '$name' was a typo:"
      printf '%s\n' "$remaining" | sed 's/^/      /'
    else
      note "there are no task worktrees under $worktrees_root."
    fi
    note "if a local branch for '$name' is still around, delete it with:"
    note "    git branch -d <branch>"
    exit 0
  fi
  refuse "$target exists but git does not know it as a worktree.
             This script only removes registered linked worktrees; an ordinary
             directory is left for you to deal with deliberately."
fi

flags=$(printf '%s\n' "$entry" | cut -f3)
case "$flags" in
  *prunable*)
    refuse "git reports that worktree as prunable, so its directory is already gone.
             Deregister it with:  git worktree prune"
    ;;
  *locked*)
    refuse "that worktree is locked. Unlock it deliberately first:
             git worktree unlock $target"
    ;;
esac

# --------------------------------------------------------------------- branch
branch=$(printf '%s\n' "$entry" | cut -f2)
[ -n "$branch" ] ||
  refuse "HEAD in that worktree is detached, so there is no branch to account for
             and commits made there may be reachable from nothing else.
             Put them on a branch before removing it."

case "$branch" in
  main | staging)
    refuse "that worktree has '$branch' checked out. Protected branches are never
             deleted here, and a worktree holding one is not a task worktree."
    ;;
esac
note "branch:   $branch"

# git itself forbids one branch in two worktrees, so this is belt and braces -
# but a stale registration is exactly the case where deleting the branch would
# pull the rug out from under a checkout that is still live.
other=$(printf '%s\n' "$table" | awk -F'\t' -v b="$branch" -v t="$target" '$2 == b && $1 != t {print $1}')
[ -z "$other" ] ||
  refuse "branch '$branch' is also checked out at:
             $other
             Removing it here would leave that worktree on a deleted branch."

# ----------------------------------------------------------------- clean tree
#
# Plain `status --porcelain` - no `--ignored` - is deliberately the same
# question `git worktree remove` asks, so this refuses for a readable reason
# instead of letting git refuse for a terse one. Ignored files are not
# consulted, which means `node_modules` and `.env` do not block removal and
# will be deleted with the directory. Both are per-worktree copies that
# wt-bootstrap.sh made; the primary checkout's originals are untouched.
step "state"
dirty=$(git -C "$target" status --porcelain)
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty" | sed 's/^/    /' >&2
  refuse "that worktree has modified or untracked files (above). Commit them, or
             discard them yourself if you are certain they are worthless."
fi
note "working tree clean - no modified files, no untracked files."

# ------------------------------------------------------------- merge evidence
#
# The question is not "does the name look finished" but "is every commit on
# this branch reachable from somewhere that is not about to be deleted".
# `git merge-base --is-ancestor <branch> origin/main` answers exactly that, and
# answers it offline. `git branch --merged` is the same test behind a coarser
# interface; `git rev-list origin/main..<branch>` is its useful complement,
# because it says *which* commits would be lost.
git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null ||
  die "no refs/remotes/origin/main to measure against. Run: git fetch origin"

if ! git merge-base --is-ancestor "$branch" refs/remotes/origin/main; then
  ahead=$(git rev-list --count "refs/remotes/origin/main..$branch")
  printf 'wt-cleanup: refusing - %s commit(s) on %s are not reachable from origin/main:\n' \
    "$ahead" "$branch" >&2
  git log --no-decorate --oneline --max-count=10 "refs/remotes/origin/main..$branch" |
    sed 's/^/    /' >&2
  [ "$ahead" -gt 10 ] && printf '    ... and %s more\n' "$((ahead - 10))" >&2
  # GitHub state is reported here to help you decide and is never accepted as
  # proof. A squash or rebase merge lands the content on main without making
  # the branch an ancestor, so a MERGED pull request can coexist with the
  # refusal above - and a non-force `git branch -d` cannot act on it either.
  # Deleting those commits is a judgement call, so it stays yours.
  if command -v gh >/dev/null 2>&1; then
    pr=$(gh pr list --head "$branch" --state all --limit 1 \
      --json number,state,url --jq '.[] | "#\(.number) \(.state) \(.url)"' 2>/dev/null || true)
    [ -n "${pr:-}" ] && printf '    github: pull request %s\n' "$pr" >&2
  fi
  printf '    if origin/main is stale, run: git fetch origin\n' >&2
  exit 1
fi
note "every commit on $branch is reachable from origin/main."

# ------------------------------------------------------------------- removal
step "removing"

git worktree remove "$target"
note "worktree removed: $target"

# `git branch -d` compares the branch against its upstream, or against HEAD
# when it has no upstream (git-branch(1)). Task branches are created with
# --no-track, and this usually runs from a worktree sitting on some unrelated
# feature branch, so the HEAD comparison would refuse work that *is* merged.
# Supplying the upstream with `git -c` for this one invocation points git's own
# non-force check at origin/main - the same question answered above - without
# writing anything to config. It still refuses an unmerged branch, which is the
# whole point of using -d rather than -D.
if git -c "branch.$branch.remote=origin" \
  -c "branch.$branch.merge=refs/heads/main" \
  branch --delete "$branch"; then
  note "local branch deleted: $branch"
else
  die "removed the worktree, but git declined to delete branch '$branch'.
             That is git's own safety check; it has not been overridden.
             Inspect it with:  git log --oneline origin/main..$branch"
fi

step "left alone"
note "remote: untouched - no push, and origin/$branch was not deleted."
if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
  note "the remote-tracking ref origin/$branch is still here; 'git fetch --prune'"
  note "clears it once GitHub has deleted the remote branch."
fi

printf '\nwt-cleanup: done.\n'
