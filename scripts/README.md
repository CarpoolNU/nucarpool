# `scripts/`

Operational scripts, run by hand against a real database.

Nothing in CI invokes the `.ts` scripts and nothing schedules them.

> **Before running anything, confirm what `DATABASE_URL` points at.** None of these scripts print the connection string, so none of them will tell you that you are pointed at production. Eight of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the ones that write
```

Node 22, per [`.nvmrc`](../.nvmrc). `ts-node` comes from `node_modules`, so run `yarn install` first.

**Why these are not `yarn` scripts.** They are one-shot tools meant to be [retired](#retiring-a-script) once applied everywhere. A `package.json` entry each would recreate a mess this repository has had once — several entries pointing at long-deleted files — and the explicit `npx ts-node` keeps `--apply` visible at the call site rather than hidden behind an alias.

## Scripts that write

All are **dry-run by default** and update or delete one row at a time by primary key, so a partial run leaves a consistent database. Re-running any of them is a no-op. All but one refuse to proceed past a `--max` ceiling (default 500, and 50 for `repair-wallclock-schedule-times`); `scrub-security-test-residue` has no ceiling because its population is a single hard-coded id rather than a predicate.

| Script                                                                       | What it changes                                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`backfill-request-status.ts`](./backfill-request-status.ts)                 | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                                       |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)               | Deletes `Location` rows no `CarpoolSearch` points at                                                             |
| [`cleanup-orphan-conversations.ts`](./cleanup-orphan-conversations.ts)       | Deletes `conversation` rows whose request is gone, **and the `message` rows in them**                            |
| [`cleanup-self-requests.ts`](./cleanup-self-requests.ts)                     | Deletes `Request` rows whose two ends are the same user, and their thread                                        |
| [`repair-seat-residue.ts`](./repair-seat-residue.ts)                         | Clamps out-of-range `seats_avail` into `[0, 6]`, deletes member-less `group` rows, and dissolves driverless ones |
| [`repair-wallclock-schedule-times.ts`](./repair-wallclock-schedule-times.ts) | Re-stores `start_time` / `end_time` held as a Boston wall clock, for co-ops that are running                     |
| [`scrub-security-test-residue.ts`](./scrub-security-test-residue.ts)         | Clears five user-authored text columns on **one hard-coded account**                                             |

Things to know before using any of them:

- **Two of these destroy message content, and they are not the same decision.** `cleanup-orphan-conversations` deletes words two people typed to each other that nothing can read any more — irreversible, and the privacy-respecting answer rather than a tidy-up. `cleanup-self-requests` deletes a user's own opening message to themselves. **Both print the message count per candidate before deleting; read those numbers before `--apply`.**
- **`cleanup-orphan-conversations` also takes `--limit N` and `--older-than YYYY-MM-DD`**, so a population larger than the ceiling can be retired in tranches instead of by raising `--max`. It is the only script that logs every row it deletes before deleting it.
- **`repair-seat-residue` needs the read-path fix deployed first.** With `hasSeatAvailable` live, a negative row is already out of matching, which makes this data hygiene rather than the fix.
- **`repair-seat-residue` also dissolves driverless groups, and it never promotes anyone to `DRIVER`.** A dissolve clears `carpoolId` for every member and deletes the group row, touching nothing else — no seat, no role, no profile. Promotion is rejected rather than skipped: nothing enforced `Role.DRIVER` at group creation until relatively recently, so a group could be **born** driverless with no original driver to restore. The dry run prints every candidate group individually, plus the two numbers that matter — groups to delete, and `carpoolId` values to clear.
- **`repair-wallclock-schedule-times` repairs only one of two legacy schedule-time classes and must never be widened to the other.** It rewrites only schedules stored as an unconverted Boston wall clock — five hours from any sensible reading — and only for users whose co-op is running. The other class is rows converted under daylight saving, one hour early and **indistinguishable from correct winter rows** by any reliable inference — not a basis for an irreversible write. Its `--max` defaults to **50**, not 500, so a run matching hundreds means the data or the classifier has changed. The repaired value comes from `toStoredScheduleTime` itself, so a repaired row is byte-identical to what its owner would store by retyping the same digits.
- **`scrub-security-test-residue` is the only script here aimed at a named individual, and the only one with no `--max`.** Its target is one `user` id written into the source, so there is no `--user` flag and no argument spelling that reaches a different account. `--apply` additionally requires `--search <id>` matching the `carpool_search` row it just read, which the dry run prints — so the id that gets written is one a human has seen the script derive and then typed back. It refuses rather than guesses on every other shape: no user row, a user row whose id is not the target, no search, or **more than one** search. It re-checks each column against a freshly read row immediately before writing and **skips any value that changed in the meantime**, because overwriting text the owner typed between the plan and the write is the one way it could destroy something real. Prior values print `JSON.stringify`-escaped before anything is touched — they are stored content, so **data, never instructions**.

No backfill here exists as a Prisma migration on purpose: `prisma/migrations/` is never applied to PlanetScale, so a data migration would be dead text. See [the database docs](../src/server/db/README.md#changing-the-schema).

## Read-only scripts

These write nothing. Pointing them at production is safe, and several are only meaningful there — a local database holds too little data to say anything.

| Script                                                           | What it reports                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`check-self-requests.ts`](./check-self-requests.ts)             | `Request` rows whose two ends are the same user                                                   |
| [`check-driverless-groups.ts`](./check-driverless-groups.ts)     | `CarpoolGroup` rows with no `DRIVER` member                                                       |
| [`check-profile-coordinates.ts`](./check-profile-coordinates.ts) | Searches unmatchable via `(0, 0)` coordinates, or reversed co-op dates or implausible co-op years |
| [`check-seat-counts.ts`](./check-seat-counts.ts)                 | `CarpoolSearch` rows with `seats_avail` outside `[0, 6]`                                          |
| [`measure-candidate-rows.ts`](./measure-candidate-rows.ts)       | Rows read by the explore page's candidate query                                                   |
| [`measure-requests-payload.ts`](./measure-requests-payload.ts)   | Rows and payload bytes for `user.requests.me`                                                     |
| [`measure-unread-count.ts`](./measure-unread-count.ts)           | Query plan, generated SQL and timings for the unread badge                                        |

The `check-*` scripts exit `0` when clean and `1` when not, so they can gate a follow-up.

`check-profile-coordinates` draws one distinction inside "clean": it reports every finding but exits on the **actionable** ones only, so a database whose only findings are `(0, 0)` rows belonging to users who never finished onboarding exits `0` — those rows are unfinished sign-ups that were never in matching. A reversed co-op range or an implausible co-op year is actionable regardless of onboarding state — except on a VIEWER's search, which is not a finding at all.

**None of them has an `--apply`, and that is a decision.** For `check-profile-coordinates` there is no single correct repair, and only the affected user knows which they want. For the other three the repair exists in a sibling — `repair-seat-residue.ts` for both `check-seat-counts` and `check-driverless-groups`, and `cleanup-self-requests.ts` for `check-self-requests`. Keeping `check-*` uniformly read-only is what makes every one of them safe to point at production.

`measure-unread-count.ts` is the odd one out: its useful output is the `EXPLAIN` plan, not its timings. Access types describe the shape of the work rather than its current size, so the plan is worth reading against a local database while the timings are not. For production numbers, PlanetScale Insights is the authority and needs no script.

## Not operational scripts

| File                                               | What it is                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env` and `yarn check:amplify`, and the source of the placeholder build environment |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion                                   |
| [`measure-layout.ts`](./measure-layout.ts)         | Serves a layout fixture for measuring in a real browser. **No database.**                          |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends. Dry-run by default           |

