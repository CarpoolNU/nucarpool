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

**One ticket, one isolated worktree slot, one fresh session, one PR, then stop.**

```
one ticket
  -> one isolated worktree SLOT
  -> one FRESH Claude session
  -> one PR
  -> STOP SESSION
```

And the distinction that makes reusable directories safe:

```
one ticket != one permanent worktree directory
```

A **slot** is a directory. It holds one ticket at a time and many tickets in sequence, so it can be reused. A **session** is a conversation, and it holds exactly one ticket ever. Recycling a directory for the next ticket is routine; continuing a conversation into the next ticket is not, because every turn re-sends the whole conversation — a second ticket in the same session pays to re-send the first one's history on every turn, and the context window fills until it has to be compacted, which costs money and loses detail from work already done.

There are two kinds of workspace, and the difference is only how long the directory lives.

#### Reusable slots

Two, by name, and no others:

```
.claude/worktrees/scrum     feature and bugfix tickets
.claude/worktrees/infra     tooling, CI, docs and repo-plumbing tickets
```

They are created once and then recycled between tickets, so each new ticket inherits `node_modules`, the generated Prisma client and the husky hooks instead of paying for them again.

First-time setup, per slot, from the primary checkout:

```bash
git fetch origin
git worktree add --no-track -b <branch> .claude/worktrees/scrum origin/main
cp .env .claude/worktrees/scrum/.env       # never a symlink; never committed
cd .claude/worktrees/scrum && ./scripts/wt-bootstrap.sh
```

Claiming a slot for a session, and releasing it afterwards, is [`git worktree lock`](#the-lock-is-the-ownership-gate):

```bash
git worktree lock --reason "<branch>" .claude/worktrees/scrum   # hands it to a session
git worktree unlock .claude/worktrees/scrum                     # takes it back
```

Between tickets, from the primary checkout, once the previous PR is merged:

```bash
git fetch origin
git worktree unlock .claude/worktrees/scrum
./scripts/wt-recycle.sh scrum <next-branch-name>
```

#### Task-specific worktrees

Still the right tool, and unchanged. Use one for:

1. `prisma/schema.prisma` or migration work, which should not share a generated client with anything;
2. a blocked or long-lived ticket, which would otherwise hold a slot hostage;
3. a third concurrent stream, when both slots are claimed;
4. detached HEAD, `git bisect`, an old commit, or a stacked or non-`main` base.

```bash
claude --worktree <task-name>   # creates the worktree, copies .env per .worktreeinclude
./scripts/wt-bootstrap.sh       # dependencies, Prisma client, husky hooks
                                # investigate, implement, validate, open the PR
                                # then end the session — it is done
```

After the human reviews and merges, retire it from the primary checkout:

```bash
git fetch origin
./scripts/wt-cleanup.sh <task-name>   # removes the worktree and the local branch
```

#### The lock is the ownership gate

There is no reliable way to detect that a session is using a directory. `lsof -a -d cwd` catches a shell sitting in one, but a Claude session holds no such handle, so **a miss is not proof a slot is free**. `git worktree lock` is the explicit claim instead: `wt-recycle.sh` refuses a locked slot outright and prints the lock reason, so recycling takes two deliberate human commands — `git worktree unlock`, then the recycle.

Claude Code already uses the same marker: a worktree it creates with `claude --worktree` is locked on its behalf, with a reason naming the session and its pid — `claude session scrum-446 (pid 56690 start ...)`. So a live session's workspace is already refused without anyone doing anything, and the lock is the mechanism the harness itself reaches for rather than a convention invented here.

A slot created by hand with `git worktree add` is **not** locked automatically, which is why handing one to a session is an explicit `git worktree lock`. Enter a slot by `cd`-ing into it and starting a session there; `claude --worktree scrum` is for creating a _new_ task worktree, not for adopting an existing slot.

That is the whole human gate, and it is deliberately the only one. There is no `--yes`, no `--force` and no environment variable that skips a check, so there is nothing to set once in a wrapper and have be permanent and invisible afterwards — the reason `seedGuard.ts` lost its `SEED_ALLOW_REMOTE`. Nothing recycles on a schedule or a hook.

**A session never recycles its own slot**, deletes its own branch, or removes its own worktree. Those are the human's, between tickets.

#### The scripts

[`wt-bootstrap.sh`](scripts/wt-bootstrap.sh) is idempotent and refuses to run on `main`, on `staging`, or in the primary checkout. It establishes idempotence by fingerprint rather than by comparing against the primary checkout: [`wt-state.sh`](scripts/wt-state.sh) records what the installed tree and the generated Prisma client were built from, inside the ignored directories themselves, and re-running compares against those stamps. The primary checkout is one branch's state among many and has no authority over what a worktree needs — comparing against it could report a client as current when it was generated from something else entirely.

[`wt-recycle.sh`](scripts/wt-recycle.sh) points a slot at a new branch. It refuses rather than guesses: the slot must be on the allowlist, be a registered linked worktree one level under `.claude/worktrees/`, not be the primary checkout or the worktree you are running from, be neither locked nor prunable, have no operation in progress, hold a branch other than `main` or `staging` that is checked out nowhere else and has every commit reachable from `origin/main`, have no modified or untracked files, have an `.env` and no `.env.production`, and have no stash entry taken from that branch. The new name must be a valid ref, unprotected, not the branch already there, and absent both locally and on the remote.

Its ordering is the part that matters: it validates, fetches, re-validates against the fresh refs, then **switches to the new branch before deleting the old one**. If the switch fails nothing has changed; if the delete fails the slot is already recycled and the old branch is still there. Either way no reachable commit is lost. It clears `.next` and `coverage` by name, because a branch switch leaves ignored files alone — never a `git clean -xdf`, which would take `node_modules` and `.env` with it.

[`wt-cleanup.sh`](scripts/wt-cleanup.sh) is the teardown half for task-specific worktrees, and it refuses on the same grounds. It never fetches, which is why the fetch above matters — a stale `origin/main` only ever makes it refuse more.

All three use the plain non-force commands, so git's own refusals are the last line of defence — none of them runs `git worktree remove --force`, `git branch -D`, `reset --hard`, `clean` or `rm -rf` over a worktree. A squash or rebase merge leaves the branch's commits off `origin/main`, so they will refuse a branch whose pull request really did merge; the refusal prints the PR state and the commits at stake and leaves the decision to you. The remote is never touched, and neither is the shared stash — `refs/stash` lives in the common git dir, so one stack is shared by every worktree, and popping would hand another worktree's work to this one.

#### What stays shared

Four things are not per-worktree. Run `yarn db:start` only from the primary checkout, because the container name and port are fixed. Only one worktree at a time can hold port 3000 for `yarn dev`. The stash stack is shared, so use `git stash push -m <tag>` and `git stash apply`, never a bare `pop`. And `yarn test:db` needs a `TEST_DATABASE_URL` naming a database no other worktree uses, since the harness truncates every table and does not lock against a concurrent run — the intended per-slot databases are `nucarpool_test_scrum` and `nucarpool_test_infra`, which do not exist yet, so until they do the two slots must not run `yarn test:db` at the same time.

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

CI runs `lint`, `tsc`, `test`, `test-db`, `build`, `env-contract`, `schema` and `format` on every pull request. `test-db` brings up its own MySQL, so the database suite is exercised whether or not you run it locally. `yarn lint` and `yarn tsc` are the two worth running before you push.

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
