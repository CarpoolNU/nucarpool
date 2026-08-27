#!/bin/bash
# Regression suite for pscale-guard.sh.  Run: .claude/hooks/pscale-guard.test.sh
#
# Fixtures in pscale-guard.cases.tsv use placeholders (@P@ = the CLI name,
# @HOST@ = a PlanetScale MySQL host, @TOK@ = the inline-token flag, @CURL@ =
# a mutating curl) precisely so that authoring or editing the fixture file does
# not itself trip the live guard. They are expanded at run time.
set -uo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
H='psdb'; H="$H.cloud"; T='--service-'; T="${T}token"; C='curl -X '; C="${C}POST"; P='psc'; P="${P}ale"
fail=0; total=0
while IFS=$'\t' read -r exp cmd; do
  [ -z "${cmd:-}" ] && continue
  case "$exp" in \#*) continue;; esac
  cmd=${cmd//@HOST@/$H}; cmd=${cmd//@TOK@/$T}; cmd=${cmd//@CURL@/$C}; cmd=${cmd//@P@/$P}
  total=$((total+1))
  d=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')" \
      | bash "$here/pscale-guard.sh" 2>&1 | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null)
  [ -z "$d" ] && d=pass
  if [ "$d" = "$exp" ]; then
    printf 'ok   %-4s %s\n' "$d" "${cmd:0:74}"
  else
    printf 'FAIL got=%-4s want=%-4s %s\n' "$d" "$exp" "$cmd"; fail=$((fail+1))
  fi
done < "$here/pscale-guard.cases.tsv"
echo "----"; echo "$((total-fail))/$total passed"
[ "$fail" -eq 0 ]
