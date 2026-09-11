#!/usr/bin/env bash
#
# Point a reusable worktree slot at a new ticket branch, keeping its warm state.
#
#     ./scripts/wt-recycle.sh <slot> <new-branch-name>
#     ./scripts/wt-recycle.sh scrum scrum-451-explore-page-empty-state
#
# A slot is a long-lived directory under `.claude/worktrees/` that holds one
# ticket at a time and many tickets in sequence. Recycling switches it from the
# branch of a finished ticket to the branch of the next one, so the next
# session inherits `node_modules`, the generated Prisma client and the husky
# hooks instead of paying for them again.
#
#     ONE TICKET  = ONE FRESH CLAUDE SESSION
#     ONE TICKET  = ONE ISOLATED WORKTREE SLOT
#     ONE TICKET != ONE PERMANENT WORKTREE DIRECTORY
#
# The slot outlives the ticket. The Claude conversation does not: a reusable
# directory is not licence to run a second ticket in one session.
#
# Only two slot names exist, and they are an explicit allowlist rather than a
# pattern. Inferring "reusable" from a path shape would make every future
# directory whose name happened to match recyclable by accident, including a
# task worktree.
#
# Task-specific worktrees are unaffected and remain the right tool for schema
# or migration work, blocked or long-lived tickets, a third concurrent stream,
# and any unusual git state. They keep their own lifecycle:
# `claude --worktree <task>`, `wt-bootstrap.sh`, `wt-cleanup.sh <task>`.
#
# ---------------------------------------------------------------------------
# Who is allowed to run this
#
# A human, and only between tickets. **A Claude session must never recycle the
# slot it is working in**, delete its own branch, or remove its own worktree.
#
# The gate is `git worktree lock`. A session claims its slot by locking it, and
# this script refuses a locked slot outright - so recycling takes two
# deliberate human commands, `git worktree unlock` and then this one.
#
# That is also the marker Claude Code already uses: a worktree it creates with
# `claude --worktree` is locked on its behalf, with a reason naming the session
# and pid. A live session's workspace is therefore refused here without anyone
# having to remember to do anything. A slot created by hand with
# `git worktree add` is not locked automatically, so handing one to a session
# is an explicit `git worktree lock`.
#
# There is deliberately no `--yes`, no `--force` and no environment variable
# that skips a check, so there is nothing to bypass and nothing that can be set
# once in a wrapper and then be permanent and invisible. `seedGuard.ts` lost
# its `SEED_ALLOW_REMOTE` for that reason and this follows it. There is also no
# interactive prompt: `wt-cleanup.sh` removes a worktree and deletes a branch
# without one, the refusals below are the actual safety, and a prompt that only
# appears on a terminal cannot be exercised by the test suite.
#
# Nothing here runs unattended. It is never invoked by a hook, a hint or a
# schedule.
#
# ---------------------------------------------------------------------------
# What it refuses
#
# Built to refuse rather than guess, like `wt-cleanup.sh`. Every one of these
# must hold before anything is mutated:
#
#   - exactly two arguments, and the slot is literally `scrum` or `infra`
#   - we are inside this repository, and the slot is a registered *linked*
#     worktree exactly one level under <primary>/.claude/worktrees/
#   - the slot is neither the primary checkout nor the worktree this is running
#     from, and is neither locked nor prunable
#   - no rebase, merge, cherry-pick, revert, bisect or sequencer is in progress
#   - HEAD there is a branch rather than detached, and that branch is not
#     `main` or `staging`
#   - `git status --porcelain` in it is empty - no modified tracked files and no
#     untracked ones. Ignored files are not consulted, which is what lets
#     `node_modules` and `.env` survive
#   - no other worktree has that branch checked out
#   - no stash entry was taken from that branch
#   - `.env` exists, and `.env.production` does not
#   - `origin/main` exists and every commit on the branch is reachable from it
#   - the new branch name is a valid ref, is not `main` or `staging`, is not the
#     branch already checked out, and exists neither locally nor on the remote
#
# ---------------------------------------------------------------------------
# Ordering: switch before delete
#
# The strongest property this script has is that **no failure can make a
# reachable commit unreachable**. That follows from the order, not from the
# checks:
#
#     validate everything local
#     -> verify the old branch is merged into origin/main as it stands
#     -> fetch origin
#     -> verify it again against fresh refs          (this one is authoritative)
#     -> re-validate the new branch against fresh refs
#     -> create and switch to the new branch from origin/main
#     -> delete the old local branch with a plain, non-force `-d`
#     -> reconcile generated state
#
# The switch is what frees the old branch to be deleted, so it must come first.
# If the switch fails, nothing has changed. If the delete fails, the slot is
# already on the new branch and the old branch is still there - untidy, and
# reported as such, but nothing is lost. The reverse order has a window where
# the branch is gone and the switch has not happened.
#
# The pre-fetch merge check is an early, cheap refusal and is *not* fatal on its
# own: a stale `origin/main` can only make it refuse work that really is
# merged, so a failure there falls through to the fetch, which may resolve it.
# The post-fetch check is the one that decides. Re-checking after the fetch also
# catches an `origin/main` that moved backwards.
#
# Both git mutations are the plain non-force commands, so git's own refusals
# stay the last line of defence. It never runs `git branch -D`,
# `git worktree remove --force`, `git reset --hard`, `git clean` or a force
# push, and it never deletes a remote branch or touches the shared stash.

