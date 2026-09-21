# `scripts/`

Operational scripts, and the record of what has been run where.

Everything here is run **by hand against a real database**. Nothing in CI invokes the `.ts` scripts and nothing schedules them.

> **Before running anything, confirm what `DATABASE_URL` points at.** None of these scripts print the connection string, so none of them will tell you that you are pointed at production. Six of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the ones that write
```

Node 22, per [`.nvmrc`](../.nvmrc). `ts-node` comes from `node_modules`, so run `yarn install` first.

**Why these are not `yarn` scripts.** They are one-shot tools meant to be [retired](#retiring-a-script) once applied everywhere. A `package.json` entry each would recreate a mess this repository has had once — seven entries pointing at long-deleted files — and the explicit `npx ts-node` keeps `--apply` visible at the call site rather than hidden behind an alias.

## Scripts that write

All are **dry-run by default**, refuse to proceed past a `--max` ceiling (default 500, and 50 for `repair-wallclock-schedule-times`), and update or delete one row at a time by primary key, so a partial run leaves a consistent database. Re-running any of them is a no-op.

| Script                                                                               | What it changes                                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`backfill-request-status.ts`](./backfill-request-status.ts)                         | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                                       |
| [`backfill-profile-picture-timestamps.ts`](./backfill-profile-picture-timestamps.ts) | Records `user.profile_picture_updated_at` for every picture already in S3                                        |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)                       | Deletes `Location` rows no `CarpoolSearch` points at                                                             |
| [`cleanup-orphan-conversations.ts`](./cleanup-orphan-conversations.ts)               | Deletes `conversation` rows whose request is gone, **and the `message` rows in them**                            |
| [`cleanup-self-requests.ts`](./cleanup-self-requests.ts)                             | Deletes `Request` rows whose two ends are the same user, and their thread                                        |
| [`repair-seat-residue.ts`](./repair-seat-residue.ts)                                 | Clamps out-of-range `seats_avail` into `[0, 6]`, deletes member-less `group` rows, and dissolves driverless ones |
| [`repair-wallclock-schedule-times.ts`](./repair-wallclock-schedule-times.ts)         | Re-stores `start_time` / `end_time` held as a Boston wall clock, for co-ops that are running                     |

Five things to know before using any of them:

- **Two of these destroy message content, and they are not the same decision.** `cleanup-orphan-conversations` deletes words two people typed to each other that nothing can read any more — irreversible, and the privacy-respecting answer rather than a tidy-up. `cleanup-self-requests` deletes a user's own opening message to themselves. **Both print the message count per candidate before deleting; read those numbers before `--apply`.**
- **`cleanup-orphan-conversations` also takes `--limit N` and `--older-than YYYY-MM-DD`**, so a population larger than the ceiling can be retired in tranches instead of by raising `--max`. It is the only script that logs every row it deletes before deleting it.
- **`backfill-profile-picture-timestamps` is the only script that reads AWS.** It needs `s3:ListBucket`, performs no S3 writes and deletes nothing. `NEXT_PUBLIC_ENV` selects the key prefix, and pointing it at the wrong environment **lists an empty prefix and reports zero rather than failing** — so confirm that variable as well as `DATABASE_URL`. It writes `LastModified` from the listing rather than `now()`, because the column means "when the picture last changed".
- **`repair-seat-residue` needs the read-path fix deployed first.** With `hasSeatAvailable` live, a negative row is already out of matching, which makes this data hygiene rather than the fix. Its first two halves are one defect's residue rather than two chores: the overwritten-membership bug cost a driver a seat and abandoned their old group in the same event, so finding one is a reason to look for the other.
- **`repair-seat-residue` also dissolves driverless groups, and it never promotes anyone to `DRIVER`.** A dissolve clears `carpoolId` for every member and deletes the group row, touching nothing else — no seat, no role, no profile. Promotion was rejected rather than skipped: `groups.create` did not enforce `Role.DRIVER` until SCRUM-291, and the client named whichever party did not accept the request as the driver without checking, so a group could be **born** driverless and there may be no original driver to restore (SCRUM-406). The dry run prints every candidate group individually, plus the two numbers that matter — groups to delete, and `carpoolId` values to clear.
- **`repair-wallclock-schedule-times` repairs one of SCRUM-376's two legacy classes and must never be widened to the other.** It rewrites only schedules stored as an unconverted Boston wall clock — five hours from any sensible reading — and only for users whose co-op is running. The other class is rows converted under daylight saving, which are one hour early and **cannot be told apart from correct winter rows**; the best inference measured is about 82% per row, which is not a basis for an irreversible write. Its `--max` defaults to **50**, not 500, because production held eight candidates on 2026-09-21 and a run matching hundreds would mean the data or the classifier has changed. The repaired value comes from `toStoredScheduleTime` itself, so a repaired row is byte-identical to what its owner would store by retyping the same digits.

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

`check-profile-coordinates` draws one distinction inside "clean", because without it the gate was permanently red (SCRUM-408). It reports every finding but exits on the **actionable** ones only, so a database whose only findings are `(0, 0)` rows belonging to users who never finished onboarding exits `0` — those rows are unfinished sign-ups that were never in matching. A reversed co-op range is actionable whatever the user's onboarding state and whatever the search's `status`.

**None of them has an `--apply`, and that is a decision.** For `check-profile-coordinates` there is no single correct repair, and only the affected user knows which they want. For the other three the repair exists in a sibling — `repair-seat-residue.ts` for both `check-seat-counts` and `check-driverless-groups`, and `cleanup-self-requests.ts` for `check-self-requests`. Keeping `check-*` uniformly read-only is what makes every one of them safe to point at production.

`check-driverless-groups` was the standing exception to that until SCRUM-406: its header said the repair could not be automated because "only the affected users know which one they want". That reasoning held only while promoting a member was on the table. Once promotion was rejected outright — there may be no original driver to restore — dissolving is the single correct repair, and it lives in `repair-seat-residue.ts`.

`measure-unread-count.ts` is the odd one out: its useful output is the `EXPLAIN` plan, not its timings. Access types describe the shape of the work rather than its current size, so the plan is worth reading against a local database while the timings are not. For production numbers, PlanetScale Insights is the authority and needs no script.

## Not operational scripts

| File                                               | What it is                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env` and `yarn check:amplify`, and the source of the placeholder build environment |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion                                   |
| [`measure-layout.ts`](./measure-layout.ts)         | Serves a layout fixture for measuring in a real browser. **No database.**                          |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends                               |

