import { useCallback, useEffect, useState } from "react";

/**
 * Whether this reader has dismissed the rider-demand notice.
 *
 * ## Why `localStorage` and not a column on `User`
 *
 * `User.tutorialCompleted` is the obvious precedent and would give a stronger
 * guarantee — a dismissal that follows the account to every device. It is not
 * what this uses, because SCRUM-638 records `Schema change: NO` in its
 * Database Risk section, and a column here is not a small exception to that: a
 * schema change on this project is a committed migration *plus* a
 * `prisma db push` to staging *plus* a human-owned Deploy Request into
 * production, which is three environments and a merge gate for a preference
 * about whether a sentence is painted.
 *
 * **State the limitation rather than imply it away.** A dismissal made on a
 * laptop does not reach the same person's phone, and clearing site data or
 * browsing privately forgets it. The acceptance criterion is "a user who
 * declines is not asked again on every load", and this satisfies that on the
 * device where they declined. If the Mixpanel measurement shows people
 * dismissing repeatedly across devices, that is the evidence for promoting
 * this to a column, and the interface below would not change.
 *
 * ## Why every access is wrapped
 *
 * `localStorage` is not reliably present. It throws on access in some
 * configurations, is empty in a private window, and does not exist at all in
 * the jsdom-free Node project or during server rendering. The contract here is
 * that a storage failure renders the notice — the visible state, not the
 * hidden one — because a reader who has never dismissed anything and sees
 * nothing has silently lost the feature, while a reader whose dismissal was
 * forgotten merely sees it again.
 *
 * ## Why the first render is always "not dismissed"
 *
 * The stored value is read in an effect rather than in `useState`'s
 * initialiser. Next.js renders this component on the server, where
 * `localStorage` does not exist, so an initialiser reading it would either
 * throw or produce markup that disagrees with the client's first paint —
 * React's hydration mismatch. Reading it after mount costs one frame in which
 * a dismissed notice could flash; `hasLoaded` is what the component uses to
 * render nothing until the answer is known, so that frame shows nothing
 * rather than the wrong thing.
 */

/**
 * The storage key.
 *
 * Namespaced with the feature rather than a bare `dismissed`, because this
 * origin is shared with every other thing the app might store, and a key
 * collision would be silent in both directions.
 *
 * **Deliberately not namespaced by user id.** It would be more correct — two
 * accounts on one browser share this flag — and it would mean writing a user
 * id into `localStorage`, which is a durable identifier sitting on a possibly
 * shared machine for the sake of a preference about a sentence. The sharing is
 * the lesser cost, and it is the same trade `persistence: "localStorage"`
 * already makes for the Mixpanel distinct id.
 */
export const RIDER_DEMAND_DISMISSED_KEY =
  "nucarpool.riderDemandNotice.dismissed";

/** The stored value. Presence is the signal; this is what presence looks like. */
const DISMISSED_VALUE = "1";

/**
 * Whether the stored flag says dismissed. `false` whenever storage cannot be
 * read, per the contract above.
 */
export const readDismissed = (): boolean => {
  try {
    return (
      window.localStorage.getItem(RIDER_DEMAND_DISMISSED_KEY) ===
      DISMISSED_VALUE
    );
  } catch {
    return false;
  }
};

/**
 * Record the dismissal. Silent on failure: the caller has already hidden the
 * notice for this session, and a storage error is not something the reader can
 * act on.
 */
export const writeDismissed = (): void => {
  try {
    window.localStorage.setItem(RIDER_DEMAND_DISMISSED_KEY, DISMISSED_VALUE);
  } catch {
    // Private browsing, blocked site data, or a quota that is already full.
  }
};

export type RiderDemandDismissal = {
  /** True once the stored answer is known. Nothing renders before it. */
  hasLoaded: boolean;
  dismissed: boolean;
  dismiss: () => void;
};

/**
 * The dismissal as a hook, so both surfaces share one flag and one key.
 *
 * `dismiss` sets the state before writing, so the notice disappears on the
 * click rather than on the storage round trip — and still disappears when the
 * write throws.
 */
export const useRiderDemandDismissal = (): RiderDemandDismissal => {
  const [dismissed, setDismissed] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
    setHasLoaded(true);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed();
  }, []);

  return { hasLoaded, dismissed, dismiss };
};
