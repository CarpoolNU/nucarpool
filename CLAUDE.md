# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

NUCarpool matches Northeastern co-op students into carpools. Next.js **Pages Router** + TypeScript, tRPC v10 (Zod + React Query), Prisma on MySQL, NextAuth (Azure AD), Mapbox, Pusher, AWS SES/S3, Tailwind.

## Commands

Yarn Classic (1.x) is the package manager — use `yarn`, not npm or pnpm.

```bash
yarn dev          # dev server on :3000
yarn startup      # yarn db:start && next dev
yarn build        # production build
yarn lint         # eslint
yarn tsc          # type check (no npm script; resolves node_modules/.bin/tsc)
yarn check:env    # .env.example covers every variable the app requires
yarn test         # jest
yarn test -- path/to/file.test.ts     # single file
yarn db:start / yarn db:stop          # local MySQL 8.0 in Docker
yarn db:schema                        # prisma migrate dev && prisma generate
```

Run `yarn lint` and `yarn tsc` before calling work done. CI runs five checks on Node 20 — `lint`, `tsc`, `test`, `build`, and `env-contract` — on every pull request and on pushes to `main`; [`.github/workflows/`](.github/workflows/) is authoritative for the triggers. `build` runs a real `next build` against placeholder environment values, so a PR can no longer go green while the app fails to build. `env-contract` fails when a variable required by [`src/utils/env/`](src/utils/env/) is missing from `.env.example`. `lint` pins `--max-warnings=0`, which matters because rules like `react-hooks/exhaustive-deps` are warnings rather than errors. A husky pre-commit hook runs `npx pretty-quick --staged`.

Test coverage is narrow but no longer empty: [`src/utils/seedGuard.test.ts`](src/utils/seedGuard.test.ts) is the only suite, and `test.yml` no longer passes `--passWithNoTests`, so an empty run fails. Jest uses the `ts-jest` preset with the default `node` environment and no setup files — component tests would need `jest-environment-jsdom` and a React testing library added first. A passing `yarn test` still says nothing about components, routers, or pages.

## Safety

**Secrets**

- Never print, echo, or copy `.env` values into output, code, or commits. Reference variables by name only.
- `.env` is gitignored. Never commit it or any credential.

**Database — these commands destroy data**

- `yarn seed` **wipes the database first**. [`prisma/seed.ts`](prisma/seed.ts) deletes every row from `request`, `carpool_search`, `location`, `group`, `message`, and `user`, then inserts ~70 generated users. It also makes ~140 Mapbox reverse-geocode calls.
- [`src/utils/seedGuard.ts`](src/utils/seedGuard.ts) refuses to seed a non-local host, fails closed on a missing or unparseable `DATABASE_URL`, and covers all three seed paths because it runs inside `seed.ts` itself. `SEED_ALLOW_REMOTE=1` overrides it. **The guard does not relax any rule here** — seed commands remain denied in [`.claude/settings.json`](.claude/settings.json), and the override must never be set to make something work.
- `yarn build:preview` runs `prisma db push` auto-confirmed with `echo "y"` **and then re-seeds**. It can force-alter a schema and wipe data — never run it to "test the build"; use `yarn build`.
- `yarn db:schema` runs `prisma migrate dev`, which writes migrations and may prompt to reset the local database on drift. **If it resets, Prisma runs the seed script automatically** — so this command can wipe and regenerate data without `yarn seed` being typed. Opt out with `npx prisma migrate dev --skip-seed`; appending the flag to `yarn db:schema` does not work, because yarn passes it to `prisma generate` instead.
- Before running any of these, confirm `DATABASE_URL` targets the local Docker MySQL — not staging, production, or PlanetScale. Ask if unsure.
- Never run `prisma db push`, `prisma migrate reset`, or a destructive migration without explicit approval. Use `yarn db:schema` for schema work; pushing skips migration history.

**External services with real side effects**

- `user.email.*` procedures send **real mail** through AWS SES.
- `user.message.sendMessage` fires **real Pusher events** on `conversation-{requestId}` and `notification-{toUserId}`.
- `mapbox.*` procedures, [`src/utils/map/geocode.ts`](src/utils/map/geocode.ts), and the seed script consume Mapbox API quota.
- [`scripts/emailtemplate.py`](scripts/emailtemplate.py) is active infrastructure — it creates/updates the SES templates the app sends. Running it mutates templates in the configured AWS account.
- Verify which environment your credentials point at before triggering any of these. Do not exercise them against shared or production resources.

**Repo hygiene**

- Do not modify `package.json`, `yarn.lock`, or dependencies during unrelated work.
- Never stage or commit `.claude/settings.local.json`. It is gitignored and holds one
  developer's machine-local permission overrides; committing it would change what Claude Code
  is allowed to do for the whole team. `.claude/settings.json` is the shared file and stays
  tracked.

## Architecture essentials