set -euo pipefail

die() { printf 'wt-recycle: %s\n' "$1" >&2; exit 1; }
refuse() { printf 'wt-recycle: refusing - %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
warn() { printf '    !! %s\n' "$1"; }

# The only reusable slots. An allowlist, not a pattern.
RECYCLABLE_SLOTS="scrum infra"

# Generated directories cleared on recycle, by name, because a branch switch
# does not touch ignored files - anything generated for the finished ticket
# would otherwise be inherited by the next one.
#
# This list is exhaustive on purpose. There is no `git clean -xdf` here and no
# sweep of ignored files: `node_modules` is the warm state the whole slot
# exists to preserve, and `.env` is unreproducible. Both are ignored, so a
# generic clean would take them.
GENERATED_STATE=".next coverage"

usage() {
  printf 'usage: %s <slot> <new-branch-name>\n' "${0##*/}" >&2
  printf '\n  slot must be one of: %s\n' "$RECYCLABLE_SLOTS" >&2
  printf '\n  e.g. %s scrum scrum-451-explore-page-empty-state\n' "${0##*/}" >&2
  printf '\n  Retire a task-specific worktree with wt-cleanup.sh instead.\n' >&2
  exit 1
}

case "${1:-}" in -h | --help) usage ;; esac
[ "$#" -eq 2 ] || usage
slot=$1
new_branch=$2

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository."

# ------------------------------------------------------------------ the slot
#
# Checked first, and against the literal allowlist, so an unknown slot is
# reported as an unknown slot rather than as a missing directory.
slot_allowed=no
for candidate in $RECYCLABLE_SLOTS; do
  [ "$slot" = "$candidate" ] && slot_allowed=yes
done
[ "$slot_allowed" = yes ] ||
  refuse "'$slot' is not a reusable slot. Only these are: $RECYCLABLE_SLOTS
             A task-specific worktree is retired with wt-cleanup.sh, not recycled."

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

# Resolved once, before anything below changes directory, so that sourcing
# wt-state.sh after the `cd` into the target still finds this script's own
# companion rather than the target branch's copy of it.
script_dir=$(abspath "$(dirname "$0")")
[ -f "$script_dir/wt-state.sh" ] ||
  die "cannot find wt-state.sh beside this script (looked in $script_dir)."

