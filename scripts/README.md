# `scripts/`

Operational scripts, and the record of what has been run where (SCRUM-307).

Everything here is run by hand against a real database. Nothing in CI invokes
the `.ts` scripts, and nothing schedules them.

**Before running anything: confirm what `DATABASE_URL` points at.** None of
these scripts print the connection string, which means none of them will tell
you that you are pointed at production. Three of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the three that write
```

Node 22, per [`.nvmrc`](../.nvmrc). `ts-node` comes from `node_modules`, so
`yarn install` first.

## Why these are not `yarn` scripts

Deliberate. These are one-shot tools meant to be **retired** once applied
everywhere (see [Retiring a script](#retiring-a-script)). A `package.json` entry
per script would recreate exactly the mess SCRUM-249 cleaned up — seven entries
pointing at files deleted long before. The explicit `npx ts-node` path also
keeps `--apply` visible at the call site rather than hidden behind an alias.

## The scripts

### Writes to the database

All three are dry-run by default, refuse to proceed past a `--max` ceiling
(default 500), and update or delete one row at a time by primary key so a
partial run leaves a consistent database. Re-running any of them is a no-op.

| Script                                                             | What it does                                                                                 | Origin    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------- |
| [`backfill-group-preferences.ts`](./backfill-group-preferences.ts) | Moves the legacy `GROUP_DETAILS_V1:` blob out of `group_message` into the three real columns | SCRUM-253 |
| [`backfill-request-status.ts`](./backfill-request-status.ts)       | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                   | SCRUM-228 |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)     | Deletes `Location` rows no `CarpoolSearch` points at                                         | SCRUM-232 |

Neither backfill exists as a Prisma migration on purpose: `prisma/migrations/`
is never applied to PlanetScale, so a data migration would be dead text in the
repository. See [the db README](../src/server/db/README.md#what-migrations-are-for-here-and-what-they-are-not).

### Read-only

These write nothing. Pointing them at production is safe, and several are only
meaningful there — a developer's local database holds too little data to say
anything.

| Script                                                           | What it reports                                                       | Origin    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | --------- |
| [`check-self-requests.ts`](./check-self-requests.ts)             | `Request` rows whose two ends are the same user                       | SCRUM-278 |
| [`check-driverless-groups.ts`](./check-driverless-groups.ts)     | `CarpoolGroup` rows with no `DRIVER` member                           | SCRUM-289 |
| [`check-profile-coordinates.ts`](./check-profile-coordinates.ts) | Searches unmatchable via `(0, 0)` coordinates or reversed co-op dates | SCRUM-302 |
| [`measure-candidate-rows.ts`](./measure-candidate-rows.ts)       | Rows read by the explore page's candidate query                       | SCRUM-245 |
| [`measure-requests-payload.ts`](./measure-requests-payload.ts)   | Rows and payload bytes for `user.requests.me`                         | SCRUM-301 |
| [`measure-unread-count.ts`](./measure-unread-count.ts)           | Query plan, generated SQL and timings for the unread badge            | SCRUM-306 |

`measure-unread-count.ts` is the odd one out: its useful output is the
`EXPLAIN` plan, not its timings. Access types describe the shape of the work
rather than its current size, so the plan is worth reading against a local
database while the timings are not. For production numbers, PlanetScale
Insights is the authority and needs no script at all — that is where the
figures in [the db README](../src/server/db/README.md#the-unread-badge-the-measurement-and-why-no-index-was-added-scrum-306)
came from, because direct production reads return `403` (see below).

The three `check-*` scripts exit `0` when clean and `1` when not, so they can
gate a follow-up. **None of them has an `--apply`, and that is a decision
rather than an omission** — for each, there is no single correct repair, and
only the affected user knows which one they want. They report and stop.

### Not operational scripts

| File                                               | What it is                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env`, and the source of the placeholder build environment    |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion (SCRUM-269) |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends         |

`*.test.ts` files next to each script cover the argument parsing and the pure
planning half, and run in `yarn test`. A passing suite says nothing about what
a script would do to a real database.

## Run-state record

**No record of past runs existed before this file.** The rows below are what
could be established on 2026-08-31, and they are deliberately split into two
different questions, because only one of them is answerable from a database:

- **"Has it been run?"** — unknowable retrospectively. Nothing recorded it.
- **"Does it still have work to do?"** — checkable, and the question that
  actually matters before dropping a column or closing a ticket.

