#!/usr/bin/env bash
#
# Generated-state reconciliation, shared by wt-bootstrap.sh and wt-recycle.sh.
#
# Sourced, not executed:
#
#     . "$(dirname "$0")/wt-state.sh"
#
# Both callers have to answer the same question - "does the generated state in
# this worktree correspond to the source that is checked out right now?" - and
# they have to answer it identically. A bootstrap that regenerates and a
# recycle that skips would leave the same directory in two different states
# depending on which script last touched it, so the rule lives here once.
#
# Every function assumes the caller has already `cd`-ed to the worktree root.

# Both callers define these; defined here too so this file is safe to source
# from anything, and so a missing helper can never be the reason a
# reconciliation step is skipped.
command -v note >/dev/null 2>&1 || note() { printf '    %s\n' "$1"; }

# ------------------------------------------------------------------ fingerprints
#
# The problem being solved: `node_modules/.prisma/client` and `node_modules`
# are generated from sources that change under them, and neither records what
# it was generated from. So nothing can tell a current client from a stale one.
#
# wt-bootstrap.sh used to compare the worktree's `prisma/schema.prisma` with the
# *primary checkout's* copy. That is a statement about two working trees, not
# about the generated client: the primary may be on another branch, dirty, or
# itself never generated. It reads as a freshness check and is not one
# (SCRUM-448). Under reusable slots it is actively wrong, because a slot's
# `node_modules` outlives the branch that generated it.
#
# The fix is to record the fingerprint of the source *inside* the generated
# artefact, so the artefact carries its own provenance. `git hash-object` is
# the hash function: it is deterministic, it is already available because every
# caller requires git, and it avoids the `shasum` / `sha256sum` split between
# macOS and CI. `--no-filters` is load-bearing - without it the hash would run
# the path's gitattributes and `core.autocrlf` through the content, so the same
# file could fingerprint differently on two machines.
#
# The stamps live inside gitignored generated directories, so they are never
# committed and never appear in `git status`. `.gitignore` covers them via
# `/node_modules`.

# The stamp recording which schema generated node_modules/.prisma/client.
PRISMA_CLIENT_DIR="node_modules/.prisma/client"
PRISMA_STAMP="$PRISMA_CLIENT_DIR/.nucarpool-schema-hash"

# The stamp recording which manifests the installed tree was resolved from.
DEPS_STAMP="node_modules/.nucarpool-deps-hash"

# Fingerprint one or more files as a single value. Missing files are fatal
# rather than silently absent: a fingerprint that quietly degrades to the empty
# string would compare equal to another empty one and report a match.
wt_fingerprint() {
  local path
  for path in "$@"; do
    [ -f "$path" ] || {
      printf 'wt-state: cannot fingerprint missing file: %s\n' "$path" >&2
      return 1
    }
  done
  git hash-object --no-filters -- "$@" | tr -d '\n'
}

# Read a stamp, or print nothing when it is absent or unreadable. An absent
# stamp deliberately reads as "no evidence" rather than as any particular
# value, so it can never accidentally match a real fingerprint.
wt_read_stamp() {
  [ -f "$1" ] || return 0
  tr -d '\n' <"$1" 2>/dev/null || true
}

# ------------------------------------------------------------- prisma client
#
# Regenerates only when the evidence says the client does not match the schema
# in this worktree. Three cases regenerate:
#
#   - no client directory at all;
#   - a client with no stamp, which is every worktree bootstrapped before this
#     mechanism existed. There is deliberately no transitional grace here.
#     Nothing recorded what generated those clients, so an absent stamp is not
#     weak evidence of freshness - it is no evidence, and the only safe reading
#     of no evidence is to regenerate. It costs one `prisma generate` per
#     existing worktree, once, and then the stamp is there;
#   - a client whose stamp does not match the current schema.
#
# The stamp is written *after* `prisma generate` succeeds. Written before, an
# interrupted or failing generate would leave a stamp claiming a client that
# was never produced - which is the original bug with extra steps.
wt_reconcile_prisma_client() {
  local schema="prisma/schema.prisma" want have
  [ -f "$schema" ] || {
    note "no $schema in this worktree; nothing to generate."
    return 0
  }

  want=$(wt_fingerprint "$schema") || return 1
  have=$(wt_read_stamp "$PRISMA_STAMP")

  if [ ! -d "$PRISMA_CLIENT_DIR" ]; then
    note "no generated client; generating."
  elif [ -z "$have" ]; then
    note "generated client carries no schema fingerprint; regenerating."
  elif [ "$have" != "$want" ]; then
    note "generated client was built from a different schema; regenerating."
  else
    note "generated client matches $schema (fingerprint ${want:0:12})."
    return 0
  fi

  yarn prisma generate
  [ -d "$PRISMA_CLIENT_DIR" ] || {
    printf 'wt-state: prisma generate left no %s\n' "$PRISMA_CLIENT_DIR" >&2
    return 1
  }
  printf '%s\n' "$want" >"$PRISMA_STAMP"
  note "recorded schema fingerprint ${want:0:12}."
}

# ------------------------------------------------------------- dependencies
#
# The invariant is that the installed tree corresponds to the manifests on the
# branch that is checked out now. A recycled slot keeps its `node_modules`
# across a branch switch, so that is not automatic.
#
# `yarn install --frozen-lockfile` is the reconciliation, and it is the right
# command because it *refuses* to modify `yarn.lock` - a recycle must never
# rewrite the lockfile as a side effect. It is gated on a fingerprint of both
# manifests rather than run unconditionally: an install with a warm
# `node_modules` is not free, and the fingerprint answers exactly the question
# the install would answer.
wt_reconcile_dependencies() {
  local want have
  want=$(wt_fingerprint package.json yarn.lock) || return 1
  have=$(wt_read_stamp "$DEPS_STAMP")

  if [ ! -d node_modules ]; then
    note "no node_modules; installing."
  elif [ -z "$have" ]; then
    note "installed tree carries no manifest fingerprint; reconciling."
  elif [ "$have" != "$want" ]; then
    note "package.json or yarn.lock changed since the last install; reconciling."
  else
    note "installed tree matches package.json and yarn.lock."
    return 0
  fi

  yarn install --frozen-lockfile
  printf '%s\n' "$want" >"$DEPS_STAMP"
  note "recorded manifest fingerprint ${want:0:12}."
}

# --------------------------------------------------------------------- husky
#
# `.husky/_` is generated and gitignored, and `core.hooksPath` is relative, so
# it resolves per worktree. Without it git finds no hooks directory and skips
# the pre-commit formatter *silently* - which is the failure mode that matters,
# because a worktree with no hooks looks identical to one with working hooks
# until a badly formatted commit reaches CI. At least one historical worktree
# was in that state. `yarn prepare` is the repository's own husky invocation.
wt_reconcile_husky() {
  if [ -d .husky/_ ]; then
    note "husky hooks already generated."
  else
    yarn prepare
    note "regenerated .husky/_"
  fi
}
