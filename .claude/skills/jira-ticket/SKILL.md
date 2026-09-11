---
name: jira-ticket
description: Execute a NUCarpool engineering ticket through the Jira-first workflow, from establishing the Jira issue to a review-ready pull request. Use when the user asks to work on, implement, pick up, continue, or finish a SCRUM ticket ("work on SCRUM-215", "implement SCRUM-217", "complete SCRUM-220 through PR readiness"), or asks for meaningful engineering or documentation work that should be tracked in Jira. Covers Jira status transitions, feature-branch and commit discipline, PR creation, and the post-PR CI fix loop. Claude owns delivery through PR readiness; the human owns the merge.
---

# Executing a NUCarpool engineering ticket

You own the work **through PR readiness**. The human owns the **merge**.

## Where truth lives — read, don't restate

| Source                                                                        | Authority                                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`CLAUDE.md`](../../../CLAUDE.md)                                             | Project rules, safety boundaries, commands, architecture gotchas        |
| [`.claude/settings.json`](../../settings.json)                                | Tool permissions — the only permission authority                        |
| Jira issue                                                                    | Live requirements and acceptance criteria                               |
| Repository + READMEs                                                          | How the code actually works today                                       |
| [`docs/AI_DEVELOPMENT_WORKFLOW.md`](../../../docs/AI_DEVELOPMENT_WORKFLOW.md) | The workflow in full, and the **authoritative issue format** and labels |
| Confluence (space `CNCS`)                                                     | Architecture, infra, deployment, process, product history               |

Do not copy the tech stack, data model, or permission lists into your reasoning — consult them where they live.

## 0. Read what the request authorizes

Decide this **before** touching anything, because it determines ticket status.

| Request               | Example                                 | You do                                                                           |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| **Find / audit only** | "find problems in the messaging system" | Investigate, file or reference issues, leave new ones in `To Do`. **No fixing.** |
| **Find and fix**      | "audit X and resolve what you find"     | Investigate, establish the issue, run the pipeline.                              |
| **Explicit ticket**   | "work on SCRUM-220"                     | Retrieve it and run the pipeline.                                                |

Absent explicit authorization to fix, assume **find only**. An audit that silently starts changing code has exceeded its mandate.

## 1. Establish the Jira issue

No implementation begins as an untracked change.

- **Given a key**: retrieve it and read the acceptance criteria before acting. If it is thin, reconstruct scope from the repo — never invent it. Ask when a genuine ambiguity would change the work.
- **No key**, and the work is meaningful: search Jira with a couple of phrasings first. Use an existing issue if one matches; otherwise create one in the documented format.
- **Trivial actions** — a question, reading code, a one-line typo — need no ticket.

## 2. Transition to In Progress

Once real investigation or implementation starts. Creating or reading a ticket does not move it. **Resolve transitions by status name, never a hard-coded ID.**

## 3. Investigate before editing

Ticket → repository → _then_ decide whether outside knowledge is needed. Reach for Confluence only when the task needs something the repo does not contain, and fetch specific pages. Confluence can be stale; where it disagrees with the code, the code wins.

## 4. Feature branch

Inspect the working tree first. Identify pre-existing changes that are not yours: **never discard them, and never silently include them in your commit.** Name them in your report.

Branch off a freshly fetched `origin/main`, or reuse the ticket's existing branch.

## 5. Implement

Stay inside the ticket. Match the conventions of the file you are editing.

## 6. Validate

Normally `yarn lint` and `yarn tsc`, plus `yarn test` where relevant, and any task-specific checks.

**Report test results honestly.** The suite runs entirely on mocks — no browser, no real database — and React-layer coverage is thin. A passing `yarn test` is not coverage of anything you did not actually test. See [docs/testing.md](../../../docs/testing.md).

A failure caused by your change → fix and revalidate. An unrelated failure → the discovered-issue workflow; do not expand scope.

## 7. Self-review before staging

Read the complete diff and confirm: every change belongs to this ticket; no unrelated file crept in; no secrets, credentials, `.env` values or personal paths; nothing dangerous introduced; the work actually satisfies the acceptance criteria.

If criteria remain unmet, say so plainly.

## 8. Stage and commit

**Run `git rev-parse --abbrev-ref HEAD` immediately before committing.** If it returns `main` or `staging`, stop and say so.

Stage explicit paths only — never `git add .`, `-A`, `--all`, `commit -a` or `-am`. Inspect `git diff --cached`, then write a message referencing the Jira key that explains _why_.

## 9. Push

**Verify the branch again immediately before pushing.** Feature branch only. Never force-push.

## 10. Create or update the PR

Target `main`. If a PR already exists for the branch, **update it rather than opening a duplicate**.

Include the Jira link, purpose, relevant acceptance criteria, major changes, validation performed, known limitations and risks, issues discovered during the work, and an explicit note about any pre-existing changes deliberately excluded.

## 11. Transition to Code Review

**Only after confirming the branch is pushed and the PR exists.** Then comment on the issue with the PR link, a concise summary, the validation performed, and anything discovered.

No PR means no `Code Review`.

## 12. Own the PR until it is ready

Inspect the PR's files, final diff, base and head branches, and checks. Confirm it contains only intended changes and verify acceptance criteria against what shipped.

When a check fails **because of this ticket**:

```
diagnose → fix → validate → review diff → stage targeted → commit → push SAME branch → re-check
```

Never open a second PR to fix the first. If checks are still running, wait rather than declaring readiness early. An unrelated failure goes to the discovered-issue workflow and does not join this PR.

## Stop conditions

Stop in exactly one of two states, and report which:

**A. Review-ready PR** — intended work present, unrelated changes absent, validation passing, checks understood, acceptance criteria satisfied or gaps explicitly reported, Jira in `Code Review` with the PR link attached.

**B. Genuinely blocked** — Jira in `Blocked`, accurately explaining what is blocking and what is needed.

Then stop. The human reviews and merges.

## Discovered issues

1. Part of the active ticket? Handle it in scope.
2. If not, **do not scope-creep the PR.** Search Jira first, with more than one phrasing.
3. Match → reference it. No match → create it in the documented format, with `path:line` evidence and the ticket you were on.
4. **Leave it in `To Do`.** Filing is not starting.
5. Return to the original task.

**File before the session ends.** Chat, a report and a PR description are not the board; once the session ends the transcript is the only record. If told not to write to Jira, say so, name the finding, and file it when the restriction lifts.

Only when the request explicitly authorized find-and-fix may a discovered ticket become the active work item — and then state the scope change out loud and keep it a separate PR unless the problems are genuinely inseparable.

Do not file trivial observations, speculation, or duplicates.

## Never

- merge a PR — not `gh pr merge`, not the API, not the web UI
- push or commit to `main` or `staging`
- force-push, or bypass branch protection
- transition an issue to `Done` — that follows the human merge
- work around the permission system

When an action needs approval, request it and wait. A declined prompt means _don't_ — adjust the approach rather than reaching for another route to the same effect.
