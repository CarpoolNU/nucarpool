import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapUsersError } from "./MapUsersError";
import { toQueryState, type QueryState } from "../../utils/queryState";

/**
 * The map's failure state.
 *
 * The acceptance criterion is "a failed map query shows an error with a
 * retry", and this is the level it can be checked at - `index.tsx` cannot
 * be rendered in jsdom, which is why this overlay is its own component
 * rather than a branch inside that page.
 *
 * The states are built with the real `toQueryState` over a `QueryLike` literal
 * rather than with hand-written `{ status }` objects. That is deliberate: the
 * derivation is what decides whether a failure is shown at all, and v5's
 * definition of `isLoading` is exactly the trap `queryState.ts` exists to
 * document. A literal would let this file pass while the page still conflated a
 * failure with a loading state.
 *
 * jsdom does no layout, so nothing here claims the panel is visible on screen -
 * see the component's docblock for the mobile sheet that can cover it, and
 * `src/testing/viewport.ts`.
 */

const fromQuery = (over: {
  isError?: boolean;
  isLoading?: boolean;
  refetch?: () => unknown;
}): QueryState =>
  toQueryState({
    isLoading: false,
    isError: false,
    refetch: () => undefined,
    ...over,
  });

describe("MapUsersError", () => {
  it("states what failed and offers a way out", () => {
    render(<MapUsersError state={fromQuery({ isError: true })} />);

    // `role="alert"` rather than the text alone: a message nothing announces
    // is close to no message on the one page where the alternative reading is
    // "nobody is here".
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText("We could not load the users on the map."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("retries the query that failed", async () => {
    // Present is not enough. The retry is the difference between reporting the
    // outage and stranding the user in it.
    const refetch = jest.fn();

    render(<MapUsersError state={fromQuery({ isError: true, refetch })} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while the query is loading", () => {
    // The control for the case above. Without it, "shows an error" would also
    // be satisfied by a component that renders the panel unconditionally -
    // which on a slow connection would report an outage on every page load.
    const { container } = render(
      <MapUsersError state={fromQuery({ isLoading: true })} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders nothing when the query succeeded, including with no users", () => {
    // The distinction this component exists to make, from the other side: a
    // ready query with an empty result is a genuine answer and must not be
    // dressed up as a failure.
    const { container } = render(<MapUsersError state={fromQuery({})} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("reports a query that is both failed and loading as failed", () => {
    // `toQueryState` checks `isError` first on purpose - checking `isLoading`
    // first would show a spinner for what is really a failure. Asserted
    // through this component
    // because that ordering is what decides whether the retry is reachable
    // during a refetch of an already-failed query.
    render(
      <MapUsersError state={fromQuery({ isError: true, isLoading: true })} />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
