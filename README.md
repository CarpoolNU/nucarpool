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

Two commands reach that script, not one:

| Command          | How it seeds                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `yarn seed`      | Directly                                                                                              |
| `yarn db:schema` | Only if `prisma migrate dev` resets the database — **Prisma then runs the seed script automatically** |

The second is the surprising one, because it is part of normal setup. To apply migrations without seeding, run `npx prisma migrate dev --skip-seed`; appending the flag to `yarn db:schema` does not work, because yarn passes it to `prisma generate` instead.

There used to be a third, `yarn build:preview`, which force-pushed the schema and then re-seeded. It was deleted in SCRUM-249 — see [the db README](src/server/db/README.md#buildpreview-is-gone-and-why-it-had-to-be).

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

Think carefully before you do. Against staging or production this deletes every user, group, message, request, location and carpool search, and the app cannot undo it.

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

## Deployment

**The app deploys on AWS Amplify Hosting.** [`amplify.yml`](amplify.yml) at the repository root is the build specification, and a file at that path **takes precedence over the build settings in the Amplify console** — so the repository is authoritative for how the app is built and what is deployed.

Its build phase writes the container's environment into `.env.production` (so `envsafe` can read it) and then ends in:

```
yarn run build:${BUILD_ENV}
```

`BUILD_ENV` is set **per branch in the Amplify console**, which means the script that actually runs cannot be determined from the repository. It resolves to one of these three, all equivalent apart from `NODE_ENV`:

| Script              | Command                                              |
| ------------------- | ---------------------------------------------------- |
| `build:main`        | `prisma generate && next build`                      |
| `build:development` | `NODE_ENV=development prisma generate && next build` |
| `build:production`  | `NODE_ENV=production prisma generate && next build`  |

All three used a single `&` until SCRUM-304, which backgrounded `prisma generate` instead of sequencing it and discarded its exit code. Because the console selects the script by variable, **a `package.json` script is part of the deploy surface** — that is why `build:preview`, which force-pushed the schema and re-seeded, was deleted rather than merely documented (SCRUM-249).

Two things are deliberately still true and worth knowing:

- **Nothing applies migration files to a shared database.** No step runs `prisma migrate deploy`; schema promotion is a PlanetScale Deploy Request. See [the db README](src/server/db/README.md#what-migrations-are-for-here-and-what-they-are-not).
- **`getBaseUrl` in [`src/utils/trpc.ts`](src/utils/trpc.ts) still branches on `VERCEL_URL`**, which is never set on Amplify, so the branch is dead. Removing it is tracked separately as **SCRUM-310**; it is left alone here to keep this change to `package.json` and the docs.

## Content Security Policy

The app sends security headers on every route from [`next.config.js`](next.config.js), pinned by [`next.config.test.ts`](next.config.test.ts). Five of them enforce immediately. The sixth, the Content Security Policy, is deliberately still **report-only**: it has never been exercised in a browser against the map, chat and profile-picture upload, so enforcing it blind could break Mapbox's workers or a third-party origin in production.

Violations post to `/api/csp-report`, which logs one line per violation prefixed `[csp-report]`. Reading them:

```
[csp-report] {"documentUri":"https://…/","blockedUri":"https://…","effectiveDirective":"connect-src", …}
```

`effectiveDirective` is the directive that would have blocked the load, and `blockedUri` is what it would have blocked — together they say which line of the policy is too narrow. `sample` appears for inline script and style violations only.

**What "clean enough to enforce" means.** Not zero reports — browser extensions inject scripts and styles into any page and generate violations the app cannot fix or prevent. The bar is that every violation traceable to the app's own code is resolved, having exercised all of sign-in, the map, chat, and a profile-picture upload on a deployed environment:

- No violation whose `blockedUri` is a first-party path or an origin the app deliberately calls (`*.mapbox.com`, `*.pusher.com`, `*.mixpanel.com`, the S3 bucket, Google Fonts).
- No `worker-src` or `child-src` violation — those mean the map is broken, not merely reported.
- Remaining violations attributable to extensions, typically with a `blockedUri` of `chrome-extension:`, `moz-extension:` or `data:`.

Enforcing is then a one-line change: rename the header from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Exactly one test fails when you do — the one that pins report-only — and updating it is part of that change.

Two caveats worth knowing before relying on the reports. The rate limit is 100 reports per minute **per server instance**, so a serverless deployment's real ceiling scales with concurrency and reports beyond it are dropped (the count of drops is logged when the window rolls over, so loss is never silent). And Safari and Firefox only implement the deprecated `report-uri`, so the newer `report-to` path is effectively Chrome and Edge; the policy sends both.

## Documentation

This project is developed with a Jira workflow. Read the workflow guide before your first contribution — it covers conventions this README does not. The layer docs are worth reading before you edit the layer they describe.

| Document                                                                        | Covers                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code development workflow](docs/development/AI_DEVELOPMENT_WORKFLOW.md) | Claude Code and Atlassian MCP setup, the Jira-first ticket lifecycle, the allow/ask/deny permission model, git and branch safety, CI behavior, and troubleshooting                                                    |
| [`CLAUDE.md`](CLAUDE.md)                                                        | The instructions Claude Code loads every session: commands, safety boundaries, architecture and data-model gotchas, and git policy. Useful even if you never run Claude Code — it documents the project, not the tool |
| [tRPC routers](src/server/router/README.md)                                     | Routers, per-request context, auth middleware, and how to write a procedure — read before adding or changing an endpoint                                                                                              |
| [Database layer](src/server/db/README.md)                                       | The Prisma client, schema conventions, and the migration workflow — read before touching `prisma/schema.prisma`                                                                                                       |
