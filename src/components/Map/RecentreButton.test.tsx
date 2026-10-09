import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecentreButton } from "./RecentreButton";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * The recentre control's reachability.
 *
 * This file exists because `index.tsx` has no test of its own: whether a
 * control renders on one platform and not the other is only checkable if
 * the control can be rendered on its own, outside that page.
 *
 * *Not covered:* where it actually lands. The mobile placement avoids the
 * bottom navigation, the explore sheet and Mapbox's own controls by
 * construction rather than by measurement - jsdom computes no geometry and no
 * stacking. See `src/testing/viewport.ts`.
 *
 * *Also not covered, and not coverable here:* **that the caller renders this
 * inside a positioned ancestor.** Every offset below is `absolute`, so where
 * the button lands is decided by whichever ancestor establishes its containing
 * block - and that is `index.tsx`'s business, not this component's. The
 * classes asserted below would stay correct even if the button sat under
 * `MobileBanner` as a sibling of `#map` rather than inside it, with `top-2`
 * measuring from the viewport instead. `index.tsx` has no test, so nothing
 * in this suite would fail if that regressed. The assertion that would
 * catch it lives in the Playwright suite that covers this component's
 * layout directly: `elementFromPoint` at the button's top edge returns the
 * button.
 */

restoreViewportAfterEach();

const LABEL = "Recentre the map on your workplace";

describe.each([
  ["mobile", MOBILE_WIDTH],
  ["desktop", DESKTOP_WIDTH],
])("RecentreButton at %s width", (_label, width) => {
  beforeEach(() => {
    setViewportWidth(width);
  });

  it("is present and named for what it does", () => {
    // The mobile half fails against any version that gates itself on the
    // viewport.
    render(<RecentreButton onRecentre={() => undefined} />);

    expect(screen.getByRole("button", { name: LABEL })).toBeInTheDocument();
  });

  it("recentres when pressed", () => {
    // Present is not enough on its own: a button that renders and does
    // nothing on click is a real failure mode for a component whose only
    // job is to call a prop, so this checks the click actually reaches
    // `onRecentre`.
    const onRecentre = jest.fn();
    render(<RecentreButton onRecentre={onRecentre} />);

    return userEvent
      .click(screen.getByRole("button", { name: LABEL }))
      .then(() => {
        expect(onRecentre).toHaveBeenCalledTimes(1);
      });
  });

  it("carries no text of its own, so the label is the whole name", () => {
    // The icon is `aria-hidden`, so if the `aria-label` were dropped the
    // control would become an unnamed button rather than a differently named
    // one - which the query above would catch, but only by accident.
    render(<RecentreButton onRecentre={() => undefined} />);

    expect(screen.getByRole("button", { name: LABEL })).toHaveTextContent("");
  });

  /**
   * **A proxy, not a measurement**, and a weak one - see the note at the top
   * of this file. It pins only that the control positions itself out of the
   * normal flow at both widths, which is the premise the call site's placement
   * inside `#map` exists to satisfy. It cannot tell a correctly placed button
   * from one anchored to the viewport, because that difference is entirely in
   * the ancestor chain and jsdom resolves no containing blocks.
   */
  it("positions itself absolutely, so its ancestor decides where it lands", () => {
    render(<RecentreButton onRecentre={() => undefined} />);

    expect(screen.getByRole("button", { name: LABEL })).toHaveClass("absolute");
  });
});

describe("RecentreButton's label", () => {
  /**
   * What a corrected `flyTo` alone would not cover. The destination and the
   * promise are one decision, made in `mapHomeCentre` and spelled out in
   * `mapHomeCentre.test.ts`; what this covers is that the component actually
   * honours the answer it is handed.
   *
   * A VIEWER has no workplace, so naming one would be a false statement to
   * about a third of production.
   */
  it("names the campus when that is where it is going", () => {
    render(<RecentreButton subject="campus" onRecentre={() => undefined} />);

    expect(
      screen.getByRole("button", { name: "Recentre the map on Northeastern" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LABEL })).toBeNull();
  });

  it("names the workplace when told to, and by default", () => {
    // The default is what keeps every existing caller and the cases above
    // correct; asserting it here is what makes the negative query above mean
    // something rather than pass because no button was rendered at all.
    const { unmount } = render(
      <RecentreButton subject="workplace" onRecentre={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: LABEL })).toBeInTheDocument();
    unmount();

    render(<RecentreButton onRecentre={() => undefined} />);
    expect(screen.getByRole("button", { name: LABEL })).toBeInTheDocument();
  });
});

describe("RecentreButton's mobile placement", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  /**
   * The top edge is the one side of the map nothing else claims - the bottom
   * belongs to the navigation, the explore sheet and Mapbox's own controls.
   * Same caveat as above: this is the class list, not the rendered box.
   */
  it("sits at the top-right of whatever contains it", () => {
    render(<RecentreButton onRecentre={() => undefined} />);

    expect(screen.getByRole("button", { name: LABEL })).toHaveClass(
      "top-2",
      "right-2",
    );
  });
});