# The worktree table as path<TAB>branch<TAB>flags. `branch` is empty for a
# detached HEAD; `flags` collects locked/prunable. `locked` may carry a reason,
# so the pattern matches the prefix.
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

# The first entry is always the primary worktree - that is how the primary is
# located without hard-coding a path that is only right on one machine.
primary=$(printf '%s\n' "$table" | head -1 | cut -f1)
[ -n "$primary" ] && [ -d "$primary" ] || die "could not locate the primary worktree."
primary=$(abspath "$primary")
worktrees_root="$primary/.claude/worktrees"
target=$(abspath "$worktrees_root/$slot")

step "target"
note "slot:     $slot"
note "worktree: $target"
note "primary:  $primary"

[ "$target" != "$primary" ] ||
  refuse "that resolved to the primary checkout, which is never recycled."

here=$(abspath "$(git rev-parse --show-toplevel)")
[ "$target" != "$here" ] ||
  refuse "that is the worktree this script is running from. A session must never
             recycle its own slot - it would switch the branch under its own feet.
             Run it from the primary checkout instead:
             cd $primary && ./scripts/wt-recycle.sh $slot $new_branch"

# Exactly one level under .claude/worktrees/, so a deeper path or a traversal
# out of the tree cannot be reached even if the allowlist were widened.
[ "${target%/*}" = "$worktrees_root" ] ||
  refuse "$target is not directly under $worktrees_root."

# --------------------------------------------------------------- registration
entry=$(printf '%s\n' "$table" | awk -F'\t' -v t="$target" '$1 == t' || true)
[ -n "$entry" ] ||
  refuse "no worktree is registered at $target.
             Reusable slots are created once, by hand:
             git worktree add --no-track -b <branch> $target origin/main
             cd $target && ./scripts/wt-bootstrap.sh"

flags=$(printf '%s\n' "$entry" | cut -f3)
case "$flags" in
  *prunable*)
    refuse "git reports that worktree as prunable, so its directory is already gone.
             Deregister it with:  git worktree prune"
    ;;
  *locked*)
    lock_reason=$(git worktree list --porcelain |
      awk -v t="$target" '$0 == "worktree " t {f=1; next} f && /^locked/ {print substr($0, 8); exit} f && /^$/ {exit}' || true)
    refuse "that slot is locked, which is how a session says it is still using it.
             ${lock_reason:+lock reason: $lock_reason}
             Confirm the ticket is merged and the session has ended, then unlock
             it deliberately:
             git worktree unlock $target"
    ;;
esac

# ------------------------------------------------------- mid-operation states
#
# A slot part-way through a rebase, merge, cherry-pick, revert, bisect or
# sequencer has commits and index state that a branch switch would strand.
# `git status --porcelain` does not report any of them on its own.
target_git_dir=$(git -C "$target" rev-parse --absolute-git-dir)
for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG sequencer; do
  [ -e "$target_git_dir/$marker" ] &&
    refuse "that slot has an operation in progress ($marker). Finish or abort it
             there first; switching branches under it would strand its state."
done

# --------------------------------------------------------------------- branch
branch=$(printf '%s\n' "$entry" | cut -f2)
[ -n "$branch" ] ||
  refuse "HEAD in that slot is detached, so there is no branch to account for and
             commits made there may be reachable from nothing else.
             Put them on a branch before recycling it."

case "$branch" in
  main | staging)
    refuse "that slot has '$branch' checked out. Protected branches are never
             deleted here, and a slot holding one is not mid-ticket."
    ;;
esac
note "on branch: $branch"

other=$(printf '%s\n' "$table" | awk -F'\t' -v b="$branch" -v t="$target" '$2 == b && $1 != t {print $1}' || true)
[ -z "$other" ] ||
  refuse "branch '$branch' is also checked out at:
             $other
             Deleting it here would leave that worktree on a deleted branch."