A zero outstanding count therefore means _"nothing left to do"_, **not**
_"it was run"_ — a script that never had candidates and a script applied
successfully look identical.

| Script                       | local | staging           | production  | Last verified | By        |
| ---------------------------- | ----- | ----------------- | ----------- | ------------- | --------- |
| `backfill-group-preferences` | —     | **3 outstanding** | **unknown** | 2026-08-31    | SCRUM-307 |
| `backfill-request-status`    | —     | 0 outstanding     | **unknown** | 2026-08-31    | SCRUM-307 |
| `cleanup-orphan-locations`   | —     | 0 outstanding     | **unknown** | 2026-08-31    | SCRUM-307 |
| `check-self-requests`        | —     | 0 findings        | **unknown** | 2026-08-31    | SCRUM-307 |
| `check-driverless-groups`    | —     | **1 finding**     | **unknown** | 2026-08-31    | SCRUM-307 |
| `check-profile-coordinates`  | —     | 0 findings¹       | **unknown** | 2026-08-31    | SCRUM-307 |

¹ 521 rider searches sit at `(0, 0)`, but none belongs to an onboarded user, so
the script does not count them — see the SCRUM-302 comment thread.

**Production is `unknown` for every row, and not for lack of trying.** Read
queries against the PlanetScale `main` branch return `403 Permission denied`
with the credentials available here. Determining production state needs either
a token with production read access or someone running the dry runs with
`DATABASE_URL` pointed at production. **Until that happens, every production
cell above is an open question, not a zero.**

### Two findings worth acting on

1. **`backfill-group-preferences` is not finished on staging — 3 rows.** This is
   the blocker for **SCRUM-287**, which drops `carpool_search.group_message` and
   is only safe once the backfill has been applied _everywhere_. While those
   rows exist, `resolveGroupDetails`'s legacy fallback is the only thing keeping
   their preferences readable, so dropping the column would lose data. SCRUM-287
   cannot be closed on the strength of this file.
2. **One driverless `CarpoolGroup` on staging.** Expected rather than alarming:
   SCRUM-289's guards are not retroactive, which is why the check exists. Worth
   a look, and there is no automatic repair by design.

### Re-checking without running the scripts

Each row above is one read-only query. These are the same conditions the
scripts use, so they can be run through any SQL console — including against
production, where they are safe.

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

-- check-self-requests
SELECT COUNT(*) FROM request WHERE fromUserId = toUserId;

-- check-driverless-groups
SELECT COUNT(*) FROM `group` g WHERE NOT EXISTS (
  SELECT 1 FROM carpool_search cs WHERE cs.carpoolId = g.id AND cs.role = 'DRIVER'
);
```

Preferring the dry run to the query is still better where it is practical: the
scripts report _which_ rows, and `backfill-group-preferences` additionally
distinguishes rows carrying preferences worth writing from rows whose blob
parses to nothing.

## Updating this record

When you run one of these against a shared environment, **edit the table in the
same pull request as the work, or immediately after**. A row is worth more than
a perfect one: `2026-09-04 · staging · applied, 3 rows written · jcho` beats a
blank cell, even without ceremony.

Record the environment, the date, what happened (`applied, N rows`, `dry run,
0 candidates`, `0 findings`), and who ran it. If a dry run reported zero and you
wrote nothing, that is still worth recording — it is the evidence the next
person needs.

## Retiring a script

A one-shot script should not live here forever. Retire it when **all** of these
hold:

1. Its dry run reports zero candidates in **every** shared environment —
   local, staging and production — recorded in the table above.
2. The code path that made the bad data possible is fixed and deployed, so the
   population cannot grow again.
3. Any fallback that exists only to tolerate un-migrated rows has been removed,
   or is being removed in the same change.

Then delete the script, its `*.test.ts`, and its row above, and say in the
commit message which environments were verified and when. `backfill-group-preferences.ts`
is the worked example: SCRUM-287 removes it, the legacy columns, and
`resolveGroupDetails`'s fallback together — and cannot proceed until point 1
holds, which today it does not.

Read-only `check-*` and `measure-*` scripts are cheaper to keep than to
re-derive. Retire those only when the thing they measure is gone.

## See also

- [`src/server/db/README.md`](../src/server/db/README.md) — schema, migrations, and why backfills are scripts rather than migrations
- [`CLAUDE.md`](../CLAUDE.md) — the destructive-command rules that apply to everything here
- [`README.md`](../README.md) — setup, environment variables, deployment
