import React, { useEffect, useRef } from "react";
import { IoClose } from "react-icons/io5";
import {
  trackRiderDemandDismissed,
  trackRiderDemandShown,
} from "../utils/mixpanel";
import { useRiderDemandDismissal } from "../utils/riderDemand/dismissal";
import { riderDemandToDisplay } from "../utils/riderDemand/floor";
import useIsMobile from "../utils/useIsMobile";
import { useHasBeenSeen } from "../utils/useHasBeenSeen";

/**
 * "N riders want a route like yours." The user-facing half of SCRUM-638.
 *
 * Driver supply is the platform's binding constraint — 266 live riders to 22
 * live drivers when it was last measured — and the only people who can
 * resolve it are riders who own a car and have never been told they are
 * needed. The admin dashboards have carried this number since SCRUM-599; this
 * is the first time a user sees it.
 *
 * ## A count, and nothing else
 *
 * No names, no photographs, no pins, no "including someone from your
 * company". `utils/riderDemand/floor.ts` carries the reasoning, including why
 * a VIEWER is the role the floor exists for.
 *
 * **The floor is applied here as well as on the server, and that is not a
 * second opinion — it is the same one, imported.** `riderDemandToDisplay` is
 * a shared function rather than a number copied into two places, so the two
 * layers cannot disagree. The server's application is the one that matters,
 * because it is what keeps a suppressed count off the wire; this one exists
 * because the component takes a plain `number` and nothing in its type stops
 * a future caller handing it a raw one. Without it, such a caller would
 * render "There are 0 riders you could carpool with" — the dead end this
 * feature exists to replace, with extra steps — and the first person to see
 * it would be a user. The same belt-and-braces reasoning `viewerAccess.ts`
 * records for `roleFetchesRecommendations`.
 *
 * ## The copy, and the thing it must not say
 *
 * The ticket's own warning is that this "needs care not to read as 'this
 * product does not work'". On the empty-recommendations surface the reader has
 * just been told nobody is available, so a sentence that leads with unmet
 * demand lands as a second failure. The copy therefore leads with the reader's
 * own capability — what *they* could do — and states the number as the reason,
 * not as the headline. It never phrases the count as people waiting *on them*,
 * which would be a claim about strangers' expectations that nobody made.
 *
 * The word is "could", not "would": the number is how many riders this reader
 * is compatible with, not how many would accept. Promising the second is a
 * promise the matching system cannot keep.
 */

/** Which of the two placements this instance is, for the Mixpanel breakdown. */
export type RiderDemandSurface = "empty-recommendations" | "profile-role";

type RiderDemandNoticeProps = {
  /** The floored count from the server. `null` or `undefined` renders nothing. */
  count: number | null | undefined;
  /** The reader's role, for the event breakdown only. Never rendered. */
  role: string | undefined;
  surface: RiderDemandSurface;
  className?: string;
};

/**
 * The sentence, built from the count.
 *
 * Split out so the pluralisation is one expression rather than a ternary
 * buried in JSX. The floor is 3, so the singular arm is unreachable today —
 * it is written anyway, because the floor is a constant someone may lower and
 * "1 riders" is exactly the kind of thing that ships when the guard was an
 * assumption about another file's value.
 */
const demandSentence = (count: number): string =>
  count === 1
    ? "There is 1 rider you could carpool with on a route like yours."
    : `There are ${count} riders you could carpool with on a route like yours.`;

export const RiderDemandNotice = ({
  count,
  role,
  surface,
  className = "",
}: RiderDemandNoticeProps) => {
  const { hasLoaded, dismissed, dismiss } = useRiderDemandDismissal();

  /**
   * Which layout the reader is in, for the event breakdown only — never for
   * rendering, which this component leaves entirely to its `className` and to
   * whatever box it is placed in.
   *
   * From `useIsMobile` so it shares its breakpoint with the `desktop:` screen
   * through `utils/breakpoints.js`. A width read and compared here would be a
   * second definition of the same boundary, free to drift from the one the
   * layout actually switches on.
   */
  const viewport = useIsMobile() ? "mobile" : "desktop";

  /**
   * Whether anyone has actually looked at this.
   *
   * **Mounting is not an impression**, and on the explore page the gap is
   * wide: the mobile sheet renders every detent as a class on a wrapper that
   * never unmounts its children, so this component is mounted and its effects
   * run while the sheet is `display: none` or collapsed to zero height. The
   * observer is the only thing that can tell those apart from a notice on
   * screen — see `utils/useHasBeenSeen.ts`, including why it fails open.
   */
  const { ref: noticeRef, hasBeenSeen } = useHasBeenSeen<HTMLDivElement>();

  /** The count as it may be shown, re-floored. `null` renders nothing. */
  const shown = typeof count === "number" ? riderDemandToDisplay(count) : null;

  /**
   * The count already reported, so a re-render cannot repeat the event.
   *
   * A ref per component instance rather than a flag, for the reason
   * `useRecommendationsLoadedEvent` uses one: StrictMode double-invokes
   * effects, and a module-level guard would also suppress the second surface.
   * Keyed on the count so a genuinely different number re-emits.
   */
  const reportedCount = useRef<number | null>(null);

  const visible = hasLoaded && !dismissed && shown !== null;

  useEffect(() => {
    if (!visible || shown === null) {
      return;
    }
    /* The gate. Everything above is about whether there is a notice to show;
       this is about whether it reached anyone. It latches, so this effect can
       depend on it without re-firing when the notice scrolls back off. */
    if (!hasBeenSeen) {
      return;
    }
    if (reportedCount.current === shown) {
      return;
    }
    reportedCount.current = shown;
    trackRiderDemandShown({
      count: shown,
      role: role ?? "",
      surface,
      viewport,
    });
  }, [visible, hasBeenSeen, shown, role, surface, viewport]);

  // After the hooks, never before: an early return above them would change
  // the hook order between the pre-load and post-load renders.
  if (!visible || shown === null) {
    return null;
  }

  const onDismiss = () => {
    trackRiderDemandDismissed({
      count: shown,
      role: role ?? "",
      surface,
      viewport,
    });
    dismiss();
  };

  return (
    <div
      ref={noticeRef}
      // `status` rather than `alert`: this is informational and must not
      // interrupt a screen reader mid-sentence. The region is labelled so the
      // dismiss button has something to belong to.
      role="status"
      aria-label="Carpool demand on your route"
      className={`border-northeastern-red/30 relative rounded-xl border bg-stone-50 p-4 text-left ${className}`}
    >
      {/* `pr-8` keeps the sentence clear of the dismiss button, which is
          absolutely positioned so that a long wrap does not push it off the
          card's top-right corner. */}
      <p className="font-montserrat pr-8 text-base font-normal">
        {demandSentence(shown)}{" "}
        <span className="font-semibold">
          Switching to Driver in your profile would show them to you.
        </span>
      </p>
      <button
        type="button"
        // Explicitly `button`: on the profile surface this renders inside the
        // profile `<form>`, where a button with no type submits it — which
        // would save the user's profile as a side effect of dismissing a
        // notice.
        onClick={onDismiss}
        aria-label="Dismiss carpool demand notice"
        className="absolute top-2 right-2 rounded-full p-1 text-stone-500 hover:bg-stone-200 hover:text-black"
      >
        <IoClose className="text-xl" aria-hidden="true" />
      </button>
    </div>
  );
};

export default RiderDemandNotice;