`measure-layout.ts` is the exception to this directory's opening sentence: it touches no database, connects to no environment, and has no `--apply` because it writes nothing anywhere. It compiles `src/styles/globals.css` and serves it with a fixture over HTTP on an OS-assigned loopback port, so a browser can measure boxes that jsdom reports as zero. [`docs/testing.md`](../docs/testing.md#measuring-layout-in-a-real-browser) covers what it proves, what it does not, and the four sharp edges it encodes. It is not in CI and nothing schedules it.

```bash
npx ts-node scripts/measure-layout.ts                            # list fixtures
npx ts-node scripts/measure-layout.ts group-member-card-trigger  # serve one
```

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

`wt-pipelines.test.ts` runs nothing at all. It reads every `wt-*.sh` and asserts one property of the source: **no pipeline consumer leaves before its input is exhausted** — no `| head`, no `grep -q`/`-m`, no `awk` program containing `exit`. A consumer that leaves early makes its producer take SIGPIPE, and under the `set -euo pipefail` these scripts run with, that is the pipeline's exit status: 141, aborting the script at that line with a number that says nothing about worktrees. It is static because the defect is a race — it needs the producer still writing at the instant the consumer goes, so it passed every local run and failed on CI (SCRUM-449, then SCRUM-454 for the same shape in `wt-bootstrap.sh` and `wt-cleanup.sh`). Being a builtin does not exempt `printf`, and the file list is globbed, so a fifth worktree script is covered the day it lands.

