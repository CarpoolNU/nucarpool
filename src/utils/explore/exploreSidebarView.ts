/**
 * Which of its six states the explore page's sidebar is in.
 *
 * Extracted from `index.tsx` so the sidebar's visibility has **one** owner
 * rather than several mechanisms writing the same DOM node's class list
 * independently - a `className` template literal alongside imperative
 * `classList` calls, say. That split is fragile in a way that is easy to
 * miss: React assigns the whole `class` attribute when its computed value
 * changes rather than merging it, so any re-render that touches the
 * className can silently undo a class an imperative call added, and an
 * effect has no reason to re-apply it if the state it depends on has not
 * itself changed.
 *
 * The fix is not a better effect, it is having one owner: the state goes in,
 * a view comes out, and the page maps that view to classes React alone writes.
 *
 * **This returns a view, not a `className`.** The precedence between the
 * states is what was broken and is what deserves a test; the classes that
 * express them are presentation. A test pinning `"bottom-mobile-nav
 * h-mobile-sheet"` would fail on any restyle while proving nothing about the
 * bug, and the union gives the page exhaustiveness checking for free.
 *
 * It also keeps to the existing convention that Tailwind classes sit with the
 * markup - no file under `src/utils/` names one. That is a convention and not
 * a constraint: Tailwind v4 scans the whole repository minus `.gitignore`, so a
 * class named here would in fact be emitted; nothing in `tailwind.config.js`
 * restricts the scan to specific files or directories. Verified by building
 * with a probe class in this directory rather than inferred from the config.
 *
 * Same shape as `nav/mobileNavPlan.ts` and `map/viewRoutePlan.ts`, and for the
 * same reason: `index.tsx` is ~918 lines behind Mapbox,
 * NextAuth and a dozen tRPC queries, so a rule living inside it is a rule
 * nothing checks.
 */

import type { SheetDetent } from "./sheetDetents";

/**
 * `hidden` and `collapsed` are **not** the same thing, which is half of why
 * this was confusing to read in place. `hidden` is Tailwind's `display: none` -
 * the sheet leaves layout entirely, which is what it must do to stop covering
 * an open conversation. `collapsed` keeps the box and animates it to zero
 * height (`h-0 opacity-0 pointer-events-none`), which is what the collapse
 * handle wants. Naming them separately is what stops the next reader assuming
 * one can stand in for the other.
 */
export type ExploreSidebarView =
  /** Not mobile. A static column in the flow; none of the states below apply. */
  | "desktop"
  /** A conversation is open. Out of layout, so the message panel is reachable. */
  | "hidden"
  /** One card's details, in a short fixed-height sheet. */
  | "detail"
  /** Collapsed by the handle: still in layout, animated to nothing. */
  | "collapsed"
  /**
   * Half the expanded height. The detent a drag can land on, and the reason
   * the handle's gesture is worth more than a slow tap - with only the two
   * states either side of this one, every release gave you what a tap already
   * gave you. Nothing but a drag produces it: a tap goes straight between
   * `collapsed` and `expanded`, as it always did.
   */
  | "half"
  /** The full list sheet, the mobile default. */
  | "expanded";

/**
 * @param isMobile from `useIsMobile`, which shares its breakpoint with the
 *   `desktop:` screen via `utils/breakpoints.js`
 * @param hasOpenConversation whether the message panel is up - `selectedUser`
 *   in the page. This is the input the imperative `classList` calls existed to
 *   serve and the only one this ticket adds to the `className`'s own inputs.
 * @param isDetailOpen whether a single card's details are showing -
 *   `mobileSelectedUserID`
 * @param detent where the sheet is resting - `sheetDetent` in the page, which
 *   a tap toggles and a drag snaps. The three detents are also three of this
 *   function's views, so the last line returns it unchanged; that identity is
 *   what keeps `MOBILE_SIDEBAR_CLASSES` exhaustive, since a detent added
 *   without classes to render it stops the page compiling.
 */