# ----------------------------------------------------------------- clean tree
#
# Plain `status --porcelain`, no `--ignored` - the same question
# `git worktree remove` asks. Untracked files refuse because a branch switch
# does not remove them: they would silently follow the slot into the next
# ticket and end up in its diff.
step "state"
dirty=$(git -C "$target" status --porcelain)
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty" | sed 's/^/    /' >&2
  refuse "that slot has modified or untracked files (above). Commit them on
             '$branch', or discard them yourself if you are certain they are
             worthless. Recycling does not decide that for you."
fi
note "working tree clean - no modified files, no untracked files."

# ------------------------------------------------------------- shared stash
#
# `refs/stash` lives in the common git dir, so one stack is shared by every
# worktree in this repository. This script never pushes, pops, applies, drops
# or clears it - popping would hand another worktree's work to this one.
#
# It does refuse on entries taken from the branch being retired. Those are not
# at risk of being lost - a stash commit is reachable from `refs/stash`
# regardless of what happens to the branch - but they are work someone set
# aside on a ticket that is about to leave this slot, and after the recycle the
# branch named in the entry will no longer exist locally to apply it back onto.
# Surfacing it while it can still be dealt with is worth one refusal.
#
# A blanket refusal on any stash entry would be unusable: a shared stack
# accumulates unrelated entries from other worktrees that have nothing to do
# with this slot.
mine=$(git stash list --format='%gd %gs' 2>/dev/null |
  awk -v b="$branch" '$0 ~ ("(On|WIP on) " b ":") {print}' || true)
if [ -n "$mine" ]; then
  printf '%s\n' "$mine" | sed 's/^/    /' >&2
  refuse "the shared stash holds entries taken from '$branch' (above).
             This script will not touch the stash - inspect them and deal with
             them yourself, then recycle:
             git stash show -p <entry>
             git stash apply <entry>    # apply, never pop, on a shared stack"
fi
stash_total=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
note "shared stash: $stash_total entr$([ "$stash_total" = 1 ] && echo y || echo ies), none from '$branch'; left untouched."

# --------------------------------------------------------------- environment
#
# `.env` is a regular, independent, per-worktree file. It is never a symlink,
# never printed, never compared by value and never overwritten from the primary
# checkout. Only its presence is required, and only variable *names* are ever
# compared - a value diff of a credentials file is not something this script
# will do.
step "environment"
[ ! -L "$target/.env" ] ||
  refuse "$slot/.env is a symlink. It must be a regular, independent file:
             a shared .env means one slot's edit silently changes another's."
[ -f "$target/.env" ] ||
  refuse "that slot has no .env. Recycling would hand the next ticket a slot
             whose dev server, Prisma CLI and yarn test:db cannot run.
             Copy one in first - it is never written by this script."
note ".env present, and left exactly as it is."

# Written by the Amplify build container from real deployment credentials, so
# its presence on a developer machine is a problem in itself, never mind in a
# slot about to be handed to another ticket.
[ ! -e "$target/.env.production" ] ||
  refuse "$slot/.env.production exists. That file is written by the Amplify build
             from real deployment credentials and must never exist locally.
             Remove it deliberately, having understood where it came from."

