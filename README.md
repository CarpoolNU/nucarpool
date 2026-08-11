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

Create a `.env` in the repository root containing the variables below. There is no `.env.example` — ask a maintainer for development credentials. The app validates these at startup and will not boot if one is missing.

Then start the database, set up the schema, and run the app:

```bash
yarn db:start     # local MySQL in Docker
yarn db:schema    # prisma migrate dev && prisma generate
yarn seed         # optional: populate with generated users
yarn dev
```

The app runs at <http://localhost:3000>. `yarn startup` runs `yarn db:start` and `yarn dev` together.

## Environment Variables

Placeholders only — never commit real values. `.env` is gitignored.

```env
# Database — MYSQL_* are read by docker-compose; the app itself only uses DATABASE_URL,
# so its user, password, port, and database name must match the container.
DATABASE_URL="mysql://<user>:<password>@localhost:<MYSQL_PORT>/<MYSQL_DATABASE>"
MYSQL_PORT="<host-port>"
MYSQL_ROOT_PASSWORD="<local-only-password>"
MYSQL_DATABASE="<database-name>"

# Authentication
NEXTAUTH_SECRET="<random-secret>"
NEXTAUTH_URL="http://localhost:3000"
AZURE_CLIENT_ID="<azure-client-id>"
AZURE_CLIENT_SECRET="<azure-client-secret>"
AZURE_TENANT_ID="<azure-tenant-id>"
GOOGLE_CLIENT_ID="<google-client-id>"
GOOGLE_CLIENT_SECRET="<google-client-secret>"

# AWS (SES + S3) — note the suffixed names; standard AWS_* names will fail validation
ACCESS_KEY_ID_AWS="<aws-access-key-id>"
SECRET_ACCESS_KEY_AWS="<aws-secret-access-key>"
REGION_AWS="<aws-region>"

# Mapbox
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN="<mapbox-public-token>"

# Pusher
NEXT_PUBLIC_PUSHER_KEY="<pusher-key>"
NEXT_PUBLIC_PUSHER_CLUSTER="<pusher-cluster>"
PUSHER_APP_ID="<pusher-app-id>"
PUSHER_SECRET="<pusher-secret>"

# Mixpanel — any non-empty value works locally
NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN="<mixpanel-token>"

# Optional — "staging" enables Google sign-in and namespaces S3 uploads
NEXT_PUBLIC_ENV="<environment-name>"
```

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

This project is developed with Claude Code following a Jira-first workflow. Read the workflow guide before your first contribution — it covers conventions this README does not. The layer docs are worth reading before you edit the layer they describe.

| Document                                                                        | Covers                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Claude Code development workflow](docs/development/AI_DEVELOPMENT_WORKFLOW.md) | Claude Code and Atlassian MCP setup, the Jira-first ticket lifecycle, the allow/ask/deny permission model, git and branch safety, CI behavior, and troubleshooting                                                    |
| [`CLAUDE.md`](CLAUDE.md)                                                        | The instructions Claude Code loads every session: commands, safety boundaries, architecture and data-model gotchas, and git policy. Useful even if you never run Claude Code — it documents the project, not the tool |
| [tRPC routers](src/server/router/README.md)                                     | Routers, per-request context, auth middleware, and how to write a procedure — read before adding or changing an endpoint                                                                                              |
| [Database layer](src/server/db/README.md)                                       | The Prisma client, schema conventions, and the migration workflow — read before touching `prisma/schema.prisma`                                                                                                       |
