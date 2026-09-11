# NUCarpool

A web app that helps Northeastern University students find carpool partners while on co-op. Students sign in with their Northeastern account, enter their commute and work schedule, and pick a role — driver, rider, or viewer. The app ranks compatible students by how well their commute and schedule overlap, shows them on a map, and lets them connect, message each other, and form carpool groups.

## Tech stack

| Area      | Choice                                                                     |
| --------- | -------------------------------------------------------------------------- |
| Framework | Next.js (**Pages Router**), React, TypeScript                              |
| API       | tRPC + Zod + TanStack React Query — no REST layer                          |
| Data      | Prisma ORM on MySQL (PlanetScale in deployed environments)                 |
| Auth      | NextAuth with Azure AD (Northeastern SSO); Google added only on staging    |
| Map       | Mapbox GL JS — map, geocoding, routing                                     |
| Realtime  | Pusher — messaging and unread counts                                       |
| AWS       | SES for notification email, S3 for profile pictures                        |
| Styling   | Tailwind, plus Headless UI, MUI, Ant Design and styled-components          |
| Tooling   | Yarn Classic (1.x), Docker Compose for local MySQL, Jest, ESLint, Prettier |

Five UI systems coexist. Use whichever the file you are editing already uses; do not add a sixth.

## Running locally

Requires **Node 22** (see [`.nvmrc`](.nvmrc)), Yarn 1.x, and Docker.

```bash
git clone git@github.com:CarpoolNU/nucarpool.git
cd nucarpool
yarn install
cp .env.example .env      # then fill in real values
yarn db:start             # local MySQL 8.0 in Docker
yarn db:schema            # apply migrations, regenerate the Prisma client
yarn dev                  # http://localhost:3000
```

Ask a maintainer for development credentials. `yarn startup` runs `yarn db:start` and `yarn dev` together.

