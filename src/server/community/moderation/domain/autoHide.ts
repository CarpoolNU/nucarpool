/**
 * When enough reports hide a target before any moderator has looked at it.
 *
 * **Auto-hide is what makes a report useful before a moderator arrives**
 * (spec §8.3). The community is small and a moderator is a person with another
 * job, so the queue can sit for a day. Without a mechanical response, a post
 * that several members independently found harassing stays up for that whole
 * day; with one, it comes down when the third of them reports it and a human
 * decides afterwards. Hiding is reversible (`hiddenAt` is set, the row is
 * kept), which is what makes acting on an unreviewed signal acceptable.
 */

/**
 * How many distinct reporters with an open report hide a target.
 *
 * **This is an assumption, on the same footing as the rate limits** — there is
 * no traffic yet to say whether three is too eager or too slow for a community
 * this size. It is recorded here, next to the value, so that tuning it is the
 * one-line edit it should be: change this number and the rule, its tests and
 * every caller follow.
 */
export const COMMUNITY_AUTOHIDE_REPORTERS = 3;

/**
 * Whether the current reports on one target are enough to hide it.
 *
 * **`hasDismissedReport` vetoes the threshold.** Once a moderator has cleared a
 * target, a human has looked at it and decided it stays up. Three coordinated
 * reporters must not be able to override that decision by filing again, and
 * the human has no stronger move available to make it stick — a dismissal is
 * already the strongest thing a moderator can say about a report. So the
 * dismissal is final as far as the automatic rule goes; a moderator can still
 * hide the target by hand.
 *
 * **The veto is reachable because a dismissal restores.** While auto-hide was
 * permanent, a `DISMISS` on an already-hidden target left the content down, so
 * the veto only ever ran before a hide and the reporters outranked the
 * moderator. `ModerationService.review` now restores such a target, which
 * leaves the dismissed report on it, and from then on this rule keeps the same
 * or new reporters from hiding it again.
 */
export const shouldAutoHide = (counts: {
  distinctOpenReporters: number;
  hasDismissedReport: boolean;
}): boolean =>
  !counts.hasDismissedReport &&
  counts.distinctOpenReporters >= COMMUNITY_AUTOHIDE_REPORTERS;
