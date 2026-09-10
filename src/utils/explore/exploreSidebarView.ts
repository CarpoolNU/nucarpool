/**
 * Which of its five states the explore page's sidebar is in.
 *
 * Lifted out of `index.tsx` because visibility there had **three** owners
 * operating on the same DOM node, two of them not React-aware (SCRUM-413):
 * the `className` template literal, a `useEffect` calling
 * `sidebarRef.current.classList.add("hidden")`, and `handleUserSelect` calling
 * `.classList.remove("hidden")`. Both imperative calls tested the same
 * condition the effect did, and neither could work:
 *
 *  - the `remove` in `handleUserSelect` was dead on arrival. It ran during the
 *    same interaction that made `selectedUser` non-null, so the effect added
 *    `hidden` straight back afterwards. It read like a deliberate override and
 *    did nothing.
 *  - the `add` was silently wiped. React assigns the whole `class` attribute
 *    when its computed value changes rather than merging, so any re-render
 *    that touched the sidebar's `className` - toggling the collapse handle was
 *    the easy route - dropped `hidden`. The effect did not re-apply it, because
 *    its `[selectedUser, isMobile]` dependencies had not changed, so the card
 *    list stayed on top of the open conversation until the user changed tabs.
 *
 * The fix is not a better effect, it is having one owner: the state goes in,
 * a view comes out, and the page maps that view to classes React alone writes.
 *
 * **This returns a view, not a `className`.** The precedence between the four
 * states is what was broken and is what deserves a test; the classes that
 * express them are presentation. A test pinning `"bottom-mobile-nav
 * h-mobile-sheet"` would fail on any restyle while proving nothing about the
 * bug, and the union gives the page exhaustiveness checking for free.
 *
 * It also keeps to the existing convention that Tailwind classes sit with the
 * markup - no file under `src/utils/` names one. That is a convention and not
 * a constraint: Tailwind v4 scans the whole repository minus `.gitignore`, so a
 * class named here would in fact be emitted. `tailwind.config.js` used to carry
 * a `content` array that read as though it restricted this, which is where the
 * false belief came from; SCRUM-419 deleted it, since it never had any effect.
 * Verified by building with a probe class in this directory rather than
 * inferred from the config.
 *
 * Same shape as `nav/mobileNavPlan.ts` and `map/viewRoutePlan.ts`, and for the
 * same reason SCRUM-379 gave: `index.tsx` is ~918 lines behind Mapbox,
 * NextAuth and a dozen tRPC queries, so a rule living inside it is a rule
 * nothing checks.
 */

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
 * @param isCollapsed the collapse handle's state - `isSidebarCollapsed`
 */
export function planExploreSidebar({
  isMobile,
  hasOpenConversation,
  isDetailOpen,
  isCollapsed,
}: {
  isMobile: boolean;
  hasOpenConversation: boolean;
  isDetailOpen: boolean;
  isCollapsed: boolean;
}): ExploreSidebarView {
  // Desktop first, and every branch below is therefore mobile-only. The old
  // code gated each `classList` call on `isMobile` separately; getting that
  // wrong in one place was all it took to reach the desktop layout.
  if (!isMobile) {
    return "desktop";
  }

  // Highest precedence, matching what `display: none` did in practice: it beat
  // every other class in the expression regardless of the order they appeared.
  if (hasOpenConversation) {
    return "hidden";
  }

  // Before `isCollapsed`, preserving the existing ternary's order. Opening a
  // detail view also sets `isCollapsed` false, so the two rarely coincide -
  // but when they do, the details are what the user just asked for.
  if (isDetailOpen) {
    return "detail";
  }

  return isCollapsed ? "collapsed" : "expanded";
}

/**
 * The expanded card, as every consumer should read it (SCRUM-418).
 *
 * `index.tsx` holds one piece of state for "a single card's details are
 * showing". It is written only by the mobile activation path and cleared only
 * by the mobile Back button, so **nothing used to clear it when the viewport
 * crossed the breakpoint**: expand a card on a phone, rotate to landscape, and
 * the value is still set while the desktop layout is on screen - a layout with
 * no Back button, because that control sits inside a mobile-only branch. The
 * only ways out were switching sidebar tabs, whose effect resets it as a side
 * effect, or going back to a narrow viewport to find the Back button again.
 *
 * That never became a visible bug, because both consumers happened to carry a
 * defensive `isMobile` term. The cost was that the value could not be read on
 * its own without being wrong and nothing said so at the point of use:
 * SCRUM-414 discovered it while adding a third consumer and had to write
 * `!(isMobile && selected !== null)` plus a test to hold the workaround in
 * place. This function is that rule, stated once, so the next consumer
 * inherits it instead of rediscovering it.
 *
 * **Derived rather than an effect**, which is where this departs from the
 * ticket's proposed fix. `useEffect(() => { if (!isMobile) clear(); })` runs
 * *after* the render that flipped the viewport, so there is one committed
 * frame in which the layout is the desktop one and the value is still set.
 * With the defensive terms removed - which is the rest of this ticket - that
 * frame *is* the bug, briefly: a desktop sidebar filtered to one card. The
 * acceptance criterion is that the value is null whenever `isMobile` is false,
 * and only a derived value can actually promise that. It is also the same
 * conclusion SCRUM-413 reached about the sidebar's visibility twenty lines up,
 * for the same reason: derived state cannot lose a race.
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
