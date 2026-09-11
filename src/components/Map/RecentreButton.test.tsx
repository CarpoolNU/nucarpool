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
 * It was `!isMobile`-gated inside `index.tsx`, so a mobile user who panned
 * away from their workplace had no way back. This file exists because that
 * page has no test of its own, which is the whole reason the control was
 * lifted out of it: the defect class this ticket addresses is controls that
 * exist on one platform and not the other, and that is only checkable if the
 * control can be rendered on its own.
 *
 * *Not covered:* where it actually lands. The mobile placement avoids the
 * bottom navigation, the explore sheet and Mapbox's own controls by
 * construction rather than by measurement - jsdom computes no geometry and no
 * stacking. See `src/testing/viewport.ts`.
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
    // viewport, which is what this replaced.
    render(<RecentreButton onRecentre={() => undefined} />);

    expect(screen.getByRole("button", { name: LABEL })).toBeInTheDocument();
  });

  it("recentres when pressed", () => {
    // Present is not enough on its own: the control this replaced was once
    // wired through `document.getElementById("fly").addEventListener` outside
    // React's lifecycle, so a button that rendered and did nothing is the
    // failure this file has historical reason to check for.
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
});
