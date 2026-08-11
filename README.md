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

Requires Node 20, Yarn 1.x, and Docker.

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
yarn db:start     # local MySQL in Docker
yarn db:schema    # prisma migrate dev && prisma generate
yarn seed         # optional: populate with generated users
yarn dev
```

The app runs at <http://localhost:3000>. `yarn startup` runs `yarn db:start` and `yarn dev` together.

## Environment Variables

[`.env.example`](.env.example) is the authoritative list. It documents every variable, grouped by service, with placeholder values and notes on which are optional. Copy it to `.env` and fill in real values — never commit them, and keep placeholders only in `.env.example` itself. `.env` is gitignored.

Four things that commonly trip people up:

- **AWS keys use suffixed names** — `ACCESS_KEY_ID_AWS`, `SECRET_ACCESS_KEY_AWS`, `REGION_AWS`. The standard `AWS_*` names fail validation.
- **`MYSQL_*` are read only by Docker Compose**, to provision the container. The app reads `DATABASE_URL`, so the user, password, port, and database name inside it must match the container's.
- **`NEXT_PUBLIC_*` variables are inlined into the client bundle** at build time and are therefore public. Everything else is server-only.
- **`GOOGLE_*` are required even locally.** The Google sign-in button only appears when `NEXT_PUBLIC_ENV=staging`, but the variables are validated in every environment.

Validation runs at import time in [`src/utils/env/browser.ts`](src/utils/env/browser.ts) and [`src/utils/env/server.ts`](src/utils/env/server.ts), which is why a missing variable stops the app from starting rather than failing later.

## Useful Commands

| Command                          | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `yarn dev`                       | Start the development server on port 3000         |
| `yarn startup`                   | Start the local database, then the dev server     |
| `yarn build`                     | Production build                                  |
| `yarn lint`                      | Run ESLint                                        |
| `yarn tsc`                       | Type check                                        |
| `yarn test`                      | Run Jest (no test files exist yet)                |
| `yarn db:start` / `yarn db:stop` | Start / stop the local MySQL container            |
| `yarn db:schema`                 | Apply migrations and regenerate the Prisma client |
| `yarn seed`                      | Populate the database with generated users        |

## Documentation

This project is developed with a Jira workflow. Read the workflow guide before your first contribution — it covers conventions this README does not. The layer docs are worth reading before you edit the layer they describe.

| Document                                                                        | Covers                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code development workflow](docs/development/AI_DEVELOPMENT_WORKFLOW.md) | Claude Code and Atlassian MCP setup, the Jira-first ticket lifecycle, the allow/ask/deny permission model, git and branch safety, CI behavior, and troubleshooting                                                    |
| [`CLAUDE.md`](CLAUDE.md)                                                        | The instructions Claude Code loads every session: commands, safety boundaries, architecture and data-model gotchas, and git policy. Useful even if you never run Claude Code — it documents the project, not the tool |
| [tRPC routers](src/server/router/README.md)                                     | Routers, per-request context, auth middleware, and how to write a procedure — read before adding or changing an endpoint                                                                                              |
| [Database layer](src/server/db/README.md)                                       | The Prisma client, schema conventions, and the migration workflow — read before touching `prisma/schema.prisma`                                                                                                       |
