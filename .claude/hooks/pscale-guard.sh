#!/bin/bash
# PlanetScale production-write guard (SCRUM: PlanetScale agent hardening).
#
# PreToolUse/Bash hook. Reads the tool-call JSON on stdin and blocks command
# shapes that could mutate the PlanetScale production branch (`main`) or
# escalate the agent's PlanetScale identity.
#
# Why a hook and not only permissions.deny: deny rules match a command PREFIX,
# so `pscale sql nucarpool main --role admin ...` and
# `pscale sql nucarpool main --format json --role=admin ...` need different
# rules, and any new flag order defeats them. This hook matches the whole
# normalized command string, so flag order does not matter.
#
# Exit 0 with no output = fall through to the normal permission flow.

set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Normalize: single line, quotes dropped, collapsed whitespace, lowercased, and
# space-padded so that [ =]token[ ] matches at either end. Quotes are stripped
# so that `pscale sql "nucarpool" "main"` is recognized as targeting production
# exactly like the unquoted form.
n=" $(printf '%s' "$cmd" | tr '\n\t' '  ' | tr -d '"'"'"'' | tr -s ' ' | tr '[:upper:]' '[:lower:]') "

emit() { # $1 = decision, $2 = reason
  jq -cn --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}
deny() { emit deny "BLOCKED by .claude/hooks/pscale-guard.sh — $1"; }
ask()  { emit ask  "PlanetScale guard — $1"; }

# `--` is required: several patterns begin with "--" and grep would otherwise
# parse them as its own options and silently never match.
has() { printf '%s' "$n" | grep -Eq -- "$1"; }

PSCALE='(^| |/|;|&|\|)pscale '
if has "$PSCALE"; then IS_PSCALE=1; else IS_PSCALE=0; fi

# ---------------------------------------------------------------- bypass paths
# A direct MySQL client to a PlanetScale host sidesteps pscale entirely.
# Require an actual host flag pointing at psdb.cloud, so that merely writing
# documentation that mentions mysql and psdb.cloud does not trip the guard.
if has '(^| |/)mysql(sh)? ' && has '(-h|--host)[ =]+[^ ]*psdb\.cloud'; then
  deny "direct MySQL client connection to a PlanetScale host. Use 'pscale sql <db> <branch> --role reader'."
fi
# Raw API writes sidestep every pscale-level rule.
if has '(^| |/)curl ' && has 'api\.planetscale\.com' && has '(-x|--request|--method) +(post|put|patch|delete)'; then
  deny "write call to the PlanetScale REST API. Production mutation must go through a human."
fi

[ "$IS_PSCALE" -eq 1 ] || exit 0

# ------------------------------------------------------------- identity swap
if has '--(service-token|service-token-id|api-token)[ =]'; then
  deny "passing a PlanetScale token inline swaps the agent's identity and leaks the secret into the transcript. Use the PLANETSCALE_API_TOKEN environment variable."
fi

# ------------------------------------------------------------------- targets
MAIN='[ =]main([ /@]|$)'
STAGING='[ =]staging([ /@]|$)'
targets_main()    { has "$MAIN"; }
targets_staging() { has "$STAGING" && ! has "$MAIN"; }

WRITE_ROLE='--role[ =](admin|writer|readwriter)'

# ------------------------------------------------- always-forbidden operations
if has 'deploy-request +(deploy|review|apply|revert|force-cutover|unblock|skip-revert|throttler)'; then
  deny "approving, deploying, reverting or unblocking a deploy request is human-only. Open the deploy request and hand it to a human."
fi
if has 'branch +safe-migrations'; then
  deny "changing Safe Migrations is a production safety setting. Human-only."
fi
if has '(branch +(delete|promote)|database +(delete|update)|keyspace +(delete|update|resize)|backup +(delete|restore)|webhook +(create|update|delete|test)|service-token +(create|delete|add-access|delete-access))'; then
  deny "destructive or configuration-changing PlanetScale operation. Human-only."
fi
if has ' shell( |$)'; then
  deny "'pscale shell' is interactive and does not default to the reader role. Use 'pscale sql ... --role reader'."
fi
# `pscale api` reaches the REST API directly, so the subcommand rules above do
# not see it. Block the mutating shapes; plain reads still fall through.
if has ' api '; then
  if has '(-x|--method|--request) +(post|put|patch|delete)'; then
    deny "mutating call through 'pscale api'. Production mutation must go through a human."
  fi
  if has 'deploy-requests?/[0-9]+/(deploy|approve|apply|revert|cancel|unblock)'; then
    deny "deploy-request mutation through 'pscale api'. Human-only."
  fi
  if has '/(passwords|safe-migrations|promote)'; then
    deny "credential or safety-setting change through 'pscale api'. Human-only."
  fi
fi

# ------------------------------------------------------- production (main)
if targets_main; then
  if has "$WRITE_ROLE"; then
    deny "write role (admin/writer/readwriter) against production branch 'main'. Production is read-only for the agent."
  fi
  if has ' connect( |$)'; then
    deny "'pscale connect' opens a local proxy to production. Read production with 'pscale sql nucarpool main --role reader'."
  fi
  if has 'password +(create|delete|update|renew)'; then
    deny "creating or altering a production branch credential. Human-only."
  fi
  if has ' sql ' && has '--force'; then
    deny "--force against production allows DELETE/DROP/TRUNCATE. Human-only."
  fi
  # Write SQL against main even at reader role — belt and braces.
  if has ' sql ' && has "(--query|-q)[ =]+['\"]? *(insert|update|delete|replace|alter|create|drop|truncate|grant|revoke|rename|call|load +data)"; then
    deny "write/DDL statement targeted at production branch 'main'."
  fi
  if has ' sql ' && has '; *(insert|update|delete|replace|alter|create|drop|truncate|grant|revoke|rename)'; then
    deny "stacked write statement targeted at production branch 'main'."
  fi
fi

# -------------------------------------------- write role with unknown target
if has "$WRITE_ROLE" && ! targets_staging; then
  deny "write role requested without an unambiguous 'staging' target. Name the branch explicitly; production writes are forbidden."
fi

# ------------------------------------------------------- staging: ask, allow
if targets_staging && has "$WRITE_ROLE"; then
  ask "write-role SQL against staging. Confirm this is part of the approved ticket."
fi
if targets_staging && has ' sql ' && has '--force'; then
  ask "destructive SQL (DELETE/DROP/TRUNCATE) against staging."
fi
if targets_staging && has 'password +(create|delete)'; then
  ask "creating or deleting a staging branch credential."
fi
if has 'deploy-request +create'; then
  deny "opening a deploy request is human-only here. PlanetScale gates queueing a deploy behind the same 'create_deploy_request' access as opening one, so an identity able to open a deploy request can also ship it to production. Hand the schema change to a human."
fi
if has 'branch +create'; then
  ask "creating a PlanetScale branch (data branching from production is enabled on this database)."
fi

exit 0