# Names only. `envsafe` validates at import time, so a name the branch requires
# and the slot lacks is a startup failure, and worth reporting before the
# handover rather than after.
if [ -f "$target/.env.example" ]; then
  env_names() { grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*' "$1" 2>/dev/null | tr -d '[:space:]' | sort -u; }
  missing=$(comm -23 <(env_names "$target/.env.example") <(env_names "$target/.env") || true)
  if [ -n "$missing" ]; then
    warn "names in .env.example with no entry in this slot's .env:"
    printf '%s\n' "$missing" | sed 's/^/       /'
    warn "values were not read or compared. Optional variables may be absent legitimately."
  else
    note "every name in .env.example has an entry in .env (names only; no values read)."
  fi
fi

# ------------------------------------------------------- integration database
#
# Per-slot integration databases are deferred, so this reports rather than
# enforces - requiring `nucarpool_test_<slot>` before anyone has created it
# would make the slots unusable. Only the database *name* is parsed out of the
# URL; the credentials in it are never read or printed.
#
# It does refuse on a name `testDatabaseGuard.ts` would itself refuse, because
# `yarn test:db` TRUNCATEs every table in whatever it is pointed at. That
# refusal costs nothing a human could otherwise have done - the guard fails
# closed on the same names - and surfaces it before the slot changes hands.
test_db_name=$(sed -n 's/^[[:space:]]*TEST_DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$target/.env" 2>/dev/null |
  tail -1 | tr -d '"'"'"' \r' | sed -e 's/?.*$//' -e 's#^.*/##' || true)
if [ -z "$test_db_name" ]; then
  note "no TEST_DATABASE_URL in this slot's .env; yarn test:db will refuse there."
else
  lowered=$(printf '%s' "$test_db_name" | tr '[:upper:]' '[:lower:]')
  for forbidden in prod stag live main; do
    case "$lowered" in
      *"$forbidden"*)
        refuse "this slot's TEST_DATABASE_URL names the database '$test_db_name',
             which contains '$forbidden'. yarn test:db TRUNCATEs every table in
             whatever it is aimed at. testDatabaseGuard.ts refuses this name too.
             Point it at a dedicated test database before recycling."
        ;;
    esac
  done
  case ":$(printf '%s' "$lowered" | tr '_-' '::'):" in
    *:test:*) ;;
    *)
      refuse "this slot's TEST_DATABASE_URL names the database '$test_db_name',
             which is not marked as a test database. testDatabaseGuard.ts
             requires a 'test' word - nucarpool_test, not nucarpool."
      ;;
  esac
  note "TEST_DATABASE_URL names database '$test_db_name' (no credentials read)."
  if [ "$test_db_name" != "nucarpool_test_$slot" ]; then
    warn "the intended per-slot database for '$slot' is nucarpool_test_$slot."
    warn "until that exists, two slots running yarn test:db against one database"
    warn "will truncate each other's tables - the harness does not lock. Deferred."
  fi
fi

# --------------------------------------------------------- advisory liveness
#
# Reported, never trusted. `lsof` finds a process whose working directory is in
# the slot, which catches the common case of a shell or editor sitting there.
# **A miss is not proof the slot is unused**: a Claude session holds no such
# handle, and neither does an agent that has merely read the directory. The
# lock above is the mechanism; this is a courtesy.
if command -v lsof >/dev/null 2>&1; then
  busy=$(lsof -a -d cwd -- "$target" 2>/dev/null | awk 'NR>1 {print $1, $2}' | sort -u || true)
  if [ -n "$busy" ]; then
    step "something is sitting in that slot"
    printf '%s\n' "$busy" | sed 's/^/    /'
    refuse "a process has its working directory inside that slot (above).
             Close it, or confirm it is finished, then recycle."
  fi
fi

# ------------------------------------------------------- the new branch name
step "new branch"
git check-ref-format --branch "$new_branch" >/dev/null 2>&1 ||
  refuse "'$new_branch' is not a valid git branch name."
case "$new_branch" in
  main | staging)
    refuse "'$new_branch' is a protected branch. A slot holds ticket branches only."
    ;;
esac
[ "$new_branch" != "$branch" ] ||
  refuse "'$new_branch' is the branch already checked out in that slot.
             Recycling onto itself would delete the branch it had just switched to."
git rev-parse --verify --quiet "refs/heads/$new_branch" >/dev/null &&
  refuse "a local branch '$new_branch' already exists. Recycling would have to
             adopt or overwrite it, and it does neither - pick another name, or
             deal with that branch deliberately."
note "'$new_branch' is valid, unprotected, and does not exist locally."