- **No REST layer** — every endpoint is a tRPC procedure. `appRouter` is composed in [`src/server/router/index.ts`](src/server/router/index.ts) and served at [`src/pages/api/trpc/[trpc].ts`](src/pages/api/trpc/%5Btrpc%5D.ts).
- Procedure builders and auth middleware live in [`createRouter.ts`](src/server/router/createRouter.ts); per-request context (`ctx.prisma`, `ctx.session`, `ctx.sesClient`) in [`context.ts`](src/server/router/context.ts).
- The frontend is typed from `AppRouter`, so renaming a procedure breaks compilation at every call site. That is intentional.
- Authoritative docs — read before editing either layer:
  - [`src/server/router/README.md`](src/server/router/README.md)
  - [`src/server/db/README.md`](src/server/db/README.md)

## Data-model gotchas

- A user's carpool details are **not** on `User`. `User` holds identity/profile. Role, company, schedule, seats, status, and group membership live on `CarpoolSearch`, which points at two `Location` rows (home and company).
- The API returns a **flattened** shape: `user.me` ([`src/server/router/user.ts`](src/server/router/user.ts)) spreads `carpoolSearches[0]` and both locations onto the user object, and `convertCarpoolSearchToPublic` ([`src/utils/publicUser.ts`](src/utils/publicUser.ts)) builds the same flat `PublicUser` from a `CarpoolSearch` with its relations. `convertToPublic` in that file does no merging — it takes an already-merged user and strips sensitive fields. Flat in the frontend does not mean flat in storage.
- Field names change across that boundary: `seatsAvail` → `seatAvail`, `startDate`/`endDate` → `coopStartDate`/`coopEndDate`.
- The merged shapes are hand-maintained types in [`src/utils/types.ts`](src/utils/types.ts) (`User`, `PublicUser`, `MapUser`, `EnhancedPublicUser`) — not inferred from Prisma. **Adding a field means updating `schema.prisma`, the merge site, the converters, and the type.**
- Code assumes one `CarpoolSearch` per user (`findFirst`, `carpoolSearches[0]`) even though the schema allows many.

## Auth and permissions

- NextAuth with a custom Prisma adapter ([`[...nextauth].ts`](src/pages/api/auth/%5B...nextauth%5D.ts)). Azure AD only; `NEXT_PUBLIC_ENV=staging` adds Google.
- Default to `protectedRouter` (throws `UNAUTHORIZED` without a session). `adminRouter` requires `permission !== "USER"`; `admin.updateUserPermission` additionally requires `MANAGER`. Plain `procedure` is public and currently unused.
- The session carries `id`, `isOnboarded`, `tutorialCompleted`, and `permission` (typed in `next-auth.d.ts`); `getServerSideProps` guards read those.
- `NEXT_PUBLIC_ENV` also namespaces S3 profile-picture keys (`profile-pictures/{env}/{userId}`) and restricts email recipients to `@gmail.com` in staging — changing its value orphans existing uploads.

## Conventions

- Schema changes require a **PlanetScale deploy request** before merging; a GitHub Action comments on any PR touching `schema.prisma`. Commit the generated folder under `prisma/migrations/`.
- `relationMode = "prisma"` — foreign keys are emulated. New relation scalar fields need an explicit `@@index`, and `onDelete: Cascade` runs in Prisma, not MySQL.
- `Account`, `Session`, `User`, and `VerificationToken` back NextAuth. Changing them can break sign-in.
- `superjson` is the tRPC transformer, so `Date` survives the wire; Zod inputs use `z.date()` directly.
- Env vars are validated with `envsafe` at import time; missing required values can prevent startup. `NEXTAUTH_SECRET` has a development default. AWS keys use **suffixed** names — `ACCESS_KEY_ID_AWS`, `SECRET_ACCESS_KEY_AWS`, `REGION_AWS`; standard `AWS_*` names fail validation. Full list in the README.
- Five UI systems coexist (Tailwind, Headless UI, MUI, Ant Design, styled-components). Use the one already present in the file being edited; do not add a sixth.

## External knowledge — Confluence and Jira

Reached through the `atlassian` MCP server. Reads are fine when relevant; writes
follow the rules below and in **Work tracking**.

- **Confluence** is the authoritative home for long-form team, engineering,
  infrastructure, operational, and process documentation — deployment, AWS,
  PlanetScale, environment setup, PRDs, research. Little of it is in this repo.
- **Jira project `SCRUM`** ("Carpool Main") tracks work. When a request references
  `SCRUM-###`, retrieve that issue before acting.
- Search Confluence only when a task needs knowledge this repo does not contain,
  and fetch the specific pages needed — not whole spaces.
- Tickets define **what** should change; this repo and its READMEs define **how**
  the code works today. Tickets are often thin — never invent missing scope, ask.
- Confluence pages may be stale. Verify technical claims against the code.
- Jira and Confluence writes are available. Use them when the current task is
  explicitly about project management or documentation, when **Work tracking**
  below authorizes it, or when an established workflow does — never as an
  unannounced side effect. Say what you changed.

## Work tracking

Jira project `SCRUM` is the source of truth for engineering work, and meaningful
work should be associated with an issue.

