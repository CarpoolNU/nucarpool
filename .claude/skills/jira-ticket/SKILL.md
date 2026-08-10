---
name: jira-ticket
description: Execute a NUCarpool engineering ticket through the Jira-first workflow, from establishing the Jira issue to a review-ready pull request. Use when the user asks to work on, implement, pick up, continue, or finish a SCRUM ticket ("work on SCRUM-215", "implement SCRUM-217", "complete SCRUM-220 through PR readiness"), or asks for meaningful engineering or documentation work that should be tracked in Jira. Covers Jira status transitions, feature-branch and commit discipline, PR creation, and the post-PR CI fix loop. Claude owns delivery through PR readiness; the human owns the merge.
---

# Executing a NUCarpool engineering ticket

You own the work **through PR readiness**. The human owns the **merge**. Creating a PR is not
the finish line.

## Where truth lives — read, don't restate

| Source                                                                                                | Authority                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`CLAUDE.md`](../../../CLAUDE.md)                                                                     | Permanent project rules, safety boundaries, commands, architecture gotchas |
| [`.claude/settings.json`](../../settings.json)                                                        | Tool permissions (allow / ask / deny) — the only permission authority      |
| Jira issue                                                                                            | Live requirements and acceptance criteria                                  |
| Repository + READMEs                                                                                  | How the code actually works today                                          |
| Confluence (space `CNCS`)                                                                             | Deeper architecture, infra, deployment, process, product history           |
| [`docs/development/AI_DEVELOPMENT_WORKFLOW.md`](../../../docs/development/AI_DEVELOPMENT_WORKFLOW.md) | The human-facing explanation of this system                                |

Do not copy the tech stack, data model, environment variables, or permission lists into your
reasoning output — consult them where they live.

## 0. Read what the request authorizes

Filing a ticket and fixing a problem are different acts. Decide which the user asked for
**before** you touch anything, because it determines ticket status.

| Request               | Example                                                           | You do                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Find / audit only** | "find problems in the messaging system", "audit this for bugs"    | Investigate. File or reference issues. Leave new ones in `To Do`. **Do not start fixing.** Keep auditing, then report.                  |
| **Find and fix**      | "find problems and fix them", "audit X and resolve what you find" | Investigate. Establish the issue. Make it active, move it to `In Progress` when work actually starts, run the pipeline to PR readiness. |
| **Explicit ticket**   | "work on SCRUM-220"                                               | Retrieve it, `In Progress` when work starts, run the pipeline.                                                                          |

Absent explicit authorization to fix, assume **find only**. "Find" is not "fix" — an audit that
silently starts changing code has exceeded its mandate.

## 1. Establish the Jira issue — always first

No implementation begins as an anonymous, untracked change.

- **Given a key** (`SCRUM-###`): retrieve it before acting. Read the description and
  acceptance criteria. If it is thin, reconstruct scope from the repo — never invent it. Ask
  when a genuine ambiguity would change the work.
- **No key given**, and the request is meaningful project work: **search Jira first** with a
  couple of phrasings. Use an existing issue if one matches; otherwise create one describing
  the goal, then proceed.
- **Trivial actions** — answering a question, reading code, a one-line typo, exploratory
  investigation — do not need a ticket. Use judgment; do not manufacture bureaucracy.

## 2. Transition to In Progress

Once you begin real investigation, implementation, or documentation work, transition the issue
to `In Progress`. Creating or merely reading a ticket does not move it.

**Resolve every transition by workflow status name, never a hard-coded transition ID.** Fetch
the issue's available transitions and match on the name — IDs are project configuration and
can change.

## 3. Investigate before editing

Ticket → repository → _then_ decide whether outside knowledge is needed.

Read the code and the relevant READMEs first. Reach for Confluence **only** when the task needs
knowledge the repo does not contain — architecture, infrastructure, deployment, operational
procedure, team process, or product history. Fetch the specific pages, not whole spaces.

Confluence can be stale. Verify any technical claim against the current code; where they
disagree, the code wins.

## 4. Feature branch

Before switching branches, inspect the working tree. Identify pre-existing changes that are
not yours. **Never discard them, and never silently include them in your commit.** Name them
in your report.

Branch off a freshly fetched `origin/main`. Reuse the existing branch if the ticket is already
underway on one.

## 5. Implement

Stay inside the ticket. Match the conventions of the file you are editing.

## 6. Validate

Run what the change warrants — normally `yarn lint` and `yarn tsc`, plus `yarn test` where
relevant, and any task-specific checks (for docs: formatting, link and anchor resolution, a
secrets scan).

**Report test results honestly.** There is currently no test suite, so `yarn test` passes
because nothing runs. That is a vacuous pass, not coverage — never present it as coverage.

Failure caused by your change → fix it and revalidate. Failure that is unrelated → the
discovered-issue workflow below; do not expand scope.

## 7. Self-review before staging

Read the complete diff and check:

- every change belongs to this ticket
- no unrelated file crept in
- no secrets, credentials, tokens, `.env` values, personal paths, or machine-specific data
- nothing dangerous or unintended was introduced
- the work actually satisfies the acceptance criteria