`yarn seed` loads about 70 generated users so the map and messaging have content. **It deletes every row first** — see [Dangerous commands](#dangerous-commands).

### Working in a worktree

Concurrent sessions each get their own checkout under `.claude/worktrees/`, so one session's branch switch cannot move another's HEAD.

```bash
claude --worktree <task-name>   # creates the worktree, copies .env per .worktreeinclude
./scripts/wt-bootstrap.sh       # dependencies, Prisma client, husky hooks
```

Then work normally. [`wt-bootstrap.sh`](scripts/wt-bootstrap.sh) is idempotent and refuses to run on `main`, on `staging`, or in the primary checkout.

Three things stay shared and are not per-worktree: run `yarn db:start` only from the primary checkout, because the container name and port are fixed; only one worktree at a time can hold port 3000 for `yarn dev`; and `yarn test:db` needs a `TEST_DATABASE_URL` naming a database no other worktree uses, since the harness truncates every table and does not lock against a concurrent run.

## Environment variables

[`.env.example`](.env.example) is the authoritative list, grouped by service with notes on which are optional. Validation runs at import time in [`src/utils/env/browser.ts`](src/utils/env/browser.ts) and [`src/utils/env/server.ts`](src/utils/env/server.ts), so a missing variable stops the app from starting rather than failing later.

Four things that reliably trip people up:

- **AWS keys use suffixed names** — `ACCESS_KEY_ID_AWS`, `SECRET_ACCESS_KEY_AWS`, `REGION_AWS`. The standard `AWS_*` names fail validation.
- **`MYSQL_*` is read only by Docker Compose** to provision the container. The app reads `DATABASE_URL`, so the credentials inside it must match the container's.
- **`GOOGLE_*` is required even locally**, though the Google button only appears when `NEXT_PUBLIC_ENV=staging`.
- **`NEXT_PUBLIC_ENV` must be `production`, `staging` or `development`.** It selects auth providers and is written into every S3 profile-picture key (`profile-pictures/{env}/{userId}`), so changing it orphans existing uploads. Unset locally it defaults to `development`; a production build has no default and fails without it.

`NEXT_PUBLIC_*` values are inlined into the client bundle and are therefore public. Everything else is server-only.

## Commands

| Command                          | Purpose                                             |
| -------------------------------- | --------------------------------------------------- |
| `yarn dev`                       | Development server on port 3000                     |
| `yarn startup`                   | Local database, then the dev server                 |
| `yarn build`                     | Production build                                    |
| `yarn lint`                      | ESLint (`--max-warnings=0`)                         |
| `yarn tsc`                       | Type check                                          |
| `yarn test`                      | Jest — mocks only, no database                      |
| `yarn test:db`                   | Integration suite against `TEST_DATABASE_URL`       |
| `yarn check:format`              | Prettier, check only                                |
| `yarn check:env`                 | `.env.example` covers every required variable       |
| `yarn check:amplify`             | `amplify.yml` carries every variable to the runtime |
| `yarn check:routes`              | No test file compiles into a page route             |
| `yarn db:start` / `yarn db:stop` | Start / stop the local MySQL container              |
| `yarn db:schema`                 | Apply migrations, regenerate the Prisma client      |
| `yarn seed`                      | **Wipes** the database, then inserts sample users   |

CI runs `lint`, `tsc`, `test`, `build`, `env-contract`, `schema` and `format` on every pull request. `yarn lint` and `yarn tsc` are the two worth running before you push.

## Dangerous commands

These destroy data. Confirm `DATABASE_URL` points at your local container before running any of them.

| Command          | What it does                                                                      |
| ---------------- | --------------------------------------------------------------------------------- |
| `yarn seed`      | Deletes every row in the app tables, then inserts generated users                 |
| `yarn db:schema` | May prompt to reset the local database on drift — **and Prisma then seeds it**    |
| `yarn test:db`   | Truncates every table in the database `TEST_DATABASE_URL` names, before each test |

Two guards make these safe by default, and **neither has an override**:

- [`seedGuard.ts`](src/utils/seedGuard.ts) refuses to seed any non-local host and fails closed on a missing or unparseable `DATABASE_URL`.
- [`testDatabaseGuard.ts`](src/utils/testDatabaseGuard.ts) refuses a non-local host, a database whose name lacks a `test` word or contains `prod`/`stag`/`live`/`main`, and a `TEST_DATABASE_URL` pointing at the same database as `DATABASE_URL`.

`yarn db:schema` is the surprising one, because it is part of normal setup: if `prisma migrate dev` resets the database, Prisma runs the seed script automatically. Use `npx prisma migrate dev --skip-seed` to avoid that — appending the flag to `yarn db:schema` does not work, because yarn passes it to `prisma generate`.

Never run `prisma db push`, `prisma migrate reset`, or anything in [`scripts/`](scripts/) against a shared database without reading the docs below first.

## Formatting

`yarn check:format` runs `prettier --check .` and is a CI job. A husky pre-commit hook runs `pretty-quick --staged`, which only covers staged files — so a commit made with `--no-verify` can still fail the check.

[`.gitattributes`](.gitattributes) normalises line endings to LF on every platform, because Prettier's `endOfLine` default is `lf` and a CRLF checkout otherwise fails the check across the whole repository. If you cloned before it existed, run `git add --renormalize .` once.

## Where to look next

| Document                                                | Covers                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [Database layer](src/server/db/README.md)               | Schema conventions, the PlanetScale workflow, data-model constraints |
| [tRPC routers](src/server/router/README.md)             | Context, auth middleware, how to write a procedure                   |
| [Testing](docs/testing.md)                              | The two Jest projects, what the suite does and does not prove        |
| [Deployment](docs/deployment.md)                        | Amplify, the environment contract, CSP, checking what is live        |
| [Operational scripts](scripts/README.md)                | Backfill, check and repair scripts — read before running any of them |
| [Development workflow](docs/AI_DEVELOPMENT_WORKFLOW.md) | The Jira-first ticket lifecycle, branch safety, the issue format     |

[`CLAUDE.md`](CLAUDE.md) holds the instructions Claude Code loads each session. It is agent configuration rather than project documentation; the docs above are the developer-facing versions.