# --------------------------------------------------- merge evidence, pre-fetch
#
# Not fatal on its own. A stale origin/main can only make this refuse work that
# really is merged, so a failure here falls through to the fetch below.
step "merge evidence"
premerged=no
if git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
  if git merge-base --is-ancestor "$branch" refs/remotes/origin/main 2>/dev/null; then
    premerged=yes
    note "every commit on $branch is already reachable from origin/main as it stands."
  else
    note "$branch is not yet reachable from origin/main as it stands; fetching to re-check."
  fi
else
  note "no origin/main yet; fetching."
fi

# ------------------------------------------------------------------ fetch
#
# Reads from the remote and updates remote-tracking refs. It does not touch any
# working tree, and it is not the point of no return - every refusal below
# still applies. The new branch is created from origin/main, so a fresh
# origin/main is required rather than optional; wt-cleanup.sh can decline to
# fetch because it only ever deletes.
step "fetching origin"
git -C "$target" fetch origin
note "fetched."

git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null ||
  die "no refs/remotes/origin/main even after fetching. Cannot create a branch
             from a base that does not exist."
base=$(git rev-parse refs/remotes/origin/main)
note "origin/main is now ${base:0:12}."

# ------------------------------------------- merge evidence, against fresh refs
#
# The authoritative check. Re-run after the fetch both because the fetch may
# have resolved a pre-fetch failure and because it catches an origin/main that
# moved backwards since.
if ! git merge-base --is-ancestor "$branch" refs/remotes/origin/main; then
  ahead=$(git rev-list --count "refs/remotes/origin/main..$branch")
  printf 'wt-recycle: refusing - %s commit(s) on %s are not reachable from origin/main:\n' \
    "$ahead" "$branch" >&2
  git log --no-decorate --oneline --max-count=10 "refs/remotes/origin/main..$branch" |
    sed 's/^/    /' >&2
  [ "$ahead" -gt 10 ] && printf '    ... and %s more\n' "$((ahead - 10))" >&2
  # GitHub state helps you decide and is never accepted as proof: a squash or
  # rebase merge lands the content on main without making the branch an
  # ancestor, so a MERGED pull request can coexist with this refusal - and a
  # non-force `git branch -d` could not act on it either. That call stays yours.
  if command -v gh >/dev/null 2>&1; then
    pr=$(gh pr list --head "$branch" --state all --limit 1 \
      --json number,state,url --jq '.[] | "#\(.number) \(.state) \(.url)"' 2>/dev/null || true)
    [ -n "${pr:-}" ] && printf '    github: pull request %s\n' "$pr" >&2
  fi
  printf '    the ticket in that slot is not finished. Recycling it now would\n' >&2
  printf '    delete a branch whose work is nowhere else.\n' >&2
  exit 1
fi
[ "$premerged" = yes ] || note "the fetch resolved it."
note "every commit on $branch is reachable from origin/main."

# ------------------------------------- the new branch name, against fresh refs
#
# Re-checked here because the fetch may have just brought the remote branch
# into view. A name already on the remote means someone else is using it, or
# this ticket already had a branch that was pushed - either way, creating a
# second unrelated history under that name is not something to do silently.
if git rev-parse --verify --quiet "refs/remotes/origin/$new_branch" >/dev/null; then
  refuse "origin/$new_branch already exists on the remote. Recycling would create
             a local branch at origin/main that would then conflict with it.
             If that branch is this ticket's earlier work, check it out instead:
             git -C $target switch $new_branch"
fi
git rev-parse --verify --quiet "refs/heads/$new_branch" >/dev/null &&
  refuse "a local branch '$new_branch' appeared while this was running. Stopping."
note "'$new_branch' exists neither locally nor on the remote."

# =========================================================================
# Everything above refuses. Everything below mutates.
# =========================================================================

step "recycling $slot: $branch -> $new_branch"

