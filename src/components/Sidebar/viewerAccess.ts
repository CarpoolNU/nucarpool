/**
 * What Viewer mode hides, and what it must not (SCRUM-316).
 *
 * Viewer is the browsing role, and the default for a new account (SCRUM-117),
 * so drifting into it is ordinary. It should stop **discovery and new
 * requests** — which it does, in `recommendation.ts` and `candidateSearch.ts`
 * on the server, and by having nothing to press on a recommendation card.
 *
 * It should **not** hide relationships that already exist. This is the policy
 * `roleMismatchExplanation` already states: "Requests survive a role change on
 * either side... role compatibility governs discovery, and whether the request
 * can be *accepted*." SCRUM-296 applied that to `user.requests.me` and to the
 * card notices; the Requests tab was still gated on the caller's own role, so a
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
 * component tests (SCRUM-263 / SCRUM-264), and a gate that decides what a user
 * can reach is worth pinning somewhere a test can see it.
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

/**
 * Whether a card may show the counterpart's preferred name (SCRUM-316).
 *
 * `UserCard` shows the other person's *role* — "Driver", "Rider" — in place of
 * their name whenever the reader is a VIEWER. That is a **discovery** rule: a
 * browsing user should not collect the names of students they have no
 * relationship with, which is why recommendation and favorite cards keep it.
 *
 * A request is not discovery. The reader already sent or received it, and saw
 * the name at the time; the server takes the same line, disclosing a
 * counterpart's email through `convertCarpoolSearchToPublicWithExactHome`
 * (SCRUM-292) while withholding it from a stranger. Withholding here does not
 * protect anything — the card's own notice names the counterpart, because
 * `roleMismatchExplanation` phrases it that way — and it makes the tab unusable:
 * three sent requests would all read "Driver", with nothing to tell them apart.
 *
 * So a VIEWER sees names on request cards and not on discovery cards. Everyone
 * else sees names everywhere, exactly as before.
 */
export const disclosesCounterpartName = (
  viewerRole: string,
  isCounterpart: boolean,
): boolean => viewerRole !== "VIEWER" || isCounterpart;