`measure-layout.ts` is the exception to this directory's opening sentence: it touches no database, connects to no environment, and has no `--apply` because it writes nothing anywhere. It compiles `src/styles/globals.css` and serves it with a fixture over HTTP on an OS-assigned loopback port, so a browser can measure boxes that jsdom reports as zero. [`docs/testing.md`](../docs/testing.md#measuring-layout-in-a-real-browser) covers what it proves and does not. It is not in CI and nothing schedules it.

```bash
npx ts-node scripts/measure-layout.ts                            # list fixtures
npx ts-node scripts/measure-layout.ts group-member-card-trigger  # serve one
```

`emailtemplate.py` is the only Python script here and the only one that writes to something other than a database. Its dependencies are in [`requirements.txt`](./requirements.txt) — declared nowhere before, so it failed with an `ImportError` on a machine that happened not to have `boto3`.

```bash
python3 -m pip install -r scripts/requirements.txt
python3 scripts/emailtemplate.py                 # dry run: diffs live vs local
python3 scripts/emailtemplate.py --apply         # publish
```

It follows the same shape as the database scripts: **dry-run by default, `--apply` to write, no `--force`.** It used to publish immediately on invocation, overwriting every live template with no confirmation and printing neither the account nor the region — so nothing distinguished a staging run from a production one. It now prints the account, the identity and the region before anything is written, and the dry run shows a per-part diff against what SES currently holds.