# Switch first. This is what frees the old branch to be deleted, and if it
# fails nothing has changed at all.
if ! git -C "$target" switch --no-track -c "$new_branch" refs/remotes/origin/main; then
  die "could not create and check out '$new_branch' in that slot.
             Nothing was deleted - the slot is still on '$branch'."
fi

# Confirm rather than assume: everything after this deletes a branch, and it
# must not run if the slot is not actually on the new one.
now=$(git -C "$target" symbolic-ref --quiet --short HEAD) ||
  die "the slot's HEAD is detached after the switch. Nothing was deleted."
[ "$now" = "$new_branch" ] ||
  die "expected the slot to be on '$new_branch' but it is on '$now'.
             Nothing was deleted."
note "slot is on '$new_branch' at ${base:0:12} (from origin/main)."

# `git branch -d` compares a branch against its upstream, or against HEAD when
# it has no upstream. Slot branches are created with --no-track, so supplying
# the upstream with `git -c` for this one invocation points git's own non-force
# check at origin/main - the same question answered above - without writing
# anything to config. It still refuses an unmerged branch, which is the whole
# reason for using -d rather than -D.
if git -C "$target" \
  -c "branch.$branch.remote=origin" \
  -c "branch.$branch.merge=refs/heads/main" \
  branch --delete "$branch"; then
  note "old local branch deleted: $branch"
else
  printf 'wt-recycle: the slot is on %s, but git declined to delete %s.\n' "$new_branch" "$branch" >&2
  printf '    That is git own safety check and it has not been overridden.\n' >&2
  printf '    Nothing is lost: the slot is recycled and %s is still here.\n' "$branch" >&2
  printf '    Inspect it with:  git log --oneline origin/main..%s\n' "$branch" >&2
  exit 1
fi

# --------------------------------------------------------- generated state
#
# A branch switch leaves ignored files alone, so the finished ticket's build
# output is still here. Cleared by name from the allowlist above, with each
# path re-checked against that list immediately before it is removed - so this
# cannot be turned into a general delete by a later edit to the list's
# construction.
step "generated state"
for name in $GENERATED_STATE; do
  case " $GENERATED_STATE " in *" $name "*) ;; *) die "refusing to remove unlisted '$name'." ;; esac
  case "$name" in */* | .. | . | '') die "refusing to remove suspicious entry '$name'." ;; esac
  path="$target/$name"
  [ "$path" = "$target/$name" ] || die "refusing to remove '$path'."
  if [ -L "$path" ]; then
    warn "$name is a symlink; left alone rather than followed."
  elif [ -e "$path" ]; then
    rm -rf -- "$path"
    note "cleared $name"
  else
    note "$name absent already."
  fi
done
note "node_modules and .env were not candidates and are untouched."

# ------------------------------------------------- dependencies, prisma, husky
#
# Reconciled against the branch now checked out, never against the primary
# checkout. The slot's warm state is the point of a slot, and it is only warm
# if it is also correct.
. "$script_dir/wt-state.sh"
cd "$target"

step "dependencies"
wt_reconcile_dependencies

step "prisma client"
wt_reconcile_prisma_client

step "git hooks"
wt_reconcile_husky

# --------------------------------------------------------------------- report
step "left alone"
note "remote:  untouched - no push, and origin/$branch was not deleted."
note ".env:    untouched."
note "stash:   untouched."
if git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
  note "the remote-tracking ref origin/$branch is still here; 'git fetch --prune'"
  note "clears it once GitHub has deleted the remote branch."
fi

step "the slot is ready"
note "$target is on '$new_branch', branched from origin/main at ${base:0:12}."
note ""
note "Claim it for the session that will work the ticket:"
note "    git worktree lock --reason '$new_branch' $target"
note ""
note "Then start ONE FRESH session for ONE ticket in it. A reusable directory"
note "is not licence to run two tickets in one conversation."
note ""
note "First push, when that session is ready:"
printf '\n    git -C %s push -u origin %s\n' "$target" "$new_branch"

printf '\nwt-recycle: done.\n'
