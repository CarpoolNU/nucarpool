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
yarn test         # jest
yarn test -- path/to/file.test.ts     # single file
yarn db:start / yarn db:stop          # local MySQL 5.7 in Docker
yarn db:schema                        # prisma migrate dev && prisma generate
```

Run `yarn lint` and `yarn tsc` before calling work done. CI runs `yarn lint` on PRs and `yarn tsc` + `yarn test --passWithNoTests` on push (Node 20). A husky pre-commit hook runs `npx pretty-quick --staged`.

There are no test files yet. Jest uses the `ts-jest` preset with the default `node` environment and no setup files — component tests would need `jest-environment-jsdom` and a React testing library added first.

## Safety

**Secrets**

- Never print, echo, or copy `.env` values into output, code, or commits. Reference variables by name only.
- `.env` is gitignored. Never commit it or any credential.

**Database — these commands destroy data**

- `yarn seed` **wipes the database first**. [`prisma/seed.ts`](prisma/seed.ts) deletes every row from `request`, `carpool_search`, `location`, `group`, `message`, and `user`, then inserts ~70 generated users. It also makes ~140 Mapbox reverse-geocode calls.
- `yarn build:preview` runs `prisma db push` auto-confirmed with `echo "y"` **and then re-seeds**. It can force-alter a schema and wipe data — never run it to "test the build"; use `yarn build`.
- `yarn db:schema` runs `prisma migrate dev`, which writes migrations and may prompt to reset the local database on drift.
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

When you discover an actionable bug, regression, tech-debt item, or follow-up
during development: **search Jira first** — if a matching issue exists, reference
it rather than filing a duplicate. If none exists and the problem is outside the
current task's scope, create the issue. Filing it is authorized; you do not need
to be asked.

**Do not widen the current change or PR to fix an unrelated discovery.** Track it
in Jira and stay on the active ticket.

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

**Your workflow ends at the pull request.** Report the PR and its check status,
then stop. Never merge a PR, and never move a ticket to `Done` — both follow the
merge, and the user performs every merge manually through GitHub.

- Never commit implementation work to `main` or `staging`, and never push either
  branch.
- Never test branch protection by pushing to `main`. Local `main` may be ahead of
  `origin/main`, so a "test" push can land real commits.
- Stage specific paths. Never `git add -A` or `git commit -a` — the working tree
  may hold unrelated changes that must stay out of the commit and PR.
- Never force-push a shared branch or bypass branch protection.

## References

- [`README.md`](README.md) — setup and the full environment variable list
- [`src/server/router/README.md`](src/server/router/README.md) — routers, context, writing procedures
- [`src/server/db/README.md`](src/server/db/README.md) — Prisma client, schema notes, migration workflow
