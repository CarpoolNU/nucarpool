# `scripts/`

Operational scripts, and the record of what has been run where.

Everything here is run by hand against a real database. Nothing in CI invokes
the `.ts` scripts, and nothing schedules them.

**Before running anything: confirm what `DATABASE_URL` points at.** None of
these scripts print the connection string, which means none of them will tell
you that you are pointed at production. Six of them write.

```bash
npx ts-node scripts/<name>.ts            # every script: report only
npx ts-node scripts/<name>.ts --apply    # the six that write
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

All six are dry-run by default, refuse to proceed past a `--max` ceiling
(default 500), and update or delete one row at a time by primary key so a
partial run leaves a consistent database. Re-running any of them is a no-op.

`cleanup-orphan-conversations` additionally takes `--limit N` and `--older-than
YYYY-MM-DD`, which narrow what a run acts on so a population larger than the
ceiling can be retired in tranches instead of by raising it. It is also the only
one that logs every row it deletes before deleting it, because it is the only
one that destroys message content.

| Script                                                                               | What it does                                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`backfill-group-preferences.ts`](./backfill-group-preferences.ts)                   | Moves the legacy `GROUP_DETAILS_V1:` blob out of `group_message` into the three real columns |
| [`backfill-request-status.ts`](./backfill-request-status.ts)                         | Sets `Request.status = ACCEPTED` for pairs who already share a `carpoolId`                   |
| [`cleanup-orphan-locations.ts`](./cleanup-orphan-locations.ts)                       | Deletes `Location` rows no `CarpoolSearch` points at                                         |
| [`repair-seat-residue.ts`](./repair-seat-residue.ts)                                 | Clamps out-of-range `seats_avail` into `[0, 6]` and deletes member-less `group` rows         |
| [`cleanup-orphan-conversations.ts`](./cleanup-orphan-conversations.ts)               | Deletes `conversation` rows whose request is gone, and the `message` rows in them            |
| [`backfill-profile-picture-timestamps.ts`](./backfill-profile-picture-timestamps.ts) | Records `user.profile_picture_updated_at` for every picture already in S3                    |

**`backfill-profile-picture-timestamps` is the only script here that reads
AWS**, not just the database. It needs `s3:ListBucket` on the configured bucket,
performs no S3 writes and deletes nothing, and `NEXT_PUBLIC_ENV` selects which
key prefix it lists. Pointing it at the wrong environment lists an empty prefix
and reports zero rather than failing, so confirm that variable as well as
`DATABASE_URL`. It writes `LastModified` from the S3 listing rather than
`now()`, because the column is meant to say when the picture last changed.

**Two scripts here destroy message content**, and they are not the same
decision. `cleanup-orphan-conversations` deletes words two people typed to each
other that nothing can read any more — the privacy-respecting answer rather than
a tidy-up, and irreversible. See
[Conversation ownership](../src/server/db/README.md#conversation-ownership).
`cleanup-self-requests` deletes a user's own opening message to themselves: on
production that is three characters in one row and an empty string in the other,
measured rather than assumed. Both print the message count per candidate before
deleting, so read those numbers before `--apply`.

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
came from. Direct production reads through the MCP server return `403`, but the
CLI reader role does not — see
[Production is readable, and now measured](#production-is-readable-and-now-measured).

The four `check-*` scripts exit `0` when clean and `1` when not, so they can
gate a follow-up. **None of them has an `--apply`, and that is a decision
rather than an omission.** For `check-driverless-groups` and
`check-profile-coordinates` there is no single correct repair, and only the
affected user knows which one they want. For the other two there is one, and it
lives in a sibling rather than in the check: clamping a seat count into range is
`repair-seat-residue.ts`, and deleting a self-request is
`cleanup-self-requests.ts`. Keeping `check-*` uniformly read-only is worth more
than saving a file — it is what makes every one of them safe to point at
production. They report and stop.

`check-seat-counts` has no `*.test.ts` of its own because it has no argument
parsing and no planning half: the selection is `findOutOfRangeSeatRows`, tested
in [`src/server/db/seatIntegrity.test.ts`](../src/server/db/seatIntegrity.test.ts).

### Not operational scripts

| File                                               | What it is                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`check-env-contract.js`](./check-env-contract.js) | CI: `yarn check:env` and `yarn check:amplify`, and the source of the placeholder build environment |
| [`check-page-routes.js`](./check-page-routes.js)   | CI: `yarn check:routes` and the `build` job's manifest assertion                                   |
| [`emailtemplate.py`](./emailtemplate.py)           | **Mutates AWS.** Creates and updates the SES templates the app sends                               |

`*.test.ts` files next to each script cover the argument parsing and the pure
planning half, and run in `yarn test`. A passing suite says nothing about what
a script would do to a real database.

## Run-state record

**No record of past runs existed before this file.** The rows below were first
established on 2026-08-31 and every production figure in them was taken on
2026-09-09, once the route that reads production was found. They are deliberately
split into two different questions, because only one of them is answerable from a
database:

- **"Has it been run?"** — unknowable retrospectively. Nothing recorded it.
- **"Does it still have work to do?"** — checkable, and the question that
  actually matters before dropping a column or closing a ticket.

A zero outstanding count therefore means _"nothing left to do"_, **not**
_"it was run"_ — a script that never had candidates and a script applied
successfully look identical.

| Script                                | local | staging             | production          | Last verified | By        |
| ------------------------------------- | ----- | ------------------- | ------------------- | ------------- | --------- |
| `backfill-group-preferences`          | —     | **3 outstanding**⁴  | **12 outstanding**⁴ | 2026-09-09    | SCRUM-287 |
| `backfill-request-status`             | —     | 0 outstanding       | 0 outstanding⁶      | 2026-09-09    | SCRUM-392 |
| `cleanup-orphan-locations`            | —     | 0 outstanding       | **90 outstanding**⁶ | 2026-09-09    | SCRUM-392 |
| `check-self-requests`                 | —     | 0 findings          | **2 findings**⁶     | 2026-09-09    | SCRUM-392 |
| `check-driverless-groups`             | —     | **1 finding**       | **18 findings**⁶    | 2026-09-09    | SCRUM-392 |
| `check-profile-coordinates`           | —     | **521 findings**¹   | **626 findings**¹   | 2026-09-09    | SCRUM-392 |
| `check-seat-counts`                   | —     | **1 finding**²      | 0 findings⁶         | 2026-09-09    | SCRUM-392 |
| `repair-seat-residue`                 | —     | **2 outstanding**   | **3 outstanding**²  | 2026-09-09    | SCRUM-392 |
| `cleanup-orphan-conversations`        | —     | **11 outstanding**³ | **620 retained**³   | 2026-09-09    | SCRUM-392 |
| `backfill-profile-picture-timestamps` | —     | **1,298 null**⁵     | **4,322 null**⁵     | 2026-09-09    | SCRUM-392 |
| `cleanup-self-requests`               | —     | 0 outstanding       | **2 outstanding**⁷  | 2026-09-09    | SCRUM-409 |

**Every production figure above was taken on 2026-09-09 for SCRUM-392**, through
the CLI reader route described [below](#production-is-readable-and-now-measured),
read-only and as aggregate counts. Footnote 6 records the one way they fall short
of what that ticket asked for.

¹ **This cell used to read `0 findings` on staging, and that was wrong.** The
note said 521 rider searches sit at `(0, 0)` but none belongs to an onboarded
user, "so the script does not count them". The premise is true and the
conclusion is not: `check-profile-coordinates` filters on `role !== VIEWER`, not
on onboarding, and it never has — `git log -p --follow` over the file returns no
mention of `is_onboarded`. All 521 are `RIDER`, so the script reports all 521.

Both branches, and the split that matters:

|                                                       | staging | production |
| ----------------------------------------------------- | ------- | ---------- |
| Rows the script reports                               | **521** | **626**    |
| …belonging to an onboarded user                       | **0**   | **47**     |
| `(0, 0)` on a non-`VIEWER` search, never onboarded    | 521     | 579        |
| Reversed co-op range                                  | 0       | 47         |
| Coordinates out of range, or a missing `location` row | 0       | 0          |

So the actionable production population is **47 searches with an inverted co-op
range**, 40 of them `ACTIVE`, and the other 579 are abandoned sign-ups that were
never in matching to begin with. Two tickets: **SCRUM-407** for the 47, and
**SCRUM-408** for the script reporting the 579 alongside them and exiting `1` on
the total.

² One `carpool_search` row at `seats_avail = -1`, DRIVER and ACTIVE. The
`repair-seat-residue` row is that same seat row plus one member-less `group`
row, which is the finding `check-driverless-groups` reports as "empty" — the
two scripts see the same group from different sides.

**Production splits the two halves apart.** Its seat counts are clean —
`MIN = 0`, `MAX = 6`, zero out of range across 4,098 rows, confirming the
incidental SCRUM-380 measurement — so the whole of its `repair-seat-residue`
figure is the other half: **3 member-less `group` rows** and no seat row at all.
Those three are the easy case of SCRUM-406: nothing points at them, so deleting
them affects nobody.

³ Staging: 11 orphan conversations holding **25 messages**. Production:
**620 conversations holding 1,258 messages**, every one of the 620 non-empty,
the largest holding 28 — measured read-only through DBeaver on 2026-09-03, with
nothing modified.

**Re-verified on 2026-09-09 through the CLI reader route, and the figures are
identical**: 620 conversations failing both links, holding 1,258 messages, out of
3,717 conversations in total. Two things follow. The regression check this row
exists for **passes** — the population has not grown, so `requests.delete`
remains correct. And two independent routes, taken six days apart by different
tools, agree exactly, which is the strongest evidence available here that the
reader role sees the same database DBeaver did.

**Both request links were checked on the same date, also read-only:** **0** of
the 620 were still pointed at by a live request through `Request.conversationId`,
and all **620** fail that link _and_ `Conversation.requestId`. The distinction
matters because `requests.me` and the unread badge read a conversation through
`Request.conversationId` while `getConversationMessages` reads it through
`Conversation.requestId` — so the two questions could in principle disagree.
Here they do not, which makes all 620 **confirmed unreachable**. The queries are
below, under
[Re-checking without running the scripts](#re-checking-without-running-the-scripts).

**The script's own predicate now tests both links** (SCRUM-364), so the count it
reports and the set it would act on are the same definition its pre-delete
re-check applies. The figure above was measured with the older one-link
predicate, which was an upper bound; for this population the two agree exactly.

**The 620 are retained by decision, not queued for deletion.** SCRUM-365 chose
to keep them and to revisit only if they cause a problem; the reasoning and what
accepting it entails are recorded in
[the db README](../src/server/db/README.md#the-620-are-retained-by-decision).
The run-state cell says `retained` rather than `outstanding` for that reason —
this row is no longer a pending action. What it is now is a **regression
check**: the population cannot grow while `requests.delete` is correct, so a dry
run reporting more than 620 means SCRUM-295 has regressed.

⁴ Re-measured read-only for SCRUM-287, which cannot start until this row reads
zero everywhere: staging on 2026-09-03, production on 2026-09-09. Staging still
has **3** un-migrated rows, and all three carry a **plain-text** legacy message
rather than a `GROUP_DETAILS_V1:` blob — none encoded, none blank.
`parseGroupDetails` maps plain text to `notes`, so `hasAnyDetail` is true for
all three and the backfill would write all three. **Dropping
`carpool_search.group_message` today would lose three drivers' notes on
staging**, which confirms finding 1 below rather than softening it.

Two counts, and this table records the first: the SQL below counts _un-migrated
rows with a legacy message_, while the script additionally reports how many
_carry preferences worth writing_. They coincide on staging (3 and 3). They need
not in general — a row whose blob parses to nothing is deliberately skipped and
stays in the first count forever — so the script's own dry run, not this cell,
is what SCRUM-287's precondition asks for.

**Production is no longer `unknown`, and it is four times staging.** The 403
that left this cell unmeasured belongs to the PlanetScale MCP server alone; the
CLI reader role below reads production, and on **2026-09-09** it counted **12**
un-migrated rows holding a legacy message — **11** with content, **1** blank,
and again **none** in the `GROUP_DETAILS_V1:` encoding. The backfill would
therefore write eleven production rows, so the drop would lose **eleven**
drivers' notes there on top of staging's three. Precondition 2 fails on both
branches, and now with a number on each.

**Four of those eleven are longer than `group_notes` accepts** — the longest at
1,152 characters against a 90-character column. That is not a reason to delay
the backfill: `parseGroupDetails` clamps to 90 on the way out, so no driver has
ever been shown more than the first 90 characters of a legacy message, and the
backfill writes exactly what the fallback already resolves to. What it does mean
is that the **stored** remainder is discarded when the backfill runs and gone
for good once the column is dropped. Worth knowing before the Deploy Request
rather than after it.

**Precondition 1 held already, from a different source.** Schema metadata for
`main` was readable even while row data was not: `carpool_search` there carries
`group_notes`, `group_music_preference` and `group_conversation_style` alongside
the legacy `group_message`, so the SCRUM-253 schema _is_ deployed to production.

**Precondition 3 stays unverified, and these counts cannot settle it.** Not one
`carpool_search` row on either branch has any of the three new columns set — 0
of 4,098 on production, 0 of 1,298 on staging. That reads the same whether
Amplify has never deployed the SCRUM-253 build or has deployed it and no driver
has saved group preferences since, because only 12 rows in 4,098 ever carried a
group message at all. Confirm the deploy directly; this table cannot.

Separately, the second column SCRUM-287 drops: `group` holds 11 rows on staging
with **1 non-blank `message`**, and 66 rows on production with **4**. Nothing
reads that column — `resolveGroupDetails` only ever reads
`carpool_search.group_message` — so those values are already unreachable from
the app, and the backfill never touches them by design. Worth knowing before
SCRUM-287 drops the column: it destroys a copy nothing can read, not a
preference a driver can see.

⁵ New in SCRUM-276 and **still not run anywhere**, but no longer for the reason
first recorded here: the column is now deployed. Re-measured on 2026-09-03 for
SCRUM-366, which is the contract half and cannot start until this row is clear.

**The schema is deployed to both shared branches.** `user` carries
`profile_picture_updated_at datetime(3)` on PlanetScale `main`, read from schema
metadata, and on `staging`, where a query against the column succeeds. So the
deploy request has happened and precondition 1 of SCRUM-366 holds.

**Staging: 1,298 user rows, 1,298 null, 0 recorded. Production: 4,323 user rows,
4,322 null, 1 recorded.** Read-only, nothing modified.

Two things that cell is not. It is **not an outstanding count** — it is an upper
bound on one. The script only writes a row that has an object at
`profile-pictures/{env}/{userId}`, and most of those 1,298 users have never
uploaded a picture, so the number of rows it would actually fill is smaller and
**cannot be determined from the database alone**. Answering it needs
`s3:ListBucket`, which is why this is the one script here that reads AWS, and
why its dry run — not this cell — is what SCRUM-366's precondition asks for.

It is also **not evidence about the deployed build — on staging.** `0 recorded`
is equally consistent with "Amplify has not shipped the SCRUM-276 build to
staging" and with "it has, and nobody has uploaded a picture since"; the two are
indistinguishable from here. That is precondition 3, and on staging it is
unverified.

**Production's single non-null row settles it there, and it is the only positive
control any of these cells has produced.** Exactly two things write
`profile_picture_updated_at`: the upload mutation at
[`src/server/router/user.ts:528`](../src/server/router/user.ts), and this script
— which has never been run anywhere. So that row was written by a deployed build
containing SCRUM-276, and **precondition 3 of SCRUM-366 holds on production**.

**It reaches further than its own ticket.** SCRUM-276's implementation commit is
`89c835e` (2026-09-03), and SCRUM-253's is `dff0212` (2026-08-27), which
`git merge-base --is-ancestor` confirms is an ancestor of it. A build containing
the later commit contains the earlier one, so **precondition 3 of SCRUM-287 holds
too** — the production build knows about `group_notes` and its two siblings. That
is a bound on the deployed commit rather than a reading of it; SCRUM-405 is the
ticket for publishing the commit directly instead of inferring it from a column.

Note the asymmetry that makes this work. A non-null value proves a build shipped;
a null one proves nothing, which is why the same reasoning fails on
`carpool_search.group_notes`, where production is 0 of 4,098.

Nothing is broken in the meantime — `getPresignedDownloadUrl` falls back to the
S3 `HeadObject` for any null row, exactly the behaviour that preceded the
column — so what is outstanding is the saving rather than a fix. Every user who
uploads after the deploy is free from then on; this script converts everyone
else.

**Staging was not a useful guide to the scale here.** 11 versus 620 is not a
sampling difference: of the conversations that ever carried a thread, almost all
of the production population is orphaned. Treat the other two scripts' staging
figures with the same suspicion.

**620 exceeds the default `--max` of 500, so a bare `--apply` refuses** with
exit code 2. The dry run reports normally. That is the guard working: 1,258
messages should not be deleted by a command indistinguishable from the one that
would delete eleven rows.

**The route through it is `--limit`, not `--max`.** `--apply --limit 400` acts
on the oldest 400 candidates and reports the rest as deferred, so a population
larger than the ceiling can be retired in tranches without ever raising it
(SCRUM-364). `--apply --max 700` would restore precisely the single
indistinguishable command the ceiling exists to prevent. `--older-than
YYYY-MM-DD` narrows by creation date instead, as a UTC midnight, comparing
strictly so two successive tranches cannot overlap on the boundary day.

Note the residual weakness in that design: `--max` bounds what a run _acts on_,
so a predicate error that flagged the whole table would still be visible in the
candidate total the report prints, but a small enough `--limit` would delete
that many rows anyway. The per-candidate log is what would show it — which is
why `--apply` now prints every conversation and its message count immediately
before deleting it.

**No `--apply` has been run anywhere**, and the seat figures on the two rows
above were produced by direct SQL rather than by running their scripts. The conditions are the same, so the numbers should hold,
but a dry run has not confirmed them and **no `--apply` has been run anywhere**.
Run the dry run before the apply rather than trusting this cell.

⁶ **These figures came from SQL, not from the scripts' own dry runs, and that is
a real difference.** SCRUM-392 asked for the dry runs. A dry run needs a Prisma
client pointed at production, which needs a connection string this repository
does not hold, and the one route that would produce one —
`pscale connect`, opening a local proxy — is denied against `main` by
`.claude/hooks/pscale-guard.sh`. So the queries under
[Re-checking without running the scripts](#re-checking-without-running-the-scripts)
were used instead, extended where a script's candidate set is narrower than its
predicate.

Where that could matter, and what was done about it:

- **`backfill-group-preferences`** is the case this file already warned about: it
  skips a row whose legacy value parses to nothing, so "rows matching" and "rows
  it would write" differ by design. Both were measured — 12 and 11 — rather than
  one standing in for the other.
- **`check-driverless-groups`** reports three categories, and the query here
  covers all three: 15 driverless, 3 empty, 0 solo. The old staging cell counted
  only what the script called a finding, which is the same total.
- **`check-profile-coordinates`** applies four conditions per row, and a row can
  match more than one; the cell is a distinct row count, not their sum. See
  footnote 1.
- **`cleanup-orphan-locations`, `check-self-requests`, `check-seat-counts`,
  `backfill-request-status`** each have one predicate and no separate candidate
  step, so the two cannot disagree.

The gap that remains is that nobody has watched these scripts run against
production. A predicate error shared between a script and the SQL written from it
would survive both. Treat the cells as measured rather than as verified, and run
the dry run before any `--apply`.

⁷ New in SCRUM-409, and it shares its predicate with `check-self-requests` —
`findSelfRequestIds`, imported rather than restated — so the two cannot disagree
about what a self-request is. The cell is therefore the same 2 rows that check
reports, seen from the side that would delete them.

**What those two rows hold**, measured read-only on 2026-09-09 as lengths rather
than content, because this is what `--apply` destroys:

|       | created    | status   | conversation | messages  | message length |
| ----- | ---------- | -------- | ------------ | --------- | -------------- |
| row 1 | 2026-02-18 | PENDING  | yes          | 1, unread | 3 characters   |
| row 2 | 2026-04-15 | ACCEPTED | yes          | 1, unread | 0 characters   |

Both messages were written the same day as their request, which is
`requests.create` storing its opening message, and both were written by the user
to themselves. So this deletes three characters of one person's own text and an
empty string — a different decision from `cleanup-orphan-conversations` and its
1,258 messages between two people, which is why the two are separate scripts
rather than one with a flag.

Neither row inflates the unread badge, despite both messages being unread:
`getUnreadMessageCount` filters `userId: { not: caller }`, so a message the
caller wrote is never counted. What they do reach is `requests.me`, which
returns the same row in **both** `sentRequests` and `receivedRequests` — so each
of these two users sees a request from themselves in both lists.

**Row 2 could not be cleared by its owner**, which is the reason a script exists
rather than a nudge. `requests.delete` refuses an ACCEPTED request when both
parties share a group, and for a self-request that compares a user against
themselves — it matched whenever they were in any group at all, and their group
is real and healthy: two members, one driver. The CONFLICT told them to leave a
carpool they are actually in before they could clear a request that is not.
SCRUM-409 exempts a self-request from that guard, so the row is clearable
through the product now as well as by this script.

### Production is readable, and now measured

**Every production cell above carries a figure, as of 2026-09-09.** Getting
there took correcting a claim this file made for nine days: that production row
data could not be read at all. That was the finding on 2026-08-31, recorded as a
flat `403 Permission denied`, and it holds only for the **PlanetScale MCP
server** — its token still refuses row data on the production branch while
returning schema metadata, so a column can be confirmed to exist but never
counted. The `pscale` **CLI** authenticates as a different identity, and that one
does read production:

```
pscale sql nucarpool main --org devashishsood18 --role reader \
  --format json --query "SELECT COUNT(*) FROM carpool_search"
