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

## Why the full version of option (a) is not built

**There is no durable record that two users carpooled.** Membership lives
only in `CarpoolSearch.carpoolId`, a nullable foreign key, and every trace of
a pairing — the `CarpoolGroup` row, the carpool id, the request, the
conversation and its messages — is removed at the moment the pairing ends.
`requests.delete` refuses to delete an `ACCEPTED` request only while both
users are still in the same group; once they part, either party can erase it
unilaterally. So a `Feedback` model with a foreign key to a group or request
would reference a row likely to be gone before feedback is even submitted.

Building the full version means the feedback row becomes the durable record
itself, written at the moment of parting inside `groups.ts`'s teardown
transactions, carrying a denormalised rater id, subject id, and a pairing
identifier minted at that moment. That's a real schema change (migration and
deploy request) plus writes added to three already-sensitive transactions —
for a feature that, at the observed rate of carpool formation, would collect
a handful of data points a month. Not worth it yet.

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

If this proves too weak, the durable pairing record above is the prerequisite
for building the real thing — not the `Feedback` model itself.

## Open questions

Unanswered on purpose; for whoever picks this up next:

- Is a durable pairing record worth having independent of feedback? The admin
  dashboard currently can't answer "how many carpools has this app ever
  formed" — only how many exist right now.
- What's the retention period for feedback about a person, with no route for
  them to see or contest it?
- `adminRouter` admits both `ADMIN` and `MANAGER` — is that the right
  audience for feedback this identifiable?
