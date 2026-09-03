# `scripts/`

Operational scripts, and the record of what has been run where.

Everything here is run by hand against a real database. Nothing in CI invokes
the `.ts` scripts, and nothing schedules them.

**Before running anything: confirm what `DATABASE_URL` points at.** None of
these scripts print the connection string, which means none of them will tell
you that you are pointed at production. Five of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the five that write
```

Node 22, per [`.nvmrc`](../.nvmrc). `ts-node` comes from `node_modules`, so
`yarn install` first.

## Why these are not `yarn` scripts

Deliberate. These are one-shot tools meant to be **retired** once applied
everywhere (see [Retiring a script](#retiring-a-script)). A `package.json` entry
per script would recreate a mess this repository has already had once — seven
entries pointing at files deleted long before. The explicit `npx ts-node` path also
keeps `--apply` visible at the call site rather than hidden behind an alias.

## The scripts

### Writes to the database

All five are dry-run by default, refuse to proceed past a `--max` ceiling
(default 500), and update or delete one row at a time by primary key so a
partial run leaves a consistent database. Re-running any of them is a no-op.

| Script                                                                 | What it does                                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`backfill-group-preferences.ts`](./backfill-group-preferences.ts)     | Moves the legacy `GROUP_DETAILS_V1:` blob out of `group_message` into the three real columns |
| [`backfill-request-status.ts`](./backfill-request-status.ts)           | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                   |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)         | Deletes `Location` rows no `CarpoolSearch` points at                                         |
| [`repair-seat-residue.ts`](./repair-seat-residue.ts)                   | Clamps out-of-range `seats_avail` into `[0, 6]` and deletes member-less `group` rows         |
| [`cleanup-orphan-conversations.ts`](./cleanup-orphan-conversations.ts) | Deletes `conversation` rows whose request is gone, and the `message` rows in them            |

**`cleanup-orphan-conversations` is the only script here that destroys message
content** — words two people typed to each other, which nothing can read any
more. Its dry run prints the message count per candidate for that reason; read
those numbers before `--apply`. Deleting is the privacy-respecting answer
rather than a tidy-up, but it is irreversible. See
[Conversation ownership](../src/server/db/README.md#conversation-ownership).

`repair-seat-residue` is the only one whose prefix is neither `backfill-` nor
`cleanup-`, because it both writes a column and deletes a row and neither verb
covers that. Its two halves are one defect's residue rather than two chores:
the overwritten-membership bug (SCRUM-291) cost a driver a seat and abandoned
their old group in the same event, so finding one is a reason to look for the
other. **Deploy the read-path fix from SCRUM-348 before running it** — with
`hasSeatAvailable` live, a negative row is already out of matching, which makes
this data hygiene rather than the fix itself.

Neither backfill exists as a Prisma migration on purpose: `prisma/migrations/`
is never applied to PlanetScale, so a data migration would be dead text in the
repository. See [the db README](../src/server/db/README.md#what-migrations-are-for-here-and-what-they-are-not).

### Read-only

These write nothing. Pointing them at production is safe, and several are only
meaningful there — a developer's local database holds too little data to say
anything.

| Script                                                           | What it reports                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`check-self-requests.ts`](./check-self-requests.ts)             | `Request` rows whose two ends are the same user                       |
| [`check-driverless-groups.ts`](./check-driverless-groups.ts)     | `CarpoolGroup` rows with no `DRIVER` member                           |
| [`check-profile-coordinates.ts`](./check-profile-coordinates.ts) | Searches unmatchable via `(0, 0)` coordinates or reversed co-op dates |
| [`check-seat-counts.ts`](./check-seat-counts.ts)                 | `CarpoolSearch` rows with `seats_avail` outside `[0, 6]`              |
| [`measure-candidate-rows.ts`](./measure-candidate-rows.ts)       | Rows read by the explore page's candidate query                       |
| [`measure-requests-payload.ts`](./measure-requests-payload.ts)   | Rows and payload bytes for `user.requests.me`                         |
| [`measure-unread-count.ts`](./measure-unread-count.ts)           | Query plan, generated SQL and timings for the unread badge            |

`measure-unread-count.ts` is the odd one out: its useful output is the
`EXPLAIN` plan, not its timings. Access types describe the shape of the work
rather than its current size, so the plan is worth reading against a local
database while the timings are not. For production numbers, PlanetScale
Insights is the authority and needs no script at all — that is where the
figures in [the db README](../src/server/db/README.md#the-unread-badge-the-measurement-and-why-no-index-was-added)
came from, because direct production reads return `403` (see below).

The four `check-*` scripts exit `0` when clean and `1` when not, so they can
gate a follow-up. **None of them has an `--apply`, and that is a decision
rather than an omission.** For the first three there is no single correct
repair, and only the affected user knows which one they want. For
`check-seat-counts` there is one — clamp into range — but keeping `check-*`
uniformly read-only is worth more than saving a file, so the repair lives in
`repair-seat-residue.ts` and this script stays safe to point anywhere. They
report and stop.

`check-seat-counts` has no `*.test.ts` of its own because it has no argument
parsing and no planning half: the selection is `findOutOfRangeSeatRows`, tested
in [`src/server/db/seatIntegrity.test.ts`](../src/server/db/seatIntegrity.test.ts).

### Not operational scripts

| File                                               | What it is                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env`, and the source of the placeholder build environment |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion          |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends      |

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

