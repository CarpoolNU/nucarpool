#!/bin/bash
# Regression suite for pscale-guard.sh.  Run: .claude/hooks/pscale-guard.test.sh
#
# Fixtures in pscale-guard.cases.tsv use placeholders (@P@ = the CLI name,
# @HOST@ = a PlanetScale MySQL host, @TOK@ = the inline-token flag, @CURL@ =
# a mutating curl) precisely so that authoring or editing the fixture file does
# not itself trip the live guard. They are expanded at run time.
#
# Expectations in the first column:
#
#   deny | ask   the guard returns that permissionDecision
#   pass          the guard returns NO permissionDecision (context is ignored)
#   ctx           no permissionDecision, and the session brief IS injected
#   noctx         no permissionDecision, and no brief is injected
#
# `pass` is deliberately indifferent to the brief so that the decision cases
# stay readable; `ctx`/`noctx` are the ones that pin the brief down.
#
# A command of the form `mcp:<tool_name>` is sent as an MCP tool call carrying
# no shell command, which is how the PlanetScale MCP read tools arrive.
set -uo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
H='psdb'; H="$H.cloud"; T='--service-'; T="${T}token"; C='curl -X '; C="${C}POST"; P='psc'; P="${P}ale"

# Each case gets its own session id and the whole run gets its own state
# directory, so "once per session" cannot make one case depend on another and a
# run never touches a real session's markers.
PSCALE_GUARD_STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pscale-guard-test.XXXXXX")
export PSCALE_GUARD_STATE_DIR
trap 'rm -rf "$PSCALE_GUARD_STATE_DIR"' EXIT

fail=0; total=0

# $1 = command (or mcp:<tool>), $2 = session id.  Echoes "<decision>|<hasctx>".
run_guard() {
  local cmd=$1 sid=$2 payload out d c
  case "$cmd" in
    mcp:*)
      payload=$(jq -cn --arg t "${cmd#mcp:}" --arg s "$sid" \
        '{tool_name:$t,session_id:$s,tool_input:{}}') ;;
    *)
      payload=$(jq -cn --arg c "$cmd" --arg s "$sid" \
        '{tool_name:"Bash",session_id:$s,tool_input:{command:$c}}') ;;
  esac
  out=$(printf '%s' "$payload" | bash "$here/pscale-guard.sh" 2>&1)
  d=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  c=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)
  if [ -n "$c" ]; then printf '%s|ctx' "$d"; else printf '%s|' "$d"; fi
}

check() { # $1 = expectation, $2 = got "<decision>|<hasctx>", $3 = label
  local exp=$1 d=${2%%|*} hasctx=${2##*|} got
  if [ -n "$d" ]; then got=$d
  elif [ "$hasctx" = ctx ]; then got=ctx
  else got=noctx; fi
  total=$((total+1))
  local ok=0
  case "$exp" in
    pass) [ "$got" = ctx ] || [ "$got" = noctx ] && ok=1 ;;
    *)    [ "$got" = "$exp" ] && ok=1 ;;
  esac
  if [ "$ok" -eq 1 ]; then
    printf 'ok   %-5s %s\n' "$got" "${3:0:72}"
  else
    printf 'FAIL got=%-5s want=%-5s %s\n' "$got" "$exp" "$3"; fail=$((fail+1))
  fi
}

i=0
while IFS=$'\t' read -r exp cmd; do
  [ -z "${cmd:-}" ] && continue
  case "$exp" in \#*) continue;; esac
  cmd=${cmd//@HOST@/$H}; cmd=${cmd//@TOK@/$T}; cmd=${cmd//@CURL@/$C}; cmd=${cmd//@P@/$P}
  i=$((i+1))
  check "$exp" "$(run_guard "$cmd" "case-$i")" "$cmd"
done < "$here/pscale-guard.cases.tsv"

# ------------------------------------------------ once per session, not per call
# The brief is worth injecting the first time a session reaches a PlanetScale
# tool and worth nothing every time after, so this pins both halves down.
READ="$P sql nucarpool main --role reader --query 'SELECT 1'"
check ctx   "$(run_guard "$READ" repeat-session)" "first pscale call in a session briefs"
check noctx "$(run_guard "$READ" repeat-session)" "second call in the same session stays quiet"
check noctx "$(run_guard "$P branch list nucarpool" repeat-session)" "a later, different pscale call stays quiet"
check ctx   "$(run_guard "$P branch list nucarpool" other-session)" "a different session briefs again"

# A denied command exits carrying its own reason and must not also brief, which
# is what keeps the existing decisions untouched.
check deny "$(run_guard "$P deploy-request create nucarpool" deny-session)" "denied command still denies"
check ctx  "$(run_guard "$READ" deny-session)" "...and did not consume the session's brief"

echo "----"; echo "$((total-fail))/$total passed"
[ "$fail" -eq 0 ]
