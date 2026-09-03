/**
 * What Viewer mode hides, and what it must not.
 *
 * Viewer is the browsing role, and the default for a new account,
 * so drifting into it is ordinary. It should stop **discovery and new
 * requests** — which it does, in `recommendation.ts` and `candidateSearch.ts`
 * on the server, and by having nothing to press on a recommendation card.
 *
 * It should **not** hide relationships that already exist. This is the policy
 * `roleMismatchExplanation` already states: "Requests survive a role change on
 * either side... role compatibility governs discovery, and whether the request
 * can be *accepted*." That already applies to `user.requests.me` and to the
 * card notices; the Requests tab was the last place still gated on the caller's own role, so a
 * VIEWER saw explanatory copy where their cards should be and had no way to
 * withdraw a request they had sent.
 *
 * Nothing else blocked them. `requests.delete` checks participation, not role,
 * and `handleReject` in `MessagePanel` already covers both directions —
 * declining an incoming request and withdrawing an outgoing one. So the cards
 * were the only missing piece: rendering them restores self-service withdrawal
 * with no server change and no new permission.
 *
 * Extracted as a predicate rather than left inline because the repository has no
 * component tests, and a gate that decides what a user
 * can reach is worth pinning somewhere a test can see it.
 */

/**
 * **Viewer mode does not withhold a counterpart's name, and deliberately so.**
 *
 * It used to. `disclosesCounterpartName` and `counterpartLabel` lived here and
 * printed the other person's *role* — "Driver", "Rider" — in place of their
 * name whenever a VIEWER read a discovery card, on the rationale that a
 * browsing user should not collect the names of students they have no
 * relationship with. SCRUM-323 removed both. The reasoning, so that nobody
 * reinstates it by accident:
 *
 * **The photograph beside the name was never withheld, by decision.**
 * `getPresignedDownloadUrl` serves any user's picture to any signed-in caller,
 * and [`user.ts`](../../server/router/user.ts) records why: "a profile picture
 * is the one field a user uploads specifically to be seen by strangers on the
 * platform". A rule that hid the name while showing the face was not protecting
 * an identity from anyone.
 *
 * **It was presentational in any case.** `preferredName` is part of
 * `PublicUserFields`, so the server sends it to every reader including a
 * VIEWER; the card merely declined to paint it. The server does withhold real
 * things from a stranger — the exact home coordinate and the email address —
 * and those are the controls that mean something.
 *
 * **It only ever reached Favorites.** `viewerModeHidesCards` replaces the
 * recommendations list with copy, so a VIEWER sees no recommendation cards at
 * all. Requests were exempted by SCRUM-316. That left one surface: the reader's
 * own favourites, where a former Driver who saved three people and then
 * switched to Viewer read "Driver", "Driver", "Rider" with no way to tell them
 * apart — the same defect SCRUM-316 fixed on the Requests tab, in the one place
 * it survived. The note on `viewerModeHidesCards` above already argues that
 * favourites is "a list the user built themselves, and hiding them loses
 * information rather than withholding a feature"; withholding the names
 * contradicted it.
 *
 * So the cost was real and the protection was not. If a genuine control is ever
 * wanted here it has to start on the server, by omitting `preferredName` from
 * the payload the way the email address already is — not by declining to render
 * a value the client has been given.
 *
 * One consequence worth keeping in mind: the card's heading, the profile
 * image's `alt` text and the activation button's `aria-label` all read
 * `otherUser.preferredName` directly now. They cannot diverge, which is what
 * `counterpartLabel` existed to guarantee — SCRUM-279 had found the `alt` text
 * announcing a name the heading was hiding. With nothing withheld there is
 * nothing to leak, so the guarantee is structural rather than enforced.
 */

/** The sub-tabs [`SidebarContent`](./SidebarContent.tsx) renders. */
export type SidebarSubType =
  "recommendations" | "favorites" | "sent" | "received" | "all";

/**
 * The three sub-tabs of the Requests sidebar. Each lists people the user is
 * already party to a request with, rather than people they might match.
 */
const REQUEST_SUB_TYPES: readonly string[] = ["sent", "received", "all"];

export const isRequestSubType = (subType: string): boolean =>
  REQUEST_SUB_TYPES.includes(subType);

/**
 * Whether Viewer mode replaces this tab's cards with explanatory copy.
 *
 * Only recommendations. That list is discovery — a VIEWER is excluded from it
 * on both sides, so there is genuinely nothing to show and the copy is the
 * whole content of the tab.
 *
 * Favorites was already exempt before this change, and requests are exempt now:
 * both are lists the user built themselves, and hiding them loses information
 * rather than withholding a feature.
 *
 * Takes the sub-tab alone; the caller still decides whether the user is a
 * VIEWER at all, so this cannot accidentally gate a Rider or Driver.
 */
export const viewerModeHidesCards = (subType: string): boolean =>
  subType === "recommendations";
