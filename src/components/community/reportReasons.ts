import type { ReportReason } from "../../server/community/moderation/public";

/**
 * What a reporter reads for each reason.
 *
 * **`satisfies Record<ReportReason, string>` is what keeps the picker and the
 * procedure from drifting, in both directions.** A `Record` over the union
 * demands every member and permits no other, so a reason *added* to the enum
 * fails the compile here until it has a label, and one renamed or removed fails
 * it too. A list typed `ReadonlyArray<{ value: ReportReason }>` would catch
 * only the second: it accepts any subset, so a new reason would simply never be
 * offered and nothing would go red.
 *
 * **Key order is the display order, and `OTHER` is last** so it reads as the
 * fallback and not the first thing a reporter is offered; a list that opened
 * with it would invite a free-text report where a specific reason would give a
 * moderator more to go on. (String keys that are not integer-like are kept in
 * insertion order, which is what the derivation below relies on, and the test
 * beside this file pins it.) What the guard cannot catch is a new reason added
 * *after* `OTHER` by mistake, which would demote the fallback from last; the
 * test does.
 *
 * Lives apart from `reportDialog.tsx` because Jest matches `.ts` only, and a
 * list worth pinning should not have to be pinned through a component.
 */
const LABELS = {
  HARASSMENT: "Harassment or bullying",
  SPAM: "Spam or advertising",
  MISINFORMATION: "Misleading or false",
  OFF_TOPIC: "Off topic",
  SAFETY_CONCERN: "Safety concern",
  OTHER: "Something else",
} satisfies Record<ReportReason, string>;

export const REPORT_REASONS: ReadonlyArray<{
  value: ReportReason;
  label: string;
}> = (Object.keys(LABELS) as ReportReason[]).map((value) => ({
  value,
  label: LABELS[value],
}));
