# Product decision: post-match feedback

**Status:** decision record. No production code changes.

Whether to collect a trust signal after a carpool pairing ends, and if so,
what shape: **(a)** a private thumbs-up/thumbs-down per completed membership,
visible only to admins, or **(b)** a star rating shown to future prospective
matches.

**Decision: option (a) in principle, not the full version, and option (b) is
rejected outright.** See [What shipped](#what-shipped) for what actually
exists today.

## Why option (b) is rejected

Group sizes in production are small — most carpools have exactly one other
member. A user shown any feedback at all about themselves — a count, an
average, even the bare fact that feedback exists — can identify who left it.
Aggregation cannot fix this because there is nothing to aggregate over, so
option (b)'s premise (a visible rating) is incompatible with anonymity at this
scale. A retaliatory rating would also be a user's entire public record with
no volume of later ratings to dilute it. Rejected, not deferred.

## Why the full version of option (a) was not built

> **Superseded in part, 2026-10-14.** The blocker below — that nothing records
> who carpooled — no longer holds. SCRUM-636 shipped `CarpoolPairing`, so the
> prerequisite this section says is missing now exists. See
> [What the pairing record changes](#what-the-pairing-record-changes). The rest
> of the reasoning, including everything about option (b), still stands.

**There was no durable record that two users carpooled.** Membership lives
only in `CarpoolSearch.carpoolId`, a nullable foreign key, and every trace of
a pairing — the `CarpoolGroup` row, the carpool id, the request, the
conversation and its messages — is removed at the moment the pairing ends.
`requests.delete` refuses to delete an `ACCEPTED` request only while both
users are still in the same group; once they part, either party can erase it
unilaterally. So a `Feedback` model with a foreign key to a group or request
would reference a row likely to be gone before feedback is even submitted.

Building the full version meant the feedback row becoming the durable record
itself, written at the moment of parting inside `groups.ts`'s teardown
transactions, carrying a denormalised rater id, subject id, and a pairing
identifier minted at that moment. That's a real schema change (migration and
deploy request) plus writes added to already-sensitive transactions — for a
feature that, at the observed rate of carpool formation, would collect a
handful of data points a month. Not worth it yet, and the conclusion holds
even now that the schema change has been made for other reasons.

## What the pairing record changes

SCRUM-636 built the durable record as its own concept rather than as a side
effect of feedback, because three separate pieces of work had each stalled on
it. `CarpoolPairing` carries both user ids denormalised, the group id as the
pairing identifier, who drove, and when the pairing formed and ended;
[the database README](../../src/server/db/README.md#carpool-pairings) is
authoritative for its behaviour.

So the prerequisite is met, and what is left for feedback is smaller than this
document assumed — a `Feedback` model keyed on a pairing rather than a
feedback model that _is_ the pairing. Three things changed:

- **A feedback row can reference a pairing**, which is not deleted when the
  group, request and conversation are. It no longer has to be written inside
  the teardown transaction, and so no longer adds a write to a path where a
  failure could trap someone in a group.
- **A once-per-pairing limit is now expressible**, which is the thing the
  shipped version explicitly gives up.
- **Someone who was removed, or left behind when a group dissolved, can be
  reached** — they have a pairing row even though they took no action, and the
  shipped version only prompts whoever pressed the button.

What has **not** changed is the reason option (b) is rejected, and it is worth
being clear that the pairing record does not soften it: group sizes are still
small, so feedback about a person is still identifiable by construction. The
record makes the _mechanism_ cheaper, not the privacy question easier.

It also brings a constraint of its own. Pairings are retained for twelve
months from `endedAt` and then deleted. Feedback keyed on a pairing either
expires with it or outlives the thing it refers to, and that is a decision to
make before building, not after.

## What shipped

A lighter version: every success toast from `useGroupMembership` (someone
leaves, is removed, or the group dissolves) carries a link to the existing
Jira feedback form, the same one the Feedback button in `DropDownMenu` opens.
Both entry points share `FEEDBACK_FORM_URL` in
[`src/utils/feedbackForm.ts`](../../src/utils/feedbackForm.ts) so replacing
the form can't update one and strand the other.

- **Admin-only holds by construction.** Submissions land in Jira; nothing in
  the app reads them back, so there's no badge, count or ranking input that
  could ever reveal feedback to the person it's about.
- **What this gives up** versus the full model: no once-per-pairing limit,
  no session-verified rater, no link from a submission to a specific pairing,
  and it only reaches the member who took the action — someone removed from a
  group, or left behind when it dissolves, gets no prompt.

If this proves too weak, the durable pairing record is the prerequisite for
building the real thing — not the `Feedback` model itself. That prerequisite
now exists, so "the pairing record does not exist" is no longer a reason to
defer; the volume argument and the privacy question are.

## Open questions

Unanswered on purpose; for whoever picks this up next:

- ~~Is a durable pairing record worth having independent of feedback?~~
  **Answered: yes.** SCRUM-636 built it on exactly that basis. The admin
  dashboard still cannot answer "how many carpools has this app ever formed",
  because nothing reads the new rows yet — but the rows are now being written,
  so the question is a query away rather than a schema change away. Note that
  the count only begins from the day SCRUM-636 shipped; pairings that ended
  before it are unrecoverable.
- What's the retention period for feedback about a person, with no route for
  them to see or contest it? Pairings settled on twelve months from `endedAt`;
  feedback keyed on one has to decide whether it expires with the pairing.
- `adminRouter` admits both `ADMIN` and `MANAGER` — is that the right
  audience for feedback this identifiable?
