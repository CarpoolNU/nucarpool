import { render } from "@testing-library/react";
import React from "react";
import { SidebarPage } from "./Sidebar";
import type { EnhancedPublicUser } from "../../utils/types";
import type { QueryState } from "../../utils/queryState";

/**
 * `SidebarPage` does not reorder its caller's request arrays.
 *
 * **The defect.** The Requests branch rendered
 * `received={props.received.reverse()}`. `Array.prototype.reverse` reverses
 * **in place**, so every render of this component reversed one of
 * `index.tsx`'s `useMemo` results - arrays the memo only rebuilds when the
 * request data changes. Cards carrying equal timestamps therefore swapped
 * places on re-renders that had nothing to do with requests, and the same two
 * arrays are spread into `handleMobileSidebarExpand`'s lookup, which was being
 * reordered underneath it as a side effect.
 *
 * **Why the obvious test for this is vacuous here.** "The caller's array is
 * still in its original order afterwards" passes against the *unfixed*
 * component, because `jest.setup.dom.ts` configures `reactStrictMode` and
 * StrictMode double-invokes the render function: two reversals per pass land
 * back where they started. That is not a quirk of the test, it is the defect's
 * actual history - this is why it never showed in development and only ever
 * appeared in production.
 *
 * So both cases below are built to be parity-independent:
 *
 *  - **Frozen inputs.** `reverse()` on a frozen array throws, so no number of
 *    cancelling reversals can hide one. This is the assertion that no mutation
 *    happened at all, rather than that an even number did.
 *  - **Every pass agreed.** StrictMode's two invocations of one render are
 *    exactly the two renders the user saw cards swap between, so requiring all
 *    recorded passes to be identical reproduces the symptom directly.
 *
 * `SidebarContent` is stood in for because it owns the card markup, which is
 * not what this file is about; the list it is handed is where the ordering
 * decision lands. Nothing here fetches, so nothing else is mocked.
 */

/**
 * The stand-in for `SidebarContent`.
 *
 * The factory is hoisted above every `const` in this file, so `seenByContent`
 * is read inside the stub body rather than in the factory itself - the stub
 * does not run until a render, by which time the declaration below has
 * initialised. Reading it one level out would hit the temporal dead zone.
 */
jest.mock("./SidebarContent", () => ({
  SidebarContent: (props: { userCardList: { id: string }[] }) => {
    seenByContent.push(props.userCardList.map((u) => u.id));
    return null;
  },
}));

/** One entry per render pass, in order. Cleared before each case. */
const seenByContent: string[][] = [];

beforeEach(() => {
  seenByContent.length = 0;
});

/** Enough of the shape for the list to be keyed and passed along. */
const card = (id: string): EnhancedPublicUser =>
  ({
    id,
    preferredName: id,
    email: `${id}@northeastern.edu`,
    role: "RIDER",
  }) as unknown as EnhancedPublicUser;

const READY: QueryState = { status: "ready", retry: () => undefined };

/**
 * Every prop the Requests branch reaches. `map`, `filters` and
 * `defaultFilters` are cast: this branch never touches them, and a Mapbox
 * instance cannot be constructed in jsdom.
 */
const baseProps = (
  received: readonly EnhancedPublicUser[],
  sent: readonly EnhancedPublicUser[],
) =>
  ({
    sidebarType: "requests" as const,
    setFilters: () => undefined,
    setSort: () => undefined,
    sort: "",
    filters: {} as any,
    defaultFilters: {} as any,
    map: {} as any,
    role: "RIDER",
    recs: [],
    favs: [],
    received,
    sent,
    recsState: READY,
    favsState: READY,
    requestsState: READY,
    onViewRouteClick: () => undefined,
    onUserSelect: () => undefined,
    selectedUser: null,
    mobileSelectedUser: null,
    handleMobileExpand: () => undefined,
    collapseSidebar: () => undefined,
  }) as unknown as React.ComponentProps<typeof SidebarPage>;

describe("SidebarPage's requests branch", () => {
  it("does not mutate the arrays it is given", () => {
    /*
     * Frozen, which is what makes this independent of how many times React
     * renders. `reverse()` on a frozen array throws a `TypeError` - modules are
     * strict mode - so the unfixed component fails here on its first pass
     * instead of being covered for by its second.
     */
    const received = Object.freeze([card("r1"), card("r2"), card("r3")]);
    const sent = Object.freeze([card("s1"), card("s2")]);

    expect(() =>
      render(<SidebarPage {...baseProps(received, sent)} />),
    ).not.toThrow();

    // The control for the control: the stub really did run, so the assertion
    // above is about a component that rendered rather than one that never got
    // as far as the list.
    expect(seenByContent.length).toBeGreaterThan(0);
  });

  it("hands every render pass the same order", () => {
    const received = [card("r1"), card("r2"), card("r3")];
    const sent = [card("s1"), card("s2")];

    const { rerender } = render(<SidebarPage {...baseProps(received, sent)} />);
    rerender(<SidebarPage {...baseProps(received, sent)} />);

    /*
     * The user-visible symptom, reproduced. Under the in-place reversal the
     * first pass saw `r3, r2, r1` and the second saw `r1, r2, r3`, which is
     * cards changing places on a re-render that had nothing to do with
     * requests. StrictMode's double invocation is not working around anything
     * here - it *is* the pair of renders between which the flip happened.
     */
    expect(seenByContent.length).toBeGreaterThan(1);
    for (const pass of seenByContent) {
      expect(pass).toEqual(seenByContent[0]);
    }

    /*
     * And the order itself, which is the other half. "Every pass agreed" and
     * "nothing was mutated" are both satisfied by deleting the reversal
     * outright - that would quietly flip the Requests tab to oldest-first, so
     * the display order has to be pinned in the same breath.
     *
     * The default tab is "All", which renders received followed by sent, each
     * newest first.
     */
    expect(seenByContent[0]).toEqual(["r3", "r2", "r1", "s2", "s1"]);
  });
});