## Run-state record

Two different questions, and only one of them is answerable from a database:

- **"Has it been run?"** — unknowable retrospectively. Nothing recorded it before this file existed.
- **"Does it still have work to do?"** — checkable, and the question that actually matters before dropping a column or closing a ticket.

> A zero outstanding count means **"nothing left to do"**, not **"it was run"**. A script that never had candidates and a script applied successfully look identical.

| Script                                | staging            | production         | Verified   |
| ------------------------------------- | ------------------ | ------------------ | ---------- |
| `backfill-request-status`             | 0 outstanding      | 0 outstanding      | 2026-09-09 |
| `backfill-profile-picture-timestamps` | **1,298 null**     | **4,322 null**     | 2026-09-09 |
| `cleanup-orphan-locations`            | 0 outstanding      | **90 outstanding** | 2026-09-09 |
| `cleanup-orphan-conversations`        | **11 outstanding** | **620 retained**   | 2026-09-09 |
| `cleanup-self-requests`               | 0 outstanding      | **2 outstanding**  | 2026-09-09 |
| `repair-seat-residue`                 | 0 outstanding      | 0 outstanding      | 2026-09-16 |
| `repair-wallclock-schedule-times`     | 0 outstanding      | **8 outstanding**  | 2026-09-21 |
| `check-self-requests`                 | 0 findings         | **2 findings**     | 2026-09-09 |
| `check-driverless-groups`             | 0 findings         | 0 findings         | 2026-09-16 |
| `check-profile-coordinates`           | **521 findings**   | **626 findings**   | 2026-09-09 |
| `check-seat-counts`                   | 0 findings         | 0 findings         | 2026-09-16 |

Two `--apply` runs have been made in a shared environment, both on 2026-09-16:

