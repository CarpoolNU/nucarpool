# AI Development Workflow

How NUCarpool's Claude Code development system works, and how to set it up.

Audience: a developer joining NUCarpool who may never have used Claude Code, MCP, Jira,
Confluence, or the GitHub CLI. This explains the **system** — what each piece is for and why
the guardrails exist. Per-file details stay in the files this links to.

## 1. Purpose

NUCarpool is maintained by a small, rotating team of co-op students, so context is lost every
time someone leaves. This system keeps it in the repository instead of in one person's head:

- **Project knowledge is written down** where an AI assistant and a human both read it.
- **Every change is traceable** to a Jira issue, so no work is anonymous.
- **Dangerous operations are blocked mechanically**, not by remembering to be careful — this
  repo can wipe its own database and send real email (see [§15](#15-security-considerations)).
- **A human makes the final call.** Claude delivers work through a review-ready PR; the
  human owns the merge.

## 2. System architecture

```
                        Developer
                            │
                  ┌─────────┴─────────┐
                  │   1. Jira issue   │  ← work always starts here
                  └─────────┬─────────┘
                            │
                    ┌───────▼────────┐
                    │  Claude Code   │  runs locally in your terminal
                    └───────┬────────┘
       ┌────────────────────┼────────────────────┐
┌──────▼───────┐  ┌─────────▼────────┐  ┌────────▼───────┐
│  CLAUDE.md   │  │ .claude/         │  │ Atlassian MCP  │
│ project rules│  │ settings.json    │  │ (remote server)│
│ (always read)│  │ allow/ask/deny   │  │  ├── Jira      │
└──────────────┘  └──────────────────┘  │  └── Confluence│
                            │           └────────────────┘
                    ┌───────▼────────┐
                    │  GitHub CLI    │
                    └───────┬────────┘
                            │
      feature branch ─► commit ─► push ─► PR ─► checks ─► fix ─┐
                            │         ▲                        │
                            │         └────────────────────────┘
                            │            (same branch, until review-ready)
                            ▼
                   ══════ STOP ══════   ← the boundary is the MERGE, not the PR
                            │
                human review ─► merge ─► deploy ─► Done
```

Three ideas carry the design:

1. **CLAUDE.md is instructions; MCP is data.** The repo says _how to behave_; the Atlassian
   MCP server _retrieves_ Jira and Confluence content on demand.
2. **Permissions are enforced by the harness, not by Claude's goodwill.**
   [`.claude/settings.json`](../../.claude/settings.json) is checked in, so guardrails are
   identical for everyone.
3. **The boundary is the merge, not the PR.** Claude owns delivery through a review-ready
   PR — including fixing its own CI failures. Review and merge are human acts.

## 3. Repository configuration files

| File                                                                               | Role                                                                                                    | In git |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| [`CLAUDE.md`](../../CLAUDE.md)                                                     | Durable project instructions: commands, architecture gotchas, safety, git policy. Loaded every session. | yes    |
| [`.claude/settings.json`](../../.claude/settings.json)                             | Permission model: allowed / prompted / forbidden tools. **Source of truth.**                            | yes    |
| `.claude/settings.local.json`                                                      | Your machine-local overrides. Personal, gitignored — never commit it.                                   | no     |
| [`.claude/skills/jira-ticket/SKILL.md`](../../.claude/skills/jira-ticket/SKILL.md) | The repeatable procedure for executing a ticket — see [§10](#10-standard-engineering-lifecycle).        | yes    |
| [`.mcp.json`](../../.mcp.json)                                                     | Declares the Atlassian MCP server. URL only — no credentials.                                           | yes    |
| [`README.md`](../../README.md)                                                     | Human setup: stack, environment variables, commands.                                                    | yes    |
| [`.github/workflows/`](../../.github/workflows/)                                   | CI — see [§14](#14-ci-behavior).                                                                        | yes    |

Layer-specific docs: [`src/server/router/README.md`](../../src/server/router/README.md)
(tRPC routers, context, auth) and [`src/server/db/README.md`](../../src/server/db/README.md)
(Prisma, schema, migrations). Read the relevant one before editing that layer.

## 4. First-time setup

Prerequisites: Node 20 (CI uses 20), Docker, Yarn Classic 1.x, git.

```bash
git clone <repo-url> && cd nucarpool
yarn                  # Yarn Classic — not npm, not pnpm
yarn db:start         # local MySQL 5.7 in Docker
yarn dev              # http://localhost:3000
```

You also need a `.env`. [`README.md`](../../README.md) lists every required variable and its
shape. Get real values from a teammate or the team's Confluence space — never from a commit,
and never paste them into a Claude session. AWS keys use **suffixed** names
(`ACCESS_KEY_ID_AWS`, not `AWS_ACCESS_KEY_ID`); standard names fail validation at import time.

`.env` is gitignored, and Claude Code is configured to refuse to read it at all.

## 5. Claude Code setup

```bash
npm install -g @anthropic-ai/claude-code   # one time
cd /path/to/nucarpool && claude            # start from the repo root
```

Starting from the repo root is what lets Claude Code find `CLAUDE.md`,
`.claude/settings.json`, and `.mcp.json`. Launch it elsewhere and you get a session with none
of this project's rules or guardrails.

In-session: `/mcp` (MCP status and login), `/permissions` (active rules), `/help`.

## 6. Atlassian MCP setup and OAuth

**What MCP is:** the Model Context Protocol gives an AI assistant typed tools for an external
system. Instead of guessing about a ticket, Claude calls a tool that returns the real one.

**How it's configured:** [`.mcp.json`](../../.mcp.json) declares one server, `atlassian`,
pointed at Atlassian's hosted remote MCP endpoint over HTTP.

**No credentials live in the repo.** Auth is per-developer OAuth:

1. Run `/mcp` in a session, pick `atlassian`, choose to authenticate.
2. A browser opens — sign in with your Northeastern Atlassian account and approve.
3. Claude Code stores the token on your machine, outside the repository.

You see only what your Atlassian account already can. Verify with `/mcp` (server should read
as connected); a good functional check is asking Claude to fetch a known issue by key.

## 7. Jira workflow — the first step

**Jira project `SCRUM` ("Carpool Main") is the source of truth for engineering work.**

> **Work starts from an established Jira issue.** No implementation or documentation change
> begins as an anonymous, untracked change. Before code is written, there is a ticket.

Why: a branch and a diff show _what_ changed; the ticket explains _why_ it was worth
changing. Without it, the next co-op inherits a change with no rationale.

- Given a key like `SCRUM-215`, Claude retrieves that issue and works from it.
- No ticket yet? **Search Jira first** — it may already be filed. If not, create one
  describing the goal.

Tickets define **what** should change; the repo and its READMEs define **how** the code works
today. Tickets here are often thin — when scope is missing, ask rather than invent.

### Status lifecycle

```
To Do  →  In Progress  ⇄  Blocked  →  Code Review  →  Done
                                                       ↑
                                              human only, after merge
```

Who moves the ticket, and when, is fixed:

| Status          | Means                                             | Moved by                            |
| --------------- | ------------------------------------------------- | ----------------------------------- |
| **To Do**       | Issue exists and is selected; work has not begun  | whoever files or picks it up        |
| **In Progress** | Implementation, investigation, or doc work active | Claude, when it starts working      |
| **Blocked**     | Work genuinely cannot continue (exception state)  | Claude, with an explanatory comment |
| **Code Review** | Work complete, branch pushed, PR open             | Claude, right after opening the PR  |
| **Done**        | PR merged                                         | **a human, after merging**          |

The point is that status always reflects reality:

- A ticket sitting in **To Do** means nothing has started yet. Creating or selecting an issue
  does not move it.
- Claude transitions to **In Progress** when it actually begins the work — not when the ticket
  is created, and not when it is merely reading the ticket.
- Claude transitions to **Code Review** only once the branch is pushed and the PR exists, and
  pairs that transition with a comment carrying the PR link and a concise summary. No PR means
  no Code Review.
- **Claude never transitions an issue to `Done`.** `Done` follows the human merge, set manually
  in Jira or by future deterministic automation. A green PR is not `Done`; a merged PR is.

A ticket in `Code Review` with no linked PR, or in `Done` with nothing merged, indicates the
Jira status is inconsistent with the actual state of the work — which is exactly what this
split prevents.

### Blocked — the exception state

`Blocked` is not a slower `In Progress`. It means work cannot usefully continue until
something outside the work itself changes:

- missing access or permissions
- an external dependency
- a required human or team decision
- required information that is unavailable
- another genuine blocker preventing useful progress

**It is not for ordinary uncertainty.** If the answer is discoverable by reading the
repository, Jira, Confluence, or git history, that is research — do the research. Marking
that `Blocked` would be false, and a board that cries blocker stops being believed.

When transitioning to `Blocked`, comment with two things: **what is blocking the work** and
**what is needed to resume.** A blocker nobody can act on is just a stalled ticket. When it
clears, transition back to `In Progress` and continue.

Statuses are resolved by **name** through the available Jira workflow, never by a hard-coded
transition ID — IDs are project configuration and can change without notice.

Jira writes are deliberate: creating an issue, commenting, and transitioning all prompt for
approval. Claude does not silently edit tickets.

## 8. Confluence and progressive disclosure

Confluence (space **CNCS**, "Carpool NU Confluence Space") holds what the repo cannot:
deployment and AWS/PlanetScale operations, environment history, product research, PRDs,
process notes.

The rule is **progressive disclosure** — each layer holds what it is best at, and nothing is
copied wholesale:

| Layer           | Holds                                               | Retrieved               |
| --------------- | --------------------------------------------------- | ----------------------- |
| Repository docs | What you need to set up and work in this repo       | always present          |
| `CLAUDE.md`     | Durable instructions Claude needs frequently        | every session           |
| Confluence      | Deeper organizational, product, and infra knowledge | on demand, page by page |

So Claude searches Confluence only when a task needs knowledge this repo lacks, and fetches
the specific pages needed — not whole spaces, and not into this document. Two consequences:

- **Pages can be stale.** Verify technical claims against the code; where they disagree, the
  code wins.
- **Confluence is read-first.** Writes are possible, reserved for tasks explicitly about
  documentation, and always announced.

## 9. GitHub CLI setup

```bash
brew install gh      # macOS; see cli.github.com for other platforms
gh auth login        # interactive — run this yourself
gh auth status
```

Claude reads PR and CI state freely (`gh pr view`, `gh pr checks`, `gh run list`). Creating or
editing a PR prompts you. Merging is blocked outright.

> Tip: prefix an interactive command with `!` inside a session (e.g. `! gh auth login`) so its
> output lands in the conversation.

## 10. Standard engineering lifecycle

> **This lifecycle is executable.** The step-by-step procedure lives in the
> [`jira-ticket` Skill](../../.claude/skills/jira-ticket/SKILL.md), which Claude Code invokes
> when you ask it to work on a ticket ("work on SCRUM-215"). This section explains the shape
> and the reasoning; the Skill is what actually runs. Keeping them separate is deliberate —
> three layers, three jobs: **CLAUDE.md** holds permanent rules, **`.claude/settings.json`**
> holds permissions, and the **Skill** holds the repeatable procedure.

```
establish Jira issue    ← FIRST. work is never anonymous          [To Do]
   ↓
→ In Progress           ← transition when work actually starts  [In Progress]
   ↓
investigate / plan      ← code + relevant READMEs; Confluence only if needed
   ↓
feature branch          ← off a freshly fetched origin/main
   ↓
implement / document
   ↓
validate                ← yarn lint && yarn tsc  (yarn test where tests exist)
   ↓
self-review             ← read your own diff first
   ↓
commit                  ← stage specific paths only
   ↓
push feature branch
   ↓
create / update PR      ← targets main
   ↓
→ Code Review           ← transition only once the PR exists   [Code Review]
   ↓
Jira comment            ← PR link + concise summary
   ↓
┌──────────────── the PR is not the finish line ────────────────┐
│  inspect PR checks                                            │
│  inspect final PR diff    ← only intended changes?            │
│  fix current-task failures if necessary                       │
│  revalidate                                                   │
│  commit / push fixes to the SAME branch                       │
│  re-check PR             ─── repeat while reasonable ──┐      │
│         ▲                                             │      │
│         └─────────────────────────────────────────────┘      │
│  verify Jira acceptance criteria against what shipped         │
└───────────────────────────────────────────────────────────────┘
   ↓
report PR readiness     ← including remaining risks / unmet criteria
   ↓
══ STOP ══              ← or STOP at [Blocked], accurately reflected in Jira
   ↓
human reviews and merges
   ↓
→ Done                  ← set by a human, after the merge            [Done]
```

- Branch from a freshly fetched `origin/main`; PRs target `main`.
- `staging` is a real, deployed environment (the team hosts both `staging` and `main`
  branches) — never scratch space. Use it only when the current team workflow calls for it.
- Before **every** commit and push: `git rev-parse --abbrev-ref HEAD`. If it returns `main` or
  `staging`, stop.
- Stage specific paths. Never `git add -A` or `git commit -a` — the working tree may hold
  unrelated changes that must stay out of your PR.

### After the PR exists, the work continues

The old rule — "create the PR, then stop" — was wrong, and worth being explicit about because
it is the easiest thing to get wrong. **Creating a PR is not delivering it.** A PR whose checks
were never looked at, whose diff was never re-read, and whose acceptance criteria were never
verified is not ready for anyone's review; handing it over is handing over unfinished work.

So once the PR exists, Claude still owns:

- transitioning the issue to `Code Review` and commenting the PR link plus a concise summary
- inspecting PR status and checks
- inspecting the final PR diff, confirming it contains **only** the intended changes
- verifying the ticket's acceptance criteria against what was actually implemented
- reporting remaining risks or unmet criteria honestly
- diagnosing and fixing CI failures caused by the current work, validating locally, and
  committing and pushing those fixes to the **same** feature branch, then re-checking
- repeating that loop while it is reasonably productive

Never open a new branch or PR to fix the current PR's own failures — that fragments one piece
of work across two reviews.

### CI failure scope

Not every red check is yours. The distinction drives what happens next:

| Failure                                   | Response                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Caused by the current change              | diagnose → fix → validate → commit → push same branch → re-check                          |
| Unrelated / pre-existing                  | search Jira for a duplicate → reference or file an issue → **do not** scope-creep this PR |
| Unrelated, and it blocks review-readiness | file or reference the issue, then use `Blocked` and say what is needed                    |

**Claude may create and update PRs. Claude never merges a PR — by any route.** The workflow
stops in exactly two places: the PR is ready for human review, or the work is genuinely
blocked and Jira says so. A human reviews and merges — and since merging is the human's act,
so is moving the ticket to `Done`.

## 11. Discovered-issue workflow

### How you ask determines what happens

Three usage modes. The difference matters, because it decides whether a discovered problem gets
_filed_ or gets _fixed_:

| You say                                                         | Claude does                                                                                                                                   | New tickets land in            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **"Find problems in X"** / "audit X for bugs"                   | Investigates, files or references issues, keeps auditing, reports findings. **Does not start fixing.**                                        | `To Do`                        |
| **"Find problems in X and fix them"** / "resolve what you find" | Same discovery, then makes the issue active, moves it to `In Progress` when work actually starts, and runs the pipeline to a review-ready PR. | `In Progress` once work begins |
| **"Work on SCRUM-220"**                                         | Retrieves that ticket and runs the normal pipeline.                                                                                           | n/a — existing ticket          |

Absent explicit authorization to fix, Claude assumes **find only**. An audit that quietly starts
rewriting code has exceeded its mandate, and you would be reviewing changes you never asked for.

**A newly discovered ticket stays in `To Do`.** Filing is not starting. It moves to
`In Progress` only when the request authorized fixing _and_ work actually begins — never merely
because the problem was found, filed, or looks important. That way the board tells you what is
genuinely underway rather than what was noticed.

### The procedure

You will find unrelated problems while working. Do not fix them in the current PR.

```
found something actionable
   ↓
search Jira for a duplicate     ← always first
   ↓
exists? ──yes──► reference it, move on
   │ no
   ↓
outside current scope? ──yes──► file an issue (To Do), return to the active ticket
   │ no
   ↓
it's part of the active ticket → fix it
```

If the request authorized find-and-fix, Claude may switch the active ticket to a discovered
issue — but it states the scope change explicitly and keeps it a separate PR unless the two
problems are genuinely inseparable. One issue, one coherent PR.

Why: a PR fixing three unrelated things is hard to review, hard to revert, and hides its own
risk. Widening scope mid-change is how small tickets become un-reviewable.

A filed issue carries the evidence you have: affected area, observed vs. expected behavior,
impact, relevant paths, and the ticket you were on. Filing is pre-authorized — no need to ask.
Do not file speculation, trivia, or anything the active ticket already covers.

## 12. Permission and safety model

[`.claude/settings.json`](../../.claude/settings.json) sorts tool calls into three buckets.
**That file is the source of truth** — this explains the concept, not the list, so the list can
change without this document going stale.

| Bucket    | Meaning                | Roughly what lives there                                                                                                                                                        |
| --------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **allow** | Runs without prompting | Read-only Atlassian lookups; read-only git; creating a branch; staging specific paths; committing; read-only `gh` queries; `yarn lint` / `tsc` / `test`                         |
| **ask**   | Prompts you first      | `git push`; creating/editing a PR; `gh api`; `yarn db:schema`; editing dependency manifests; all Jira and Confluence **writes**, including status transitions                   |
| **deny**  | Refused outright       | Reading/writing `.env`; **merging a PR**; `gh api` write methods; blanket staging; pushing `main`/`staging`; force-push; destructive database commands; the SES template script |

The shape: **reading is cheap, writing asks, irreversible or outward-facing is forbidden.**
Anything touching shared state — a merge, a shared branch, production data, real email — is
either gated behind you or off the table.

- **`deny` beats `ask`.** A denied pattern cannot be unlocked by a prompt.
- **`ask` is a real decision point.** A declined prompt means _don't_ — adjust, don't retry the
  same call another way.

Personal overrides go in `.claude/settings.local.json` — Claude Code writes it for you the
first time you approve a permission permanently. It is gitignored, so you will not normally see
it in `git status`. **Never commit it:** your machine's overrides would silently become
everyone's.

## 13. Git safety

Repository-side rules, from `CLAUDE.md` and `.claude/settings.json`:

- Implementation work never lands directly on `main` or `staging`.
- `git push origin main`, `git push origin staging`, and force-push are denied patterns.
- Branch is verified before every commit and push; specific paths are staged.
- **Never "test" branch protection by pushing to `main`.** Local `main` may be ahead of
  `origin/main`, so a test push can land real commits.
- **Merging is off the table by every route** — `gh pr merge`, a GitHub API call, or the web
  UI. Follow-up fixes go to the existing feature branch, never around the PR.

**Limitation:** these are _client-side_ guardrails — configuration in this repository, not
enforcement by GitHub. See [§17](#17-known-limitations-and-teamadmin-responsibilities).

## 14. CI behavior

Current workflows in [`.github/workflows/`](../../.github/workflows/), all on Node 20:

| Workflow                                                       | Trigger                            | Runs                                                                    |
| -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| [`lint.yml`](../../.github/workflows/lint.yml)                 | pull request                       | `yarn lint`                                                             |
| [`tsc.yml`](../../.github/workflows/tsc.yml)                   | push                               | `yarn tsc`                                                              |
| [`test.yml`](../../.github/workflows/test.yml)                 | push                               | `yarn test --passWithNoTests`                                           |
| [`auto-comment.yml`](../../.github/workflows/auto-comment.yml) | PR touching `prisma/schema.prisma` | comments a reminder to open a PlanetScale deploy request before merging |

- Lint runs on PRs; type-check and tests on pushes. Separate triggers, so a green PR page is
  not the same as a green type-check — check both.
- `--passWithNoTests` is load-bearing: **there are no test files yet.** Tests pass because
  nothing runs. Component tests would first need `jest-environment-jsdom` and a React testing
  library (Jest currently uses `ts-jest` with the default `node` environment).
- Whether these checks are _required_ before merge is a branch-protection setting, not
  something CI enforces.
- A husky pre-commit hook runs `npx pretty-quick --staged` locally.

Because lint and type-check fire on different triggers, **checking CI after the PR exists is
part of the job** — see [§10](#10-standard-engineering-lifecycle). Inspect with
`gh pr checks` and `gh run view`; both are read-only and need no approval.

## 15. Security considerations

- **Secrets.** Never print, echo, or copy `.env` values into output, code, or commits.
  Reference variables by name. Reading `.env` is denied.
- **Destructive database commands.** `yarn seed` **wipes the database first**;
  `yarn build:preview` force-pushes the schema and re-seeds. Never run `build:preview` to
  "test the build" — use `yarn build`. Confirm `DATABASE_URL` targets local Docker MySQL
  before any schema or seed command. Both are denied in settings for a reason.
- **External services with real side effects.** Email procedures send real mail via AWS SES;
  messaging fires real Pusher events; Mapbox calls consume quota. Verify which environment
  your credentials point at first.
- **Schema changes** require a PlanetScale deploy request before merging, and the generated
  folder under `prisma/migrations/` must be committed.
- **Credentials in team documentation.** Some older Confluence pages contain plaintext
  credentials. Treat them as sensitive: don't copy them into the repo, a commit, a ticket, or
  a Claude session — flag them for rotation.

## 16. Troubleshooting

| Symptom                                        | Cause / fix                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp` shows Atlassian failed or disconnected  | Token expired — re-authenticate via `/mcp`. If the browser never opens, complete the flow manually and return to the session.                                                                   |
| Claude can't see a Jira issue that exists      | MCP access mirrors your Atlassian account. Confirm you're on the right account and can open it in a browser. Also confirm the key — this project is `SCRUM`; the site hosts other projects too. |
| Claude doesn't know the project rules          | You started outside the repo root. Relaunch from the root so `CLAUDE.md`, `.claude/settings.json`, and `.mcp.json` load. Verify with `/permissions`.                                            |
| A tool call is refused with no prompt          | It matched a `deny` pattern. Intentional — check [`.claude/settings.json`](../../.claude/settings.json); don't route around it.                                                                 |
| `yarn tsc` — "is that even a script?"          | There's no `tsc` npm script; Yarn resolves `node_modules/.bin/tsc`. The command is correct.                                                                                                     |
| `gh` fails with an auth error                  | `gh auth status`, then `gh auth login`. Run it yourself — it's interactive.                                                                                                                     |
| App fails at startup on env vars               | `envsafe` validates at import time, so a missing value stops startup. Check names against [`README.md`](../../README.md); suffixed AWS keys are the usual culprit.                              |
| `yarn db:schema` prompts to reset the database | It runs `prisma migrate dev`, which may offer a reset on drift. Confirm your target database before agreeing.                                                                                   |

## 17. Known limitations and team/admin responsibilities

**Controlled by this repository** (versioned, reviewable, reliable): `CLAUDE.md`;
`.claude/settings.json` allow/ask/deny rules; `.mcp.json`; CI workflows; the husky hook.

**Controlled by GitHub org/repo admins** — outside this repo, not fixable by a PR here:

- Branch protection on `main` is **unverified**. The current developer cannot access
  repository Settings, so its configuration has not been confirmed either way. Nothing here
  claims server-side protection exists; assume no server-side rule will reject a bad push, and
  treat the repository-side rules above as the protection you can actually rely on.
- Whether CI checks are _required_ before merge; who can merge; whether review is mandatory.
- PlanetScale deploy-request permissions.

**Open items a future developer may pick up:**

- Confirm and document branch protection once someone has admin access.
- There is no test suite yet, so `test.yml` is a placeholder in practice.

Everything else in this document describes **current** behavior; only the items above are open
or planned.

## 18. Quick reference

```
1.  Jira first — get or create the issue            [To Do]
2.  transition the issue                       → [In Progress]
3.  git fetch origin && git switch -c <branch> origin/main
4.  investigate: code + READMEs; Confluence only if needed
5.  implement / document
6.  yarn lint && yarn tsc            (yarn test where applicable)
7.  self-review your diff
8.  git rev-parse --abbrev-ref HEAD  ← not main, not staging
9.  git add <specific paths> && git commit
10. git push -u origin <branch>      (prompts)
11. gh pr create --base main         (prompts)
12. transition the issue                       → [Code Review]
13. Jira comment: PR link + summary
    ── the PR is not the finish line ──
14. gh pr checks / gh run view       ← inspect CI
15. gh pr diff                       ← only intended changes?
16. failures from THIS change?  fix → validate → commit → push same branch → 14
    unrelated failure?          Jira duplicate search → reference/file → don't scope-creep
17. verify the ticket's acceptance criteria against what shipped
18. report PR readiness + remaining risks → STOP
    (or → [Blocked] with what's blocking and what's needed)
19. human reviews and merges, then sets     → [Done]
```

**Jira first. In Progress when you start. Feature branches only. Stage specific paths. Code
Review only once the PR exists. Own it through review-readiness — the PR is not the finish
line. Claude never merges and never sets Done.**

---

_Maintenance: keep this conceptual. When permissions change, update
[`.claude/settings.json`](../../.claude/settings.json) and leave §12's explanation alone unless
the concept itself changed._