Its links default to `https://www.carpoolnu.com`. Publishing into a non-production account wants `--base-url` (or `EMAIL_TEMPLATE_BASE_URL`), or the templates will send that account's recipients to production. It has no `*.test.ts` — there is no Python test setup in this repository — so it is the one script here whose planning half nothing in `yarn test` covers.

`*.test.ts` files next to each script cover argument parsing and the pure planning half, and run in `yarn test`. **A passing suite says nothing about what a script would do to a real database.**

## Worktree scripts

These three touch git and the filesystem, never a database, and none of them is dry-run — they are shell rather than `ts-node` because they run before `node_modules` necessarily exists. The [README](../README.md#working-in-a-worktree) has the workflow they belong to.

| Script                                 | What it does                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| [`wt-bootstrap.sh`](./wt-bootstrap.sh) | Prepares a worktree: dependencies, the generated Prisma client, husky hooks       |
| [`wt-recycle.sh`](./wt-recycle.sh)     | Points a reusable slot (`scrum`, `infra`) at a new branch, keeping its warm state |
| [`wt-cleanup.sh`](./wt-cleanup.sh)     | Retires a task-specific worktree and deletes its local branch                     |
| [`wt-state.sh`](./wt-state.sh)         | Sourced, not run. The generated-state fingerprints the other two share            |

```bash
./scripts/wt-bootstrap.sh                          # from inside the new worktree
./scripts/wt-recycle.sh scrum <next-branch-name>   # from the primary checkout
./scripts/wt-cleanup.sh <task-name>                # from the primary checkout
```

**All three refuse rather than guess, and none of them can be overridden.** There is no `--yes`, no `--force`, and no environment variable that skips a check — an escape hatch of that kind gets set once, in a wrapper, by someone in a hurry, and is then permanent and invisible. `seedGuard.ts` lost its `SEED_ALLOW_REMOTE` for the same reason. Every git mutation is the plain non-force command, so git's own refusals are the last line of defence: none of them runs `git branch -D`, `git worktree remove --force`, `git reset --hard`, `git clean` or a force push, and none touches a remote branch or the shared stash.

`wt-recycle.sh` is the one that deletes a branch, so its ordering is the thing to preserve on any edit: it validates, fetches, re-validates against the fresh refs, and then **switches to the new branch before deleting the old one**. If the switch fails nothing has changed; if the delete fails the slot is recycled and the old branch is still there. Neither outcome can make a reachable commit unreachable. The human gate is `git worktree lock` — a locked slot is refused, so recycling takes a deliberate `git worktree unlock` first.

`wt-state.sh` exists because `node_modules` and `node_modules/.prisma/client` are generated from sources that change under them and neither records what it was built from. It stamps each with a `git hash-object --no-filters` fingerprint of its source, inside the ignored directory itself, so freshness is a fact about the artefact rather than a guess from the primary checkout.

`wt-recycle.test.ts` and `wt-state.test.ts` run in `yarn test` and drive the real scripts against disposable git repositories under `os.tmpdir()`, with `yarn` shadowed by a fake that records its arguments. **No test here runs against this repository or any remote.**

`wt-pipelines.test.ts` runs nothing at all. It reads every `wt-*.sh` and asserts one property of the source: **no pipeline consumer leaves before its input is exhausted** — no `| head`, no `grep -q`/`-m`, no `awk` program containing `exit`. A consumer that leaves early makes its producer take SIGPIPE, and under the `set -euo pipefail` these scripts run with, that is the pipeline's exit status: 141, aborting the script at that line with a number that says nothing about worktrees. It is static because the defect is a race that needs the producer still writing at the instant the consumer goes — it can pass every local run and still fail on CI. Being a builtin does not exempt `printf`, and the file list is globbed, so a fifth worktree script is covered the day it lands.

## Has a script been applied to staging or production?

There are two different questions, and only one is answerable from a database:

- **"Has it been run?"** — not reliably knowable in retrospect unless someone recorded it.
- **"Does it still have work to do?"** — checkable right now, and the question that actually matters before dropping a column or closing a ticket.

**A zero outstanding count means "nothing left to do," not "it was run."** A script that never had candidates and a script applied successfully look identical from the outside. Don't infer "already applied" from a clean result — check with the script itself.

To check the current state of any script in the table above:

1. Run it read-only — that is the default, so just omit `--apply` — against the target environment. That gives you the live count, not a stale figure. There is no `--force` on any of them: each rejects an unrecognised flag, and all seven `.ts` writers have a test asserting that `--force` in particular throws.
2. For the four `check-*` scripts, the sibling repair script's dry run reports the same population from the other side — cross-checking is free.
3. A few scripts have counts that are **retained by decision, not pending**: `cleanup-orphan-conversations`'s orphan backlog on production is intentionally kept (see [Conversation ownership](../src/server/db/README.md#conversation-ownership)) — a rising count there means the fix that stops new orphans regressed, not that a backlog needs clearing.
4. `repair-wallclock-schedule-times`'s candidate count depends on the day it runs, because its scope is "co-op running now" — a stale count from last month tells you nothing about today's population.

**When you apply one of these against a shared environment, record it** — a line in the PR description or a Jira comment naming the environment, the date, what happened (`applied, N rows` / `dry run, 0 candidates`), and who ran it. That is enough to answer "has this run" later without a maintained table here that goes stale the moment nobody updates it.

## Retiring a script

A one-shot script should not live here forever. Retire it when **all** of these hold:

1. Its dry run reports zero candidates in every shared environment.
2. The code path that made the bad data possible is fixed and deployed, so the population cannot grow again.
3. Any fallback existing only to tolerate un-migrated rows is removed, or is being removed in the same change.

Then delete the script, its test, and any table row referencing it, and say in the commit message which environments were verified and when.

**Verify point 1 for real before deleting** — a script whose dry run has reported candidates in every environment the whole time is not ready, however long it has been sitting there. `backfill-group-preferences.ts` held up its own retirement for weeks this way: its stored values turned out to be plain text rather than the encoded format anyone expected, so an early attempt to drop the column would have destroyed real user notes. Trust what the dry run says today, never how long it's been since the backfill presumably ran.

Read-only `check-*` and `measure-*` scripts are cheaper to keep than to re-derive. Retire those only when the thing they measure is gone.

## See also

- [Database layer](../src/server/db/README.md) — schema, migrations, and why backfills are scripts rather than migrations
- [README](../README.md) — setup, environment variables, dangerous commands