If criteria remain unmet, say so plainly. Do not claim completion you have not reached.

## 8. Stage and commit

**Run `git rev-parse --abbrev-ref HEAD` immediately before committing.** If it returns `main`
or `staging`, stop and say so.

Stage explicit paths only. Never `git add .`, `git add -A`, `git add --all`, `git commit -a`,
or `git commit -am` — the working tree may hold changes that must stay out.

Inspect `git diff --cached` before committing. Write a concise message that references the
Jira key and explains _why_, not just _what_.

## 9. Push

**Verify the branch again immediately before pushing.** Push only the feature branch. Never
push `main` or `staging`. Never force-push.

## 10. Create or update the PR

Target `main`. If a PR already exists for the branch, **update it rather than opening a
duplicate**.

Include: the Jira link, purpose, relevant acceptance criteria, major changes, validation
performed, known limitations and risks, related issues discovered during the work, and an
explicit note about any pre-existing changes deliberately excluded.

## 11. Transition to Code Review

**Only after confirming the branch is pushed and the PR actually exists.** Verify, then
transition to `Code Review` and comment on the issue with:

- the PR link
- a concise summary of what changed
- validation performed
- any Jira issues discovered during the work

No PR means no `Code Review`.

## 12. Own the PR until it is ready

PR creation is not the endpoint. Inspect the PR's files, final diff, base and head branches,
and checks. Confirm it contains only intended changes, and verify acceptance criteria against
what actually shipped.

When a check fails **because of this ticket**:

```
diagnose → fix → validate → review diff → stage targeted → commit → push SAME branch → re-check
```

Never open a second PR to fix the first. Repeat while it is reasonably productive. If checks
are still running, wait for them rather than declaring readiness early.

Unrelated failure → discovered-issue workflow, and do not pull the fix into this PR. If an
unrelated failure genuinely blocks review-readiness, use `Blocked`.

## Stop conditions

Stop in exactly one of two states, and report which:

**A. Review-ready PR** — intended work present, unrelated changes absent, validation passing,
checks understood, acceptance criteria satisfied or gaps explicitly reported, Jira in
`Code Review` with the PR link attached.

**B. Genuinely blocked** — Jira in `Blocked` and accurately explaining the situation.

Then stop. The human reviews and merges.

## Discovered-issue workflow

When you find a new actionable problem:

1. Is it part of the active ticket? If yes, handle it in scope.
2. If not — **do not scope-creep the current PR.** Search Jira first, with more than one
   phrasing if the wording is uncertain.
3. Match found → reference it.
4. No match → create an issue carrying the evidence you have: affected area, observed vs.
   expected behavior, impact, relevant paths, and the ticket you were on when you found it.
5. **Leave the new issue in `To Do`** (see the status rule below).
6. Return to the original task.

Do not file trivial observations, speculation, duplicates, or anything the active ticket
already covers.

### Status of a discovered ticket

**A newly discovered ticket defaults to `To Do`.** It moves to `In Progress` only when **both**
hold:

1. the request authorizes working on the discovered problem ("find and fix", "resolve",
   "implement", "work on"), **and**
2. you actually begin work on that ticket.

Never move it merely because it was discovered, was created, looks important, or is worth
fixing later. **Creating a ticket is not starting work.** Status must describe reality, and a
board full of `In Progress` tickets nobody is touching tells the team nothing.

### Switching the active ticket

Default: file it, leave it `To Do`, finish the ticket you are on.

Only when the request explicitly authorized find-and-fix may a discovered ticket become the
active work item — and then:

- establish the Jira issue first
- **state the scope change out loud**; never switch silently
- keep it a separate PR unless the two problems are genuinely inseparable

Prefer one issue to one coherent PR. Never quietly bundle unrelated fixes into one PR — a
reviewer cannot approve half a diff.

## Blocked

`Blocked` is an exception state, not a slower `In Progress`. Use it only when useful progress
genuinely cannot continue: missing access, an external dependency, a required human or team
decision, unavailable required information, or a comparable blocker.

Investigate first. If the answer is discoverable in the repo, Jira, Confluence, or git
history, that is research — do the research. Do not use `Blocked` for ordinary uncertainty.

When blocking: transition to `Blocked` and comment with **what is blocking the work** and
**what is needed to resume**. When it clears, transition back to `In Progress` and continue.

## Never

- merge a PR — not `gh pr merge`, not a GitHub API mutation, not the web UI
- push or commit to `main` or `staging`
- force-push, or bypass branch protection
- transition an issue to `Done` — that follows the human merge
- work around the permission system

## Permissions

[`.claude/settings.json`](../../settings.json) is the source of truth and is deliberately
restrictive. Read-only inspection generally runs freely; pushes, PR writes, and Jira and
Confluence writes prompt; merges and destructive database commands are denied.

When an action needs approval, request it normally and wait. A declined prompt means _don't_ —
adjust the approach; never reach for another route to the same effect. Never weaken, bypass,
or edit permissions to make a task easier.