| Script                         | local | staging             | production           | Last verified | By            |
| ------------------------------ | ----- | ------------------- | -------------------- | ------------- | ------------- |
| `backfill-group-preferences`   | —     | **3 outstanding**⁴  | **unknown**⁴         | 2026-09-03    | SCRUM-287     |
| `backfill-request-status`      | —     | 0 outstanding       | **unknown**          | 2026-08-31    | initial audit |
| `cleanup-orphan-locations`     | —     | 0 outstanding       | **unknown**          | 2026-08-31    | initial audit |
| `check-self-requests`          | —     | 0 findings          | **unknown**          | 2026-08-31    | initial audit |
| `check-driverless-groups`      | —     | **1 finding**       | **unknown**          | 2026-08-31    | initial audit |
| `check-profile-coordinates`    | —     | 0 findings¹         | **unknown**          | 2026-08-31    | initial audit |
| `check-seat-counts`            | —     | **1 finding**²      | **unknown**          | 2026-09-02    | SCRUM-348     |
| `repair-seat-residue`          | —     | **2 outstanding**   | **unknown**          | 2026-09-02    | SCRUM-348     |
| `cleanup-orphan-conversations` | —     | **11 outstanding**³ | **620 outstanding**³ | 2026-09-03    | SCRUM-295     |

¹ 521 rider searches sit at `(0, 0)`, but none belongs to an onboarded user, so
the script does not count them.

² One `carpool_search` row at `seats_avail = -1`, DRIVER and ACTIVE. The
`repair-seat-residue` row is that same seat row plus one member-less `group`
row, which is the finding `check-driverless-groups` reports as "empty" — the
two scripts see the same group from different sides.

³ Staging: 11 orphan conversations holding **25 messages**. Production:
**620 conversations holding 1,258 messages**, every one of the 620 non-empty,
the largest holding 28 — measured read-only through DBeaver on 2026-09-03, with
nothing modified.

