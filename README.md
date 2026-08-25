# NUCarpool

NUCarpool is a web app that helps Northeastern University students find carpool partners while on co-op. Students sign in with their Northeastern account, enter their commute and work schedule, and pick a role — driver, rider, or viewer. The app ranks compatible students by how well their commute and schedule overlap, shows them on a map, and lets them connect, message each other, and form carpool groups.

## Tech Stack

- **Next.js** (Pages Router), **React**, and **TypeScript**
- **tRPC** with **Zod** and **TanStack React Query** — typesafe API between the frontend and server
- **Prisma** ORM on **MySQL**
- **NextAuth** — Azure AD (Northeastern SSO); Google sign-in is added only when `NEXT_PUBLIC_ENV=staging`
- **Mapbox GL JS** — map, geocoding, and routing
- **Pusher** — real-time messaging
- **AWS SES** for notification email, **AWS S3** for profile pictures
- **Mixpanel** — analytics
- **Tailwind CSS**, with Headless UI, MUI, and Ant Design components
- **Docker Compose** — local MySQL
- **Yarn** (Classic) — package manager

## Getting Started

Requires Node 22 (the version in `.nvmrc`), Yarn 1.x, and Docker.

```bash
git clone git@github.com:CarpoolNU/nucarpool.git
cd nucarpool
yarn install
```

Create a `.env` in the repository root by copying the example file, then fill in real values:

```bash
cp .env.example .env
```

Ask a maintainer for development credentials. The app validates these at startup and will not boot if one is missing.

Then start the database, set up the schema, and run the app:

```bash
yarn db:start     # local MySQL 8.0 in Docker
yarn db:schema    # prisma migrate dev && prisma generate
yarn seed         # optional: DELETES all rows, then inserts generated users
yarn dev
```

The app runs at <http://localhost:3000>. `yarn startup` runs `yarn db:start` and `yarn dev` together.

### Upgrading an existing local database

The local container tracks MySQL 8.0 to match the major version PlanetScale serves. It was previously pinned to 5.7. On first start, 8.0 attempts an in-place upgrade of a 5.7 data directory — but that upgrade only succeeds if 5.7 shut down cleanly. If the container was ever force-stopped, InnoDB refuses (`Upgrade is not supported after a crash or shutdown with innodb_fast_shutdown = 2`) and the container exits 1.

Chasing a clean-shutdown upgrade is not worth it for generated development data. If you set this project up before the version change, replace the data directory once:

```bash
yarn db:stop
mv nucarpool-db-data nucarpool-db-data.mysql57-backup   # or delete it outright
yarn db:start                                           # 8.0 initializes a fresh data directory
yarn db:schema                                          # apply all migrations
yarn seed                                               # optional: regenerate sample users
```

This discards your local rows. That is safe — the directory is gitignored, holds only generated development data, and `yarn seed` recreates it. Nothing on PlanetScale is affected. Once the new container is up, `rm -rf nucarpool-db-data.mysql57-backup` to reclaim the space.

On Apple Silicon the container now runs natively rather than under x86 emulation, because 8.0 publishes an arm64 image and 5.7 did not.

### Seeding resets your local data

`yarn seed` is **not additive**. Before inserting anything, [`prisma/seed.ts`](prisma/seed.ts) deletes every row from `request`, `message`, `conversation`, `carpool_search`, `location`, `group` and `user`, then inserts about 70 generated users with fixed ids, 10 groups, and one request per user — each request with a conversation and a short two-sided message thread, so the messaging UI has something to render.

Addresses are synthesised offline and deterministically, so seeding makes **no network calls and consumes no Mapbox quota**. Set `SEED_REVERSE_GEOCODE=1` to reverse geocode against Mapbox instead; results are cached per coordinate, and any failure falls back to a synthesised address.

Three commands reach that script, not one:

| Command              | How it seeds                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `yarn seed`          | Directly                                                                                              |
| `yarn build:preview` | Force-pushes the schema, then re-seeds                                                                |
| `yarn db:schema`     | Only if `prisma migrate dev` resets the database — **Prisma then runs the seed script automatically** |

The third is the surprising one, because it is part of normal setup. To apply migrations without seeding, run `npx prisma migrate dev --skip-seed`; appending the flag to `yarn db:schema` does not work, because yarn passes it to `prisma generate` instead.