- **`backfill-group-preferences`** — staging (3 rows) and production (11). Its row is gone from the table because the script was retired in the same change: SCRUM-287 dropped the columns it read.
- **`repair-seat-residue`** — staging and production, immediately after [#369](https://github.com/CarpoolNU/nucarpool/pull/369) merged (SCRUM-406). **Production: dissolved 15 driverless groups, clearing 33 `carpoolId` associations, and deleted 3 empty group rows** — 18 group rows in total, taking `group` from 67 to 49. **Staging: deleted 1 empty group row and clamped 1 out-of-range seat count**, taking `group` from 11 to 10; it had no driverless group to dissolve. Both environments then reported clean: `check-driverless-groups` exits `0`, and a second `repair-seat-residue` says "nothing to repair".

  Verified read-only afterwards against production, aggregates only: `carpool_search` rows carrying a `carpoolId` fell from 159 to 126 — exactly the 33 cleared — with **0** rows pointing at a `group` row that no longer exists, **0** seat counts out of range, and **0** solo groups. `carpool_search` and `user` row counts were not reduced, so no search, profile or account was deleted: the dissolve wrote `carpoolId` and nothing else, and promoted nobody.

Nothing else has been applied anywhere. Every production figure was read as an aggregate count, never row data.

`repair-wallclock-schedule-times` **has not been run in any environment**, including as a dry run — its figures above were measured with the equivalent SQL predicate, read-only, and cross-checked by running the classifier itself over the production distribution reconstructed from aggregated `(start_time, end_time, start_date, end_date, count)` tuples. Both agree on eight rows. Staging's zero is not a clean bill of health: no staging co-op is running today, so the predicate selects nothing there whatever the times hold.

Its candidate count depends on the day it runs, because the scope is "co-op running now". Over the production data as it stands: 4 in January 2026, 8 today, 1 by December. A 2025-03-15 run would have matched 109 — which is exactly the case the `--max 50` ceiling exists to stop.

What the non-zero figures actually mean:

- **`cleanup-orphan-conversations` — production's 620 are retained by decision**, not pending. A figure _above_ 620 would mean the fix that stopped new ones regressed. See [Conversation ownership](../src/server/db/README.md#conversation-ownership).
- **`check-profile-coordinates` — only 47 of production's 626 are actionable.** Those are reversed co-op ranges. The other 579 are `(0, 0)` rows belonging to users who never finished onboarding and were never in matching; staging's 521 are all of that kind. The script reports both and exits `1` on the actionable set only, so production exits `1` on the 47 and staging exits `0` (SCRUM-408). **Both cells above are the total each run reports**, which is the figure to compare a later run against; the actionable count is the second number the run prints.
- **`check-seat-counts` and `repair-seat-residue` see the same data from different sides**, so they reach zero together, as they did on 2026-09-16.
- **`backfill-profile-picture-timestamps` — a null is not a missing picture.** It means "ask S3", so the figures are the size of the un-migrated population, not a fault count. See [Profile picture presence](../src/server/db/README.md#profile-picture-presence).
- **`emailtemplate.py` — a republish is outstanding.** The SES templates in AWS are older than the repository's copy.

### What the driverless repair cleared, 2026-09-16

Kept because a zero cell records that there is nothing left to do, not what was there — and because the shape of this population is the reason the repair dissolves rather than promotes.

Production held **15 driverless groups containing 33 members**: 14 groups of two and one of five; 25 `RIDER` and 8 `VIEWER`, 32 `ACTIVE` and 1 `INACTIVE`. All 33 seat values were in `[0, 2]` and none negative, so the dissolve needed no seat arithmetic. On activity, 30 of the 33 had a co-op end date already past, 2 had none, and exactly one group held a member whose co-op was still running — dissolved with the rest by decision, since both its members were `RIDER`s and no car was being broken up.

Staging held **none of them**, only a single empty group, which is why every figure taken from staging understated this for as long as it was the only environment being measured.

The groups were created between **2024-10-21 and 2026-01-11** — all before `groups.create` began enforcing `Role.DRIVER` in SCRUM-291 (2026-08-27), and before `Role.DRIVER` appeared in that router at all (SCRUM-220, 2026-08-21). `initiateGroup` named whichever party did not accept the request as the group's driver without checking their role, and the server took that id on trust, so **a group could be born driverless with no original driver to restore.** That is why nobody was promoted: promotion would have invented a driver who never existed. Per-group attribution was not achievable either — role history is not stored, and the profile form zeroes `seatsAvail` for any non-`DRIVER` on save, so an ex-driver and a never-driver are indistinguishable.

**Production is readable.** The PlanetScale MCP server's token returns `403` against the `main` branch, but the `pscale` CLI reader role does not — that is the route every production figure above came from, and it is read-only.

<details>
<summary>Re-checking the table without running the scripts</summary>

Nine of the table's ten rows are one read-only query below, using the same conditions the scripts use, so they are safe to run against production through any SQL console. `backfill-profile-picture-timestamps` has none — see the note after the block, which explains why.

```sql
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

-- check-profile-coordinates: findings vs. the actionable subset the script's
-- exit code is keyed to (SCRUM-408). COALESCE(u.is_onboarded, 1) matches the
-- script's rule that a dangling emulated foreign key counts as onboarded, so
-- a search with no user row lands in `actionable` rather than being excused.
SELECT
  COUNT(*) AS findings,
  SUM(missing_location OR out_of_range OR reversed_range OR (unresolved AND onboarded)) AS actionable,
  SUM(NOT (missing_location OR out_of_range OR reversed_range OR (unresolved AND onboarded))) AS not_actionable,
  SUM(reversed_range) AS reversed_range,
  SUM(out_of_range) AS out_of_range,
  SUM(missing_location) AS missing_location
FROM (
  SELECT
    (h.id IS NULL OR c.id IS NULL) AS missing_location,
    (
      (h.id IS NOT NULL AND (h.coord_lat NOT BETWEEN -90 AND 90 OR h.coord_lng NOT BETWEEN -180 AND 180))
      OR (c.id IS NOT NULL AND (c.coord_lat NOT BETWEEN -90 AND 90 OR c.coord_lng NOT BETWEEN -180 AND 180))
    ) AS out_of_range,
    (cs.start_date IS NOT NULL AND cs.end_date IS NOT NULL AND cs.end_date < cs.start_date) AS reversed_range,
    (
      cs.role <> 'VIEWER' AND (
        (h.id IS NOT NULL AND h.coord_lat = 0 AND h.coord_lng = 0)
        OR (c.id IS NOT NULL AND c.coord_lat = 0 AND c.coord_lng = 0)
      )
    ) AS unresolved,
    (COALESCE(u.is_onboarded, 1) = 1) AS onboarded
  FROM carpool_search cs
  LEFT JOIN location h ON h.id = cs.homeLocationId
  LEFT JOIN location c ON c.id = cs.companyLocationId
  LEFT JOIN user u ON u.id = cs.userId
) s
WHERE missing_location OR out_of_range OR reversed_range OR unresolved;

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
-- repair-seat-residue's third candidate set: driverless groups, and the
-- memberships a dissolve would clear. These are the two numbers its dry run
-- prints, and they are deliberately separate -- one is rows deleted, the other
-- is people returned to matching.
SELECT COUNT(*) AS driverless_groups, COALESCE(SUM(member_count), 0) AS memberships
FROM (
  SELECT g.id, COUNT(*) AS member_count
  FROM `group` g
  JOIN carpool_search cs ON cs.carpoolId = g.id
  GROUP BY g.id
  HAVING SUM(cs.role = 'DRIVER') = 0
) t;
```

**`backfill-profile-picture-timestamps` is deliberately script-only.** A `COUNT(*) FROM user WHERE profile_picture_updated_at IS NULL` would just repeat the figure the table above already records, and repeating it here would invite reading it as the outstanding count. It is not: a null row means "ask S3," so the count is every row that predates the column, not every row that predates it **and** still lacks a picture there. Only the script's own dry run lists the bucket and can tell the two apart (SCRUM-366).

The dry run is still better where it is practical: the scripts report _which_ rows, and some of them draw a distinction the SQL cannot. `backfill-group-preferences` did exactly that — it separated rows carrying preferences worth writing from rows whose stored value parsed to nothing, and on production the two figures were 11 and 12. The one row it skipped stayed in the SQL count for good, so the table cell never reached zero even once the work was finished. Trust the script's own report over the cell.

</details>

## Updating this record

When you run one of these against a shared environment, **edit the table in the same pull request as the work, or immediately after.** A rough row beats a blank cell: record the environment, the date, what happened (`applied, N rows`, `dry run, 0 candidates`) and who ran it. A dry run that reported zero is still worth recording — it is the evidence the next person needs.

## Retiring a script

A one-shot script should not live here forever. Retire it when **all** of these hold:

1. Its dry run reports zero candidates in **every** shared environment, recorded above.
2. The code path that made the bad data possible is fixed and deployed, so the population cannot grow again.
3. Any fallback existing only to tolerate un-migrated rows is removed, or is being removed in the same change.

Then delete the script, its test and its row, and say in the commit message which environments were verified and when.

`backfill-group-preferences.ts` is the worked example, now finished: SCRUM-287 removed the script, both legacy columns and `resolveGroupDetails`'s fallback in one change, which is point 3 — a fallback that exists only to tolerate un-migrated rows goes with the thing it was tolerating.

Point 1 is what held it up for six weeks, and the reason is worth keeping. The script's dry run reported candidates in **both** environments the whole time, and the values were not the `GROUP_DETAILS_V1:` blobs anyone expected — every one was plain text, which `parseGroupDetails` mapped to a real note. Dropping the column on the first attempt would have destroyed fourteen drivers' notes. Read point 1 as "the dry run says zero", never as "the backfill has surely run by now".

Read-only `check-*` and `measure-*` scripts are cheaper to keep than to re-derive. Retire those only when the thing they measure is gone.

## See also

- [Database layer](../src/server/db/README.md) — schema, migrations, and why backfills are scripts rather than migrations
- [README](../README.md) — setup, environment variables, dangerous commands
