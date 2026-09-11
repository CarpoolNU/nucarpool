# `scripts/`

Operational scripts, and the record of what has been run where.

Everything here is run **by hand against a real database**. Nothing in CI invokes the `.ts` scripts and nothing schedules them.

> **Before running anything, confirm what `DATABASE_URL` points at.** None of these scripts print the connection string, so none of them will tell you that you are pointed at production. Seven of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the ones that write
```

Node 22, per [`.nvmrc`](../.nvmrc). `ts-node` comes from `node_modules`, so run `yarn install` first.

**Why these are not `yarn` scripts.** They are one-shot tools meant to be [retired](#retiring-a-script) once applied everywhere. A `package.json` entry each would recreate a mess this repository has had once — seven entries pointing at long-deleted files — and the explicit `npx ts-node` keeps `--apply` visible at the call site rather than hidden behind an alias.

## Scripts that write

All are **dry-run by default**, refuse to proceed past a `--max` ceiling (default 500), and update or delete one row at a time by primary key, so a partial run leaves a consistent database. Re-running any of them is a no-op.

| Script                                                                               | What it changes                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`backfill-group-preferences.ts`](./backfill-group-preferences.ts)                   | Moves the legacy `GROUP_DETAILS_V1:` blob out of `group_message` into the three real columns |
| [`backfill-request-status.ts`](./backfill-request-status.ts)                         | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                   |
| [`backfill-profile-picture-timestamps.ts`](./backfill-profile-picture-timestamps.ts) | Records `user.profile_picture_updated_at` for every picture already in S3                    |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)                       | Deletes `Location` rows no `CarpoolSearch` points at                                         |
| [`cleanup-orphan-conversations.ts`](./cleanup-orphan-conversations.ts)               | Deletes `conversation` rows whose request is gone, **and the `message` rows in them**        |
| [`cleanup-self-requests.ts`](./cleanup-self-requests.ts)                             | Deletes `Request` rows whose two ends are the same user, and their thread                    |
| [`repair-seat-residue.ts`](./repair-seat-residue.ts)                                 | Clamps out-of-range `seats_avail` into `[0, 6]` and deletes member-less `group` rows         |

Four things to know before using any of them:

- **Two of these destroy message content, and they are not the same decision.** `cleanup-orphan-conversations` deletes words two people typed to each other that nothing can read any more — irreversible, and the privacy-respecting answer rather than a tidy-up. `cleanup-self-requests` deletes a user's own opening message to themselves. **Both print the message count per candidate before deleting; read those numbers before `--apply`.**
- **`cleanup-orphan-conversations` also takes `--limit N` and `--older-than YYYY-MM-DD`**, so a population larger than the ceiling can be retired in tranches instead of by raising `--max`. It is the only script that logs every row it deletes before deleting it.
- **`backfill-profile-picture-timestamps` is the only script that reads AWS.** It needs `s3:ListBucket`, performs no S3 writes and deletes nothing. `NEXT_PUBLIC_ENV` selects the key prefix, and pointing it at the wrong environment **lists an empty prefix and reports zero rather than failing** — so confirm that variable as well as `DATABASE_URL`. It writes `LastModified` from the listing rather than `now()`, because the column means "when the picture last changed".
- **`repair-seat-residue` needs the read-path fix deployed first.** With `hasSeatAvailable` live, a negative row is already out of matching, which makes this data hygiene rather than the fix. Its two halves are one defect's residue rather than two chores: the overwritten-membership bug cost a driver a seat and abandoned their old group in the same event, so finding one is a reason to look for the other.

Neither backfill exists as a Prisma migration on purpose: `prisma/migrations/` is never applied to PlanetScale, so a data migration would be dead text. See [the database docs](../src/server/db/README.md#changing-the-schema).

## Read-only scripts

These write nothing. Pointing them at production is safe, and several are only meaningful there — a local database holds too little data to say anything.

| Script                                                           | What it reports                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`check-self-requests.ts`](./check-self-requests.ts)             | `Request` rows whose two ends are the same user                       |
| [`check-driverless-groups.ts`](./check-driverless-groups.ts)     | `CarpoolGroup` rows with no `DRIVER` member                           |
| [`check-profile-coordinates.ts`](./check-profile-coordinates.ts) | Searches unmatchable via `(0, 0)` coordinates or reversed co-op dates |
| [`check-seat-counts.ts`](./check-seat-counts.ts)                 | `CarpoolSearch` rows with `seats_avail` outside `[0, 6]`              |
| [`measure-candidate-rows.ts`](./measure-candidate-rows.ts)       | Rows read by the explore page's candidate query                       |
| [`measure-requests-payload.ts`](./measure-requests-payload.ts)   | Rows and payload bytes for `user.requests.me`                         |
| [`measure-unread-count.ts`](./measure-unread-count.ts)           | Query plan, generated SQL and timings for the unread badge            |

The `check-*` scripts exit `0` when clean and `1` when not, so they can gate a follow-up.

**None of them has an `--apply`, and that is a decision.** For `check-driverless-groups` and `check-profile-coordinates` there is no single correct repair, and only the affected user knows which they want. For the other two the repair exists in a sibling — `repair-seat-residue.ts` and `cleanup-self-requests.ts`. Keeping `check-*` uniformly read-only is what makes every one of them safe to point at production.

`measure-unread-count.ts` is the odd one out: its useful output is the `EXPLAIN` plan, not its timings. Access types describe the shape of the work rather than its current size, so the plan is worth reading against a local database while the timings are not. For production numbers, PlanetScale Insights is the authority and needs no script.

## Not operational scripts

| File                                               | What it is                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env` and `yarn check:amplify`, and the source of the placeholder build environment |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion                                   |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends                               |

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