Because the script writes to whatever `DATABASE_URL` points at, [`src/utils/seedGuard.ts`](src/utils/seedGuard.ts) checks the target host before the first delete and refuses anything that is not local:

```
Refusing to seed.

DATABASE_URL points at the non-local host "aws.connect.psdb.cloud".
...
```

Allowed hosts are `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `mysql` and `mysql-on-docker`. The guard fails closed — a missing or unparseable `DATABASE_URL` is refused rather than assumed local — and compares the hostname only, so a password containing `localhost` cannot fake a match. To extend the list, edit `LOCAL_HOSTNAMES` in that file.

If you genuinely need to seed a non-local database, opt in for that single command:

```bash
SEED_ALLOW_REMOTE=1 yarn seed
```

Think carefully before you do. Against staging or production this deletes every user, group, message, request, location and carpool search, and the app cannot undo it. `yarn build:preview` is deliberately **not** given the override, so it now fails the guard if it is ever pointed at a remote database.

## Environment Variables

[`.env.example`](.env.example) is the authoritative list. It documents every variable, grouped by service, with placeholder values and notes on which are optional. Copy it to `.env` and fill in real values — never commit them, and keep placeholders only in `.env.example` itself. `.env` is gitignored.

Four things that commonly trip people up:

- **AWS keys use suffixed names** — `ACCESS_KEY_ID_AWS`, `SECRET_ACCESS_KEY_AWS`, `REGION_AWS`. The standard `AWS_*` names fail validation.
- **`MYSQL_*` are read only by Docker Compose**, to provision the container. The app reads `DATABASE_URL`, so the user, password, port, and database name inside it must match the container's.
- **`NEXT_PUBLIC_*` variables are inlined into the client bundle** at build time and are therefore public. Everything else is server-only.
- **`GOOGLE_*` are required even locally.** The Google sign-in button only appears when `NEXT_PUBLIC_ENV=staging`, but the variables are validated in every environment.
- **`NEXT_PUBLIC_ENV` must be one of `production`, `staging`, or `development`** — anything else fails validation (SCRUM-247). It selects the auth providers and is written into every S3 profile-picture key (`profile-pictures/{env}/{userId}`), so changing it orphans existing uploads. Leaving it unset locally is fine: it defaults to `development`. A production build has no such default and fails without it.

Validation runs at import time in [`src/utils/env/browser.ts`](src/utils/env/browser.ts) and [`src/utils/env/server.ts`](src/utils/env/server.ts), which is why a missing variable stops the app from starting rather than failing later.

## Useful Commands

| Command                          | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `yarn dev`                       | Start the development server on port 3000            |
| `yarn startup`                   | Start the local database, then the dev server        |
| `yarn build`                     | Production build                                     |
| `yarn lint`                      | Run ESLint                                           |
| `yarn tsc`                       | Type check                                           |
| `yarn test`                      | Run Jest (unit tests for the seed guard)             |
| `yarn db:start` / `yarn db:stop` | Start / stop the local MySQL container               |
| `yarn db:schema`                 | Apply migrations and regenerate the Prisma client    |
| `yarn seed`                      | **Wipes** the database, then inserts generated users |

## Documentation

This project is developed with a Jira workflow. Read the workflow guide before your first contribution — it covers conventions this README does not. The layer docs are worth reading before you edit the layer they describe.

| Document                                                                        | Covers                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code development workflow](docs/development/AI_DEVELOPMENT_WORKFLOW.md) | Claude Code and Atlassian MCP setup, the Jira-first ticket lifecycle, the allow/ask/deny permission model, git and branch safety, CI behavior, and troubleshooting                                                    |
| [`CLAUDE.md`](CLAUDE.md)                                                        | The instructions Claude Code loads every session: commands, safety boundaries, architecture and data-model gotchas, and git policy. Useful even if you never run Claude Code — it documents the project, not the tool |
| [tRPC routers](src/server/router/README.md)                                     | Routers, per-request context, auth middleware, and how to write a procedure — read before adding or changing an endpoint                                                                                              |
| [Database layer](src/server/db/README.md)                                       | The Prisma client, schema conventions, and the migration workflow — read before touching `prisma/schema.prisma`                                                                                                       |