export function planExploreSidebar({
  isMobile,
  hasOpenConversation,
  isDetailOpen,
  detent,
}: {
  isMobile: boolean;
  hasOpenConversation: boolean;
  isDetailOpen: boolean;
  detent: SheetDetent;
}): ExploreSidebarView {
  // Desktop first, so every branch below is mobile-only. Checking it once
  // here keeps every mobile-only branch under it; duplicating this check per
  // branch would only need to go wrong in one place to leak into the desktop
  // layout.
  if (!isMobile) {
    return "desktop";
  }

  // Highest precedence: an open conversation hides the sidebar outright,
  // regardless of any other state below.
  if (hasOpenConversation) {
    return "hidden";
  }

  // Checked before the detent: opening a detail view also sets the detent to
  // `expanded`, so the two rarely coincide - but when they do, the details
  // are what the user just asked for.
  if (isDetailOpen) {
    return "detail";
  }

  // The detents *are* views, one for one, so there is no mapping to get wrong
  // here.
  return detent;
}

/**
 * The three views that are detents, keyed so that adding a `SheetDetent`
 * without listing it here is a type error rather than a detent the drag
 * quietly refuses to work in.
 */
const DETENT_VIEWS: Record<SheetDetent, true> = {
  collapsed: true,
  half: true,
  expanded: true,
};

/**
 * Whether the sheet is resting at a detent, which is both when the drag handle
 * is rendered and when a drag may begin.
 *
 * **One rule rather than two.** The render condition and `useSheetDrag`'s own
 * precondition - that an expanded render has already been measured - need to
 * be the exact same statement, or the handle can render in a state the drag
 * refuses to start in.
 *
 * The other two views are excluded for reasons that are permanent, not
 * incidental. `hidden` is `display: none`, so there is no sheet to drag and no
 * geometry to read. `detail` is a *different* sheet — a fixed 320px capped at
 * `60dvh` — pinned to the same bottom edge, so the expanded range derived from
 * that edge would be several times its height and a drag would resize it to
 * something the view does not have classes for.
 */
export const isSheetDetentView = (
  view: ExploreSidebarView,
): view is SheetDetent => view in DETENT_VIEWS;

/**
 * The expanded card, as every consumer should read it.
 *
 * `index.tsx` holds one piece of state for "a single card's details are
 * showing". It is written only by the mobile activation path and cleared only
 * by the mobile Back button - which does not exist on the desktop layout, so
 * nothing clears it when the viewport crosses the breakpoint. Expand a card on
 * a phone, rotate to landscape, and the raw value is still set while the
 * desktop layout is on screen, with no Back button to clear it and no path
 * back to one except switching sidebar tabs or narrowing the viewport again.
 *
 * Reading the raw state directly is therefore wrong whenever `isMobile` is
 * false, and nothing at the point of use says so - which is why this function
 * exists: the rule is stated once here, so a consumer reads the resolved
 * value instead of rediscovering the need for a guard.
 *
 * **Derived rather than an effect.** `useEffect(() => { if (!isMobile) clear(); })`
 * runs *after* the render that flipped the viewport, so there is one committed
 * frame in which the layout is the desktop one and the value is still set -
 * a desktop sidebar filtered to one card, however briefly. The acceptance
 * criterion is that the value is null whenever `isMobile` is false, and only a
 * derived value can actually promise that - the same conclusion reached about
 * the sidebar's own visibility above, for the same reason: derived state
 * cannot lose a race.
 *
 * One behavioural consequence worth naming: because the raw state survives
 * underneath, rotating to landscape and back restores the expanded card rather
 * than dropping the user at the top of the list. An effect would have
 * discarded it permanently. Restoring what the user was looking at is the
 * better of the two, but it is a choice and not a side effect of the
 * technique.
 *
 * @param isMobile from `useIsMobile`, the same source `planExploreSidebar`
 *   takes it from
 * @param expandedUserId the raw state in the page - the id the mobile
 *   activation path last wrote. Callers should pass this straight through and
 *   read only the return value.
 */
export function resolveMobileSelectedUser({
  isMobile,
  expandedUserId,
}: {
  isMobile: boolean;
  expandedUserId: string | null;
}): string | null {
  return isMobile ? expandedUserId : null;
}