`wt-state.sh` exists because `node_modules` and `node_modules/.prisma/client` are generated from sources that change under them and neither records what it was built from. It stamps each with a `git hash-object --no-filters` fingerprint of its source, inside the ignored directory itself, so freshness is a fact about the artefact rather than a guess from the primary checkout. `wt-bootstrap.sh` used to compare against the primary's `schema.prisma`, which could report a client as current when it was generated from something else entirely (SCRUM-448).

`wt-recycle.test.ts` and `wt-state.test.ts` run in `yarn test` and drive the real scripts against disposable git repositories under `os.tmpdir()`, with `yarn` shadowed by a fake that records its arguments. **No test here runs against this repository or any remote.**

## Run-state record

Two different questions, and only one of them is answerable from a database:

- **"Has it been run?"** — unknowable retrospectively. Nothing recorded it before this file existed.
- **"Does it still have work to do?"** — checkable, and the question that actually matters before dropping a column or closing a ticket.

> A zero outstanding count means **"nothing left to do"**, not **"it was run"**. A script that never had candidates and a script applied successfully look identical.

| Script                                | staging            | production         | Verified   |
| ------------------------------------- | ------------------ | ------------------ | ---------- |
| `backfill-group-preferences`          | **3 outstanding**  | **12 outstanding** | 2026-09-09 |
| `backfill-request-status`             | 0 outstanding      | 0 outstanding      | 2026-09-09 |
| `backfill-profile-picture-timestamps` | **1,298 null**     | **4,322 null**     | 2026-09-09 |
| `cleanup-orphan-locations`            | 0 outstanding      | **90 outstanding** | 2026-09-09 |
| `cleanup-orphan-conversations`        | **11 outstanding** | **620 retained**   | 2026-09-09 |
| `cleanup-self-requests`               | 0 outstanding      | **2 outstanding**  | 2026-09-09 |
| `repair-seat-residue`                 | **2 outstanding**  | **3 outstanding**  | 2026-09-09 |
| `check-self-requests`                 | 0 findings         | **2 findings**     | 2026-09-09 |
| `check-driverless-groups`             | **1 finding**      | **18 findings**    | 2026-09-09 |
| `check-profile-coordinates`           | **521 findings**   | **626 findings**   | 2026-09-09 |
| `check-seat-counts`                   | **1 finding**      | 0 findings         | 2026-09-09 |

No `--apply` has been run in any shared environment. Every production figure was read as an aggregate count, never row data.

What the non-zero figures actually mean:

- **`cleanup-orphan-conversations` — production's 620 are retained by decision**, not pending. A figure _above_ 620 would mean the fix that stopped new ones regressed. See [Conversation ownership](../src/server/db/README.md#conversation-ownership).
- **`check-profile-coordinates` — only 47 of production's 626 are actionable.** Those are reversed co-op ranges. The other 579 are `(0, 0)` rows belonging to users who never finished onboarding and were never in matching; staging's 521 are all of that kind. The script reports both and exits `1` on the total, which is tracked as a separate defect.
- **`check-seat-counts` and `repair-seat-residue` see the same data from different sides.** Production's seat counts are clean (0 out of range across 4,098 rows), so its `repair-seat-residue` figure is member-less `group` rows only — the same rows `check-driverless-groups` reports as empty.
- **`backfill-profile-picture-timestamps` — a null is not a missing picture.** It means "ask S3", so the figures are the size of the un-migrated population, not a fault count. See [Profile picture presence](../src/server/db/README.md#profile-picture-presence).
- **`emailtemplate.py` — a republish is outstanding.** The SES templates in AWS are older than the repository's copy.

**Production is readable.** The PlanetScale MCP server's token returns `403` against the `main` branch, but the `pscale` CLI reader role does not — that is the route every production figure above came from, and it is read-only.

<details>
<summary>Re-checking the table without running the scripts</summary>

Each row is one read-only query, using the same conditions the scripts use, so they are safe to run against production through any SQL console.

```sql
-- backfill-group-preferences: rows still holding only legacy data
SELECT COUNT(*) FROM carpool_search
WHERE group_notes IS NULL AND group_music_preference IS NULL
  AND group_conversation_style IS NULL AND group_message IS NOT NULL;

-- backfill-request-status: PENDING requests between pairs already carpooling
SELECT COUNT(*) FROM request r
JOIN carpool_search f ON f.userId = r.fromUserId
JOIN carpool_search t ON t.userId = r.toUserId
WHERE r.status = 'PENDING'
  AND f.carpoolId IS NOT NULL AND f.carpoolId <> ''
  AND f.carpoolId = t.carpoolId;

-- cleanup-orphan-locations: Location rows nothing points at
SELECT COUNT(*) FROM location l
WHERE NOT EXISTS (
  SELECT 1 FROM carpool_search cs
  WHERE cs.homeLocationId = l.id OR cs.companyLocationId = l.id
);

-- check-self-requests and cleanup-self-requests: the same predicate
SELECT COUNT(*) FROM request WHERE fromUserId = toUserId;

-- check-driverless-groups
SELECT COUNT(*) FROM `group` g WHERE NOT EXISTS (
  SELECT 1 FROM carpool_search cs WHERE cs.carpoolId = g.id AND cs.role = 'DRIVER'
);

-- cleanup-orphan-conversations: the provably unreachable population, which
-- must fail BOTH links. A conversation a live request still reaches through
-- Request.conversationId is NOT an orphan -- requests.me still reads it.
SELECT COUNT(*) FROM conversation c
WHERE NOT EXISTS (SELECT 1 FROM request r1 WHERE r1.id = c.requestId)
  AND NOT EXISTS (SELECT 1 FROM request r2 WHERE r2.conversationId = c.id);

-- check-seat-counts and repair-seat-residue. The 6 is MAX_SEATS_AVAILABLE in
-- carpoolSeats.ts written out, because SQL cannot import it: if that constant
-- changes, these queries are what to update -- the scripts are already right.
SELECT COUNT(*) FROM carpool_search WHERE seats_avail < 0 OR seats_avail > 6;
SELECT COUNT(*) FROM `group` g WHERE NOT EXISTS (
  SELECT 1 FROM carpool_search cs WHERE cs.carpoolId = g.id
);
```

The dry run is still better where it is practical: the scripts report _which_ rows, and `backfill-group-preferences` distinguishes rows carrying preferences worth writing from rows whose blob parses to nothing.

</details>

## Updating this record

When you run one of these against a shared environment, **edit the table in the same pull request as the work, or immediately after.** A rough row beats a blank cell: record the environment, the date, what happened (`applied, N rows`, `dry run, 0 candidates`) and who ran it. A dry run that reported zero is still worth recording — it is the evidence the next person needs.

## Retiring a script

A one-shot script should not live here forever. Retire it when **all** of these hold:

1. Its dry run reports zero candidates in **every** shared environment, recorded above.
2. The code path that made the bad data possible is fixed and deployed, so the population cannot grow again.
3. Any fallback existing only to tolerate un-migrated rows is removed, or is being removed in the same change.

Then delete the script, its test and its row, and say in the commit message which environments were verified and when.

`backfill-group-preferences.ts` is the worked example: retiring it means removing the script, the legacy columns and `resolveGroupDetails`'s fallback together — and it cannot proceed until point 1 holds, which today it does not.

Read-only `check-*` and `measure-*` scripts are cheaper to keep than to re-derive. Retire those only when the thing they measure is gone.

## See also

- [Database layer](../src/server/db/README.md) — schema, migrations, and why backfills are scripts rather than migrations
- [README](../README.md) — setup, environment variables, dangerous commands
