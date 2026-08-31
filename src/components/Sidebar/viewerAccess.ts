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
 * Whether a card may show the counterpart's preferred name.
 *
 * `UserCard` shows the other person's *role* — "Driver", "Rider" — in place of
 * their name whenever the reader is a VIEWER. That is a **discovery** rule: a
 * browsing user should not collect the names of students they have no
 * relationship with, which is why recommendation and favorite cards keep it.
 *
 * A request is not discovery. The reader already sent or received it, and saw
 * the name at the time; the server takes the same line, disclosing a
 * counterpart's email through `convertCarpoolSearchToPublicWithExactHome`
 * while withholding it from a stranger. Withholding here does not
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

/**
 * What a card calls the other person: their preferred name, or their role when
 * Viewer mode withholds it.
 *
 * This exists so the **visible** name and the **accessible** name cannot
 * diverge. The disclosure rule used to live inline in `UserCard`'s
 * JSX, which was fine while the name was only ever rendered as text. It stopped
 * being fine when the card gained a stretched activation button: that button has
 * no text content, so it needs an `aria-label`, and a label built from
 * `preferredName` directly would announce to a screen reader exactly the name
 * the card is withholding on screen.
 *
 * A leak through the accessibility layer is still a leak, and it is the harder
 * kind to notice. So both call sites read the name from here.
 */
export const counterpartLabel = (input: {
  viewerRole: string;
  isCounterpart: boolean;
  preferredName: string;
  role: string;
}): string => {
  if (disclosesCounterpartName(input.viewerRole, input.isCounterpart)) {
    return input.preferredName;
  }

  // "DRIVER" -> "Driver". Sentence case rather than the raw enum, because this
  // is read aloud and rendered as a person's stand-in.
  return `${input.role.charAt(0)}${input.role.slice(1).toLowerCase()}`;
};
