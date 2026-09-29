# Decision: what "recently active" means on the admin dashboard

**Status:** decision record (SCRUM-601, phase 3 of SCRUM-598). No production
code changes.

Whether an admin chart of real user activity should be **(a)** inferred from
`Session.expires`, labelled approximate, or **(b)** backed by a new
`lastSeenAt` column.

**Decision: option (a), as a snapshot rather than a time series, defined as
"last seen", not "signed in".** Option (b) is not built now. See
[What would change this](#what-would-change-this).

## What `Session.expires` actually encodes

The ticket assumed a sign-in time could be recovered as `expires` minus the
session lifetime. The arithmetic is right; the name is wrong. It recovers the
time the session was **last refreshed**, which is a better signal than a
sign-in time, and is what the metric should be called.

Read from `next-auth` 4.24.15, the installed version, not assumed:

- `authOptions` in [`[...nextauth].ts`](../../src/pages/api/auth/%5B...nextauth%5D.ts)
  sets no `session` block, so it takes NextAuth's defaults. An adapter is
  configured and `strategy` is not overridden, so sessions are database rows.
  `core/init.js` sets **`maxAge` to 30 days** and **`updateAge` to 24 hours**.
- `core/routes/session.js` refreshes on read: once a session's last refresh is
  more than `updateAge` old, `updateSession` moves `expires` to now plus
  `maxAge`. Below that age it writes nothing.
- [`createContext`](../../src/server/router/context.ts) calls `getServerSession`,
  which runs that same route, on **every tRPC request**. Any authenticated
  request can therefore refresh a session, not just a sign-in.

So `expires − maxAge` is the time of the user's last authenticated request,
**rounded down by up to 24 hours**. A user who returns every day reads as seen
within a day; one who signed in once and went quiet reads as seen at sign-in.

## Definition

> A user's **last seen** time is `MAX(expires) − maxAge` over their `Session`
> rows, accurate to within `updateAge` (24 hours).

`MAX` because a user with two devices has two rows, and the newest is the one
that says when they were last here.

## Consequences the chart must respect

- **It is a snapshot.** Only current rows exist, so there is no way to say how
  many users were active in an earlier week. That is the same limit the growth
  chart already documents in
  [`adminDataUtils.ts`](../../src/server/adminDataUtils.ts) — drawing a past
  week from today's state would be wrong. Build **buckets by age of last seen**
  (for example under 1 day, 1–7, 7–14, 14–30 days), not a line over time.
- **Bucket edges are fuzzy by a day.** Do not present a count as exact at a
  boundary. The label says approximate, and the table view gives the same
  numbers as the chart.
- **A window of 30 days is not an independent measure.** With `maxAge` at 30
  days, "seen in the last 30 days" is exactly "has an unexpired session". It is
  a useful headline and the figure SCRUM-547 measured, but it is a restatement
  of the session's lifetime, not evidence of engagement.
- **Anything longer than 30 days is unverified.** NextAuth deletes an expired
  row only when someone presents that token (`core/routes/session.js`, the
  `expires < Date.now()` branch). A row that lapses and is never presented
  again should persist, so older windows may be answerable — but **no query
  has confirmed how many lapsed rows exist**, and nothing in this repo prunes
  them. Do not promise a window beyond 30 days until that is measured.
- **Sign-out removes the row.** A user who signs out drops out of the count
  until they return. It undercounts, and cannot overcount.
- **The query and the config must not drift.** If `maxAge` changes, every
  inferred time shifts by the difference. When this is built, set
  `session: { maxAge }` explicitly in `authOptions` from one exported constant
  and have the query import it, so the number is read from config in fact and
  not only in this document.

## Why not (b)

`lastSeenAt` would be exact-to-the-write and survive sign-out, but:

- It is a schema change, so a migration **and** a PlanetScale `db push` to
  staging plus a Deploy Request to `main` — two separate things, the second
  human-only. This is a chart, not a product requirement.
- It is true only going forward. Nothing backfills it, so the chart is empty
  on day one and the 363-user figure could not be reconciled against it.
- It needs a write throttle, or every request writes a row. NextAuth's
  `updateAge` is that throttle already, which is much of what (a) reuses.

## What would change this

Revisit (b) if the team wants **history** — activity by week over time — since
that is the one thing (a) cannot give. The lighter route to history is a daily
job snapshotting the (a) bucket counts, which needs a table but no per-user
tracking.

## Not verified here

The ticket's acceptance criterion says the chart must **reconcile with
SCRUM-547's 363** for the same window. That could not be checked in this
session:

- The repo holds no record of how 363 was derived.
- The read against `main` failed (`pscale` returned HTTP 401,
  `invalid_token`), so no live row counts were taken.

When (a) is built, that figure is a test: distinct users with `expires > NOW()`
must equal the 30-day bucket total. The row counts worth measuring first,
aggregates only, no identifiers:

```sql
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT user_id) AS distinct_users,
       SUM(expires > NOW()) AS unexpired_rows,
       COUNT(DISTINCT CASE WHEN expires > NOW() THEN user_id END) AS users_unexpired,
       SUM(expires <= NOW()) AS lapsed_rows,
       MIN(expires) AS oldest_expires
FROM session;
```

`lapsed_rows` decides whether a window beyond 30 days is possible.

## If (a) is built

- **Unit:** the age-bucket arithmetic at each edge, at exactly `updateAge`, and
  at exactly `maxAge`.
- **Database suite:** a `Session` row on each side of every bucket edge, a user
  with two sessions counted once by their newest, and a user with none.
- **UI:** an "approximate" label and a table view carrying the same figures.