```

`.claude/hooks/pscale-guard.sh` names that exact form as the sanctioned way to
read production, and denies the write roles, the local-proxy command and every
write shape aimed at the production branch. It is the route the SCRUM-380
measurement below used on 2026-09-09, and the route every production figure in
the table came from. `cleanup-orphan-conversations` was measured a different way
again — read-only through DBeaver on 2026-09-03 — and re-measured through this
route on 2026-09-09, to the same numbers.

**What the eight new figures changed.** Four cells that read `unknown` turned out
to be clean, and four did not:

| Script                                | production                                               | filed as                              |
| ------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `backfill-request-status`             | 0                                                        | —                                     |
| `check-seat-counts`                   | 0                                                        | —                                     |
| `cleanup-orphan-locations`            | 90 orphan `location` rows                                | no ticket; the script owns the repair |
| `check-self-requests`                 | 2 self-requests                                          | SCRUM-409                             |
| `check-driverless-groups`             | 15 driverless + 3 empty groups, 33 members stranded      | SCRUM-406                             |
| `check-profile-coordinates`           | 47 inverted co-op ranges on onboarded users, 40 `ACTIVE` | SCRUM-407                             |
| `repair-seat-residue`                 | 3 member-less groups, no bad seat row                    | SCRUM-406                             |
| `backfill-profile-picture-timestamps` | 4,322 of 4,323 null — an upper bound, not a count        | needs `s3:ListBucket`                 |

**Staging predicted none of it.** Its figures for those four are 0, 0, 1 and 2.
The 11-versus-620 gap on `cleanup-orphan-conversations` was already the standing
warning; the driverless-group row is the same lesson again, at 0 versus 15.

`backfill-profile-picture-timestamps` is the one row no database access settles.
Its question is "which users have an object in S3 but no timestamp", and no
amount of SQL answers the first half — see footnote 5. That row needs the
script's own dry run, run somewhere with `s3:ListBucket`.

**No production cell above is an open question any more**, which is the whole
point of this section — but four of them turned out to be a number rather than a
zero, and that is why the 11-versus-620 gap was worth taking seriously. A cell
that reads `0` now means the query was asked and answered on that date, not that
nobody looked.

### SCRUM-380 — driver seat counts on production, measured before the fix

Not a script, and deliberately recorded here anyway: SCRUM-380 made a read-only
production measurement a **blocking** acceptance criterion, for a reason that
generalises to any data defect fixed at the source. The profile form was
rewriting a full driver's `seats_avail` from `0` to `1` whenever the page
loaded, and the fix stops new rows being produced — but nothing records how an
existing `1` got there, so once the effect is gone an affected row is
indistinguishable from a driver who genuinely has one seat free. Measure first
or lose the population.

Taken on **2026-09-09** against PlanetScale `main` through the CLI reader role
above. Nothing was modified, and no repair was designed or run.

`carpool_search` rows with `role = 'DRIVER'`, by seat count and group membership:

| `seats_avail` | in a group | no group | total  |
| ------------- | ---------- | -------- | ------ |
| 0             | 12         | 21       | 33     |
| **1**         | **12**     | **30**   | **42** |
| 2             | 13         | 11       | 24     |
| 3             | 8          | 25       | 33     |
| 4             | 3          | 36       | 39     |
| 5             | 0          | 3        | 3      |
| 6             | 0          | 1        | 1      |

Group sizes for the grouped drivers at `0` and `1`, which is the second half of
what the ticket asked for:

| `seats_avail` | group members | of which riders | rows |
| ------------- | ------------- | --------------- | ---- |
| 0             | 2             | 1               | 5    |
| 0             | 3             | 2               | 4    |
| 0             | 4             | 3               | 1    |
| 0             | 5             | 4               | 2    |
| 1             | 2             | 1               | 7    |
| 1             | 3             | 2               | 4    |
| 1             | 5             | 4               | 1    |

**42 DRIVER rows sit at `1`, and that is an upper bound on the damage, not a
count of it.** It is the whole population the defect could have produced; a
driver who entered `1` and has never filled up is in it too. The measurement
cannot separate them, and this is the point the ticket makes about capacity
never being stored: for a grouped driver the implied original capacity is
`riders + seats_avail`, which for all twelve grouped rows at `1` comes to 2, 3
or 5 — every one inside `MAX_SEATS_AVAILABLE`, so no row is out of range and
none is self-evidently corrupt.

Two things worth reading off it anyway. **No production row is outside
`[0, 6]`** — the `-1` residue that SCRUM-348 found on staging has no counterpart
on `main`. And **six non-DRIVER rows carry a non-zero count** (one VIEWER at 2,
three at 3, two at 4), which is why the fix normalises `seatAvail` for every
non-driver at the submit boundary rather than only for `RIDER`: the load-time
effect it removes had been quietly doing that job.

**No repair is planned, and none should be written from these figures.**
Capacity is not stored, so the original value cannot be recovered, and inventing
one upward would over-subscribe a real car — the argument `seatIntegrity.ts`
already makes for clamping negatives to `0` rather than guessing. Any remedy is
a separate ticket and a product decision; the honest one is likely to ask
affected drivers to re-enter their seat count.

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

### Findings worth acting on

Four of these were known from staging. Four more came out of the 2026-09-09
production measurement and exist only there — numbered 5 to 8, each with its own
ticket, because filing rather than repairing is SCRUM-392's stated policy.

1. **`backfill-group-preferences` is not finished anywhere — 3 rows on staging
   and 12 on production**, confirmed by direct read rather than inferred. Not
   one of the fifteen is in the `GROUP_DETAILS_V1:` encoding; every one that
   holds anything holds plain text, which `parseGroupDetails` turns into notes.
   So the backfill would write all three on staging and eleven of the twelve on
   production, the twelfth being blank. This blocks dropping `carpool_search.group_message`
   (SCRUM-287), which is only safe once the backfill has been applied
   _everywhere_. While those rows exist, `resolveGroupDetails`'s legacy fallback
   is the only thing keeping their preferences readable, so dropping the column
   would lose data. **Production was the larger number, as it was for finding 4**
   — see footnote 4.
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
   conversation count and messages-per-conversation average permanently.
   **SCRUM-365 decided to retain them** and to revisit only if they cause a
   problem, so the dashboard distortion is accepted rather than tracked as a
   defect — see
   [the db README](../src/server/db/README.md#the-620-are-retained-by-decision).
   Should that be reversed, SCRUM-364 has since added `--limit` and
   `--older-than` so the population can be retired in tranches beneath the
   existing `--max` ceiling; raising `--max` past 620 is still not the intended
   route. Until then this row is a regression check, not a queue. **Re-measured
   on 2026-09-09 through the CLI reader route: still exactly 620 and 1,258, so
   the regression check passes.**
5. **15 of 66 production groups have no driver, and 33 members are in one.**
   Staging has none, so this has never been seen before. The group cannot be
   dissolved, handed over or added to by anyone, because the driver is the only
   member with group management. Both causes are fixed and neither was
   retroactive — SCRUM-289 and SCRUM-291. **No repair is obviously correct**,
   which is why `check-driverless-groups` ships without an `--apply`: promoting a
   member puts someone in charge of a car they may not own, and dissolving
   removes a carpool people may still be using. **SCRUM-406.** The 3 empty groups
   in the same count are the easy half — nothing points at them.
6. **47 production searches store a co-op range that ends before it starts, 40 of
   them `ACTIVE`.** Every one belongs to an onboarded user. The matching query
   asks for an overlapping window, which an inverted range satisfies for nobody,
   so those users see an empty map and appear on nobody else's — with no error
   and no log line. SCRUM-302 added the validation and was not retroactive.
   **SCRUM-407**, and **the repair policy is decided: ask, do not guess.**

   Swapping the two dates is the obvious repair and it is a guess. An inverted
   pair says the user's intent was not recorded correctly; it does not say
   _which_ of the two values is wrong. Swapping asserts both are right and only
   the order is wrong — plausible, unverifiable, and it would write 47 rows of
   invented intent that then look exactly like values a user chose. So there is
   **no repair script for this row, deliberately**, and none should be added.

   What SCRUM-407 shipped instead: the profile page detects an inverted stored
   range **on load**, routes to the Account tab, flags the end-date field and
   raises a non-dismissing toast naming the consequence. The machinery to show
   it already existed — `AccountSection` renders the error and `onError` routes
   a failed save — but the form is `mode: "onChange"` and never validated on
   mount, so nothing surfaced until the user changed a field or pressed Save.
   Neither is likely when the only symptom is an empty map.

   **This does not clear the 47**, and the cell above will keep reporting them.
   It converts a silent defect into a visible one for each user who opens their
   profile, and a user who never returns keeps their row. That is the accepted
   trade: a stale row costs nobody anything, and a fabricated one is a value the
   product will treat as real. Re-measure rather than assuming a trend.

7. **`check-profile-coordinates` reports 626 rows on production and 521 on
   staging, of which 47 and 0 are actionable.** It flags `(0, 0)` coordinates on
   any non-`VIEWER` search without asking whether the user finished onboarding,
   so abandoned sign-ups dominate the output and the script's exit code is
   permanently `1` — a gate that gates nothing. This is also what made footnote 1
   and this table wrong about staging for nine days. **SCRUM-408.**
8. **2 production `request` rows have the same user on both ends.** Residue from
   before `requests.create` grew its explicit self-request guard; the ordinary
   duplicate check cannot catch one, because both halves of its `OR` match the
   same row. **SCRUM-409**, and now characterised: each carries a conversation
   holding one unread message the user wrote to themselves, three characters in
   one and empty in the other. `cleanup-self-requests.ts` is the repair and has
   not been run. The finding worth carrying forward is the second one — the
   ACCEPTED row was **unclearable by its owner**, because `requests.delete`'s
   same-group guard compares a user against themselves. See footnote 7.

**And one production figure that needed no ticket: 90 orphan `location` rows.**
`cleanup-orphan-locations` already owns that repair, its dry run is the next
step, and the run-state row above is the record. Staging has none.

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

-- check-self-requests, and cleanup-self-requests: the same predicate
SELECT COUNT(*) FROM request WHERE fromUserId = toUserId;

-- what deleting them would take with it, without reading any message content
SELECT COUNT(*) FROM message m
JOIN conversation c ON c.id = m.conversationId
JOIN request r ON r.id = c.requestId
WHERE r.fromUserId = r.toUserId;

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