**Jira status lifecycle** — keep the active issue's status synchronized with the
actual state of the work:

```
To Do → In Progress ⇄ Blocked → Code Review → Done (human only)
```

- `To Do` — issue exists but actual work has not started. Creating or selecting
  an issue does not move it.
- `In Progress` — transition when you begin actual implementation,
  investigation, or documentation work.
- `Blocked` — **exception state.** Use only when work genuinely cannot continue:
  missing access, an external dependency, a required human or team decision,
  unavailable required information, or another real blocker to useful progress.
  Do **not** use it for ordinary uncertainty you can resolve by investigating
  the repo, Jira, Confluence, or git history. When transitioning, comment with
  what is blocking the work and what is needed to resume. Transition back to
  `In Progress` when the blocker clears.
- `Code Review` — transition only after the feature branch is pushed **and** the
  PR actually exists. Pair it with a comment carrying the PR link and a concise
  summary.
- `Done` — **never set by you.** It follows the human merge, set manually in
  Jira or by future deterministic automation.

A ticket in `Code Review` with no PR, or `Done` with nothing merged, indicates the Jira status is inconsistent with the actual state of the work.

Resolve transitions by workflow status **name**, not by a hard-coded transition
ID — IDs are project configuration and can change.

When you discover an actionable bug, regression, tech-debt item, or follow-up
during development: **search Jira first** — if a matching issue exists, reference
it rather than filing a duplicate. If none exists and the problem is outside the
current task's scope, create the issue. Filing it is authorized; you do not need
to be asked.

**A newly created discovered issue stays in `To Do`.** Filing is not starting.
Move it to `In Progress` only when the request authorizes working on that problem
(for example "find and fix", "resolve", "work on") **and** you actually begin work
on it. Discovery, creation, or apparent importance are never sufficient on their
own. User intent decides whether a request is find-only or find-and-fix; absent
explicit authorization to fix, assume find-only.

**Do not widen the current change or PR to fix an unrelated discovery.** Track it
in Jira and stay on the active ticket. If a request did authorize fixing what you
find, you may switch the active ticket — but state the scope change explicitly and
keep it a separate PR unless the problems are genuinely inseparable.

Give a new issue the evidence you have: affected area, observed vs. expected
behavior, impact, relevant paths, and the ticket you were on when you found it.
Do not file trivial observations, speculation, or anything the active ticket
already covers.

## Git and GitHub

**GitHub branch protection on `main` is UNVERIFIED** — the current developer
cannot access repository Settings, so its configuration has not been confirmed
either way. Assume nothing rejects a bad push server-side: these rules and
`.claude/settings.json` are the only protection you can rely on.

Implementation work happens on a feature branch off a freshly fetched
`origin/main`, and pull requests target `main`. Use `staging` only if the
current team workflow explicitly requires it.

**Before every commit and every push, run `git rev-parse --abbrev-ref HEAD`.** If
it returns `main` or `staging`, stop and say so — do not commit, do not push.

You may create and update feature branches, commit and push them, create and
update pull requests against `main`, and inspect PR checks and status.

**You own delivery through PR readiness. The human owns the merge.** Creating the
PR is not the finish line — a PR that has not been checked is not delivered. The
merge is the boundary, and it is not yours.

After the PR exists, keep working: transition the issue to `Code Review`, comment
the PR link plus a concise implementation summary, then inspect the PR's checks
and its final diff. Confirm the PR contains only the intended changes, and verify
the ticket's acceptance criteria against what was actually implemented.

If a check fails **because of the current change**: diagnose it, fix it, validate
locally, then commit and push to the **same** feature branch and re-check. Never
open a new branch or PR to fix the current PR's own failures. Repeat as
reasonably necessary until the PR is review-ready.

If a check exposes an **unrelated** problem, use the discovered-issue workflow
above — reference or file a Jira issue, and do not scope-creep the current PR. If
an unrelated failure genuinely prevents the PR from becoming review-ready and
cannot be resolved within this ticket, use `Blocked`.

Report remaining risks or unmet acceptance criteria rather than implying the work
is clean when it is not.

**Stop only when either** the PR is ready for human review, **or** you are
genuinely blocked and Jira accurately reflects that. Never merge a PR, and never
move a ticket to `Done` — both follow the merge, and the user performs every
merge manually through GitHub.

- Never commit implementation work to `main` or `staging`, and never push either
  branch.
- Never test branch protection by pushing to `main`. Local `main` may be ahead of
  `origin/main`, so a "test" push can land real commits.
- Stage specific paths. Never `git add -A` or `git commit -a` — the working tree
  may hold unrelated changes that must stay out of the commit and PR.
- Never force-push a shared branch or bypass branch protection.
- Never merge by any route — not `gh pr merge`, not a GitHub API call, not the
  web UI. Merging is the human's, without exception.

## References

- [`README.md`](README.md) — setup and the full environment variable list
- [`src/server/router/README.md`](src/server/router/README.md) — routers, context, writing procedures
- [`src/server/db/README.md`](src/server/db/README.md) — Prisma client, schema notes, migration workflow