**Both request links were checked on the same date, also read-only:** **0** of
the 620 were still pointed at by a live request through `Request.conversationId`,
and all **620** fail that link _and_ `Conversation.requestId`. The distinction
matters because the outstanding count uses the `Conversation.requestId`
predicate only, while `requests.me` and the unread badge read a conversation
through the other column — so the two questions could in principle disagree.
Here they do not, which makes all 620 **confirmed unreachable**. The queries are
below, under
[Re-checking without running the scripts](#re-checking-without-running-the-scripts).
SCRUM-364 tracks aligning the script's plan with its own pre-delete re-check,
which already tests both links.

⁴ Re-measured read-only on 2026-09-03 for SCRUM-287, which cannot start until
this row reads zero everywhere. Staging still has **3** un-migrated rows, and
all three carry a **plain-text** legacy message rather than a
`GROUP_DETAILS_V1:` blob — none encoded, none blank. `parseGroupDetails` maps
plain text to `notes`, so `hasAnyDetail` is true for all three and the backfill
would write all three. **Dropping `carpool_search.group_message` today would
lose three drivers' notes**, which confirms finding 1 below rather than
softening it.

Two counts, and this table records the first: the SQL below counts _un-migrated
rows with a legacy message_, while the script additionally reports how many
_carry preferences worth writing_. They coincide on staging (3 and 3). They need
not in general — a row whose blob parses to nothing is deliberately skipped and
stays in the first count forever — so the script's own dry run, not this cell,
is what SCRUM-287's precondition asks for.

Production is still `unknown` and could not be measured: data queries against
`main` return 403 (below). **Schema metadata for `main` is readable, though, and
that settles a different question** — `carpool_search` there carries
`group_notes`, `group_music_preference` and `group_conversation_style` alongside
the legacy `group_message`, so the SCRUM-253 schema _is_ deployed to production.
Precondition 1 of SCRUM-287 holds; precondition 2 is the open one.

Separately, `group` on staging holds 11 rows, of which **1 has a non-blank
`message`**. Nothing reads that column — `resolveGroupDetails` only ever reads
`carpool_search.group_message` — so that value is already unreachable from the
app, and the backfill never touches it by design. Worth knowing before
SCRUM-287 drops the column: it destroys a copy nothing can read, not a
preference a driver can see.

**Staging was not a useful guide to the scale here.** 11 versus 620 is not a
sampling difference: of the conversations that ever carried a thread, almost all
of the production population is orphaned. Treat the other two scripts' staging
figures with the same suspicion.

**620 exceeds the default `--max` of 500, so `--apply` will refuse** with exit
code 2 until the ceiling is raised explicitly (`--apply --max 700`). The dry run
reports normally. That is the guard working: 1,258 messages should not be
deleted by a command indistinguishable from the one that would delete eleven
rows.

**No `--apply` has been run anywhere**, and the seat figures on the two rows
above were produced by direct SQL rather than by running their scripts. The conditions are the same, so the numbers should hold,
but a dry run has not confirmed them and **no `--apply` has been run anywhere**.
Run the dry run before the apply rather than trusting this cell.

**Production is `unknown` for every row but one, and not for lack of trying.**
Read queries against the PlanetScale `main` branch return `403 Permission
denied` with the credentials available here — **schema metadata for `main` is
readable, only row data is not**, which is enough to confirm a column exists but
never how many rows need fixing — so these cells cannot be filled
from this repository. `cleanup-orphan-conversations` is the exception: it was
measured read-only through DBeaver on 2026-09-03, which is the route that
works. **Every other production cell above is an open question, not a zero** —
and the 11-versus-620 gap on the row that _has_ been measured is the reason to
treat them that way.

### `emailtemplate.py` — a republish is outstanding

`emailtemplate.py` is not in the table above, because it does not touch the
database and "outstanding rows" is the wrong question for it. It has its own
pending state instead.

SCRUM-360 changed the templates in this repository so that each part of an
email reads its own variables — the `HtmlPart` the escaped `{{...Html}}` set,
the `TextPart` the raw `{{...Plain}}` set. **That change is inert until someone
runs the script**, because the templates live in AWS and this file is only a
description of them.

| What                               | State                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| App emits the suffixed variables   | Yes, from the SCRUM-360 deploy onwards                 |
| Templates in AWS read them         | **Not republished.** Still on the unsuffixed variables |
| Unsuffixed variables still emitted | Yes, deliberately — see `src/server/emailParams.ts`    |

Nothing is broken in the meantime: `generateEmailParams` still emits the
unsuffixed `{{preferredName}}` / `{{OtherUser}}` / `{{message}}`, escaped, so
the templates currently live in AWS keep rendering exactly as they did. What is
outstanding is the improvement, not a fix — until the republish, HTML entities
still leak into the plain-text part of every notification.

**The ordering is not optional.** The app deploy emitting the suffixed
variables must land before the republish. Republishing first points the live
templates at variables the deployed app does not send, and SES renders a
missing variable as nothing — so names and message bodies would vanish from
live email. **Confirm the SCRUM-360 deploy is live in the target environment
before republishing it**, rather than assuming that merging was enough.

Running it needs `ACCESS_KEY_ID_AWS` / `SECRET_ACCESS_KEY_AWS` / `REGION_AWS`
in `.env`, and **confirm which AWS account they point at first** — the script
names no environment and will happily update production templates. Record the
run here when it happens, and once it is recorded for every environment the
unsuffixed variables can be deleted from `emailParams.ts`.

| Environment | Republished | Date | By  |
| ----------- | ----------- | ---- | --- |
| staging     | **no**      | —    | —   |
| production  | **no**      | —    | —   |

### Four findings worth acting on

1. **`backfill-group-preferences` is not finished on staging — 3 rows**, and as
   of 2026-09-03 that is confirmed by direct read rather than inferred: all
   three hold plain-text legacy messages, which `parseGroupDetails` turns into
   notes, so the backfill would write all three. This blocks dropping
   `carpool_search.group_message` (SCRUM-287), which is only safe once the
   backfill has been applied _everywhere_. While those rows exist,
   `resolveGroupDetails`'s legacy fallback is the only thing keeping their
   preferences readable, so dropping the column would lose data. The production
   count remains unmeasured — see footnote 4.
2. **One driverless `CarpoolGroup` on staging.** Expected rather than alarming:
   the guards against it are not retroactive, which is why the check exists.
   Worth a look, and there is no automatic repair by design.
3. **One ACTIVE driver on staging at `seats_avail = -1`, and one member-less
   `group` row.** The residue of SCRUM-229 and SCRUM-291, whose code fixes were
   never retroactive. The read-path fix in SCRUM-348 has closed the user-facing
   half — that driver is no longer offered to riders they cannot accept — so
   what remains is a driver advertising no space until either the repair runs or
   they re-save their profile. **The production count is the open question**:
   the 403 noted above means nobody has measured it, and one row on staging is a
   lower bound rather than the answer.
4. **620 orphan conversations in production, holding 1,258 messages.** The
   residue of the cascade pointing the wrong way, fixed in `requests.delete` by
   SCRUM-295 so the population cannot grow. **This is the largest finding in
   this table by two orders of magnitude**, and the one where staging (11
   conversations, 25 messages) was most misleading. The rows are unreachable by
   every user-facing path — verified on **both** request links, see footnote 3
   — so they are pure retention risk: private message content nobody can read
   and nobody can delete. They also inflate `admin.getDashboardStats`'s
   conversation count and messages-per-conversation average permanently until
   removed. Deleting them destroys 1,258 real messages, which is why the dry
   run prints per-candidate counts and why `--apply` refuses until `--max` is
   raised past 620. **Raising it is not the intended route** — SCRUM-364 adds a
   subset option so the population can be retired in tranches beneath the
   existing ceiling, and SCRUM-365 holds the decision about whether to delete
   at all.

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

-- cleanup-orphan-conversations: conversations whose request is gone
SELECT COUNT(*) FROM conversation c
WHERE NOT EXISTS (SELECT 1 FROM request r WHERE r.id = c.requestId);

-- and the messages that would go with them
SELECT COUNT(*) FROM message m
JOIN conversation c ON c.id = m.conversationId
WHERE NOT EXISTS (SELECT 1 FROM request r WHERE r.id = c.requestId);

-- the second link: orphans a live request still points at through
-- Request.conversationId, which requests.me and the unread badge would still
-- read. Expected to return nothing; any row here is NOT an unreachable orphan.
SELECT c.id, c.requestId AS dead_request_id, r2.id AS live_request_id
FROM conversation c
LEFT JOIN request r1 ON r1.id = c.requestId
JOIN      request r2 ON r2.conversationId = c.id
WHERE r1.id IS NULL;

-- the provably unreachable population: fails both links
SELECT COUNT(*) FROM conversation c
WHERE NOT EXISTS (SELECT 1 FROM request r1 WHERE r1.id = c.requestId)
  AND NOT EXISTS (SELECT 1 FROM request r2 WHERE r2.conversationId = c.id);

-- check-seat-counts: seat counts outside [0, MAX_SEATS_AVAILABLE]
SELECT id, userId, role, status, seats_avail FROM carpool_search
WHERE seats_avail < 0 OR seats_avail > 6;

-- repair-seat-residue: the same rows, plus the member-less group rows it deletes
SELECT COUNT(*) FROM carpool_search WHERE seats_avail < 0 OR seats_avail > 6;
SELECT COUNT(*) FROM `group` g WHERE NOT EXISTS (
  SELECT 1 FROM carpool_search cs WHERE cs.carpoolId = g.id
);
```

The `6` is `MAX_SEATS_AVAILABLE` written out. It is a constant in
[`carpoolSeats.ts`](../src/utils/carpoolSeats.ts) and SQL cannot import it, so
if that value ever changes these two queries are what to update — the scripts
themselves will already be right.

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
commit message which environments were verified and when.
`backfill-group-preferences.ts` is the worked example: retiring it means
removing the script, the legacy columns, and `resolveGroupDetails`'s fallback
together — and that cannot proceed until point 1 holds, which today it does not.

Read-only `check-*` and `measure-*` scripts are cheaper to keep than to
re-derive. Retire those only when the thing they measure is gone.

## See also

- [`src/server/db/README.md`](../src/server/db/README.md) — schema, migrations, and why backfills are scripts rather than migrations
- [`CLAUDE.md`](../CLAUDE.md) — the destructive-command rules that apply to everything here
- [`README.md`](../README.md) — setup, environment variables, deployment
