/**
 * The profile page's tab vocabulary, and the URL that names one.
 *
 * **Why this is a module rather than three inline unions.** The three tabs
 * were spelled out as a literal union in `pages/profile/index.tsx`,
 * `ProfileSidebar` and `ProfileSidebar.test.tsx`, which was harmless while
 * nothing outside the page could select a tab. Once a *link* can, the set of
 * valid tabs becomes a thing the page has to validate untrusted input
 * against - `?tab=` is user-editable text in the address bar - and a decision
 * left inline in a 1,300-line page behind Mapbox, NextAuth and a dozen tRPC
 * queries is a decision nothing can test. `coopRangeNotice.ts` is separate
 * from the same page for the same reason.
 *
 * **Why `?tab=` and not a path segment.** `/` already carries its sidebar
 * selection this way - `Header` reads `router.query.tab` and navigates with
 * `router.push({ pathname: "/", query: { tab } })` for `explore`, `requests`
 * and `mygroup`. A second spelling for the same idea on a second page would
 * be the third variant of a convention that already exists, so this matches
 * it. The two vocabularies are deliberately *not* merged: they name tabs on
 * different pages and nothing should make `?tab=mygroup` meaningful here.
 *
 * **Why the profile page can read it during the initial render.**
 * `pages/profile/index.tsx` exports `getServerSideProps`, so it is never
 * statically optimised, and Next populates `router.query` before the first
 * client render. That is what makes a `useState` initialiser sufficient and
 * an `isReady` guard or a post-mount effect unnecessary - an effect would
 * render the wrong tab first and visibly swap it.
 */

/**
 * Every tab, in the order the sidebar shows them. The first is the default,
 * which is the behaviour the page had before any of this existed: arriving at
 * a bare `/profile` opens "User Profile".
 */
export const PROFILE_TABS = ["user", "carpool", "account"] as const;

export type ProfileTab = (typeof PROFILE_TABS)[number];

export const DEFAULT_PROFILE_TAB: ProfileTab = PROFILE_TABS[0];

/** The query key. Shared so the reader and the writer cannot drift apart. */
export const PROFILE_TAB_QUERY_KEY = "tab";

/**
 * The tab a query value names, or `null` when it names none.
 *
 * Takes `unknown` rather than `string | string[] | undefined` because the
 * caller is `router.query[...]`, whose type is a promise about well-formed
 * input rather than a guarantee: the value is whatever is in the address
 * bar. Returning `null` rather than throwing or defaulting here keeps the
 * fallback the caller's decision and visible at the call site.
 *
 * **A repeated parameter is not a tab.** `?tab=account&tab=user` parses to
 * `["account", "user"]`, and there is no honest answer to which one the user
 * meant - so this takes neither. Silently reading the first would make a
 * malformed link behave like a valid one, which is harder to notice than
 * landing on the default.
 */
export const parseProfileTab = (value: unknown): ProfileTab | null => {
  if (typeof value !== "string") {
    return null;
  }

  return (
    PROFILE_TABS.find(
      (candidate): candidate is ProfileTab => candidate === value,
    ) ?? null
  );
};

/**
 * The route that opens the profile on a given tab.
 *
 * The object form rather than a built string, because that is what
 * `Header` passes for `/` and it leaves the encoding to Next rather than to
 * whoever writes the next call site.
 */
export const profileTabRoute = (tab: ProfileTab) => ({
  pathname: "/profile",
  query: { [PROFILE_TAB_QUERY_KEY]: tab },
});
