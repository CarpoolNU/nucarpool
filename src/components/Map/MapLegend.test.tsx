import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLegend } from "./MapLegend";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * The pin-colour key, now that mobile has one.
 *
 * The legend was `!isMobile`-gated in `index.tsx`, so the colour encoding was
 * unexplained on the platform where the map is most of the screen. It is
 * reachable now, but collapsed behind a toggle rather than simply un-gated -
 * a three-row panel permanently over a phone-sized map costs more than it
 * explains, and the bottom-left anchor it used on desktop is under the explore
 * sheet on mobile anyway.
 *
 * So there are two claims to pin, and they pull in opposite directions:
 * mobile must be able to *reach* the entries, and must not show them
 * unprompted. A test for only the first would pass against a version that
 * ignored the collapse state entirely.
 *
 * *Not covered:* that the panel clears the banner, the sheet, or Mapbox's own
 * controls. jsdom does no layout and computes no stacking, so every placement
 * claim in the component is arithmetic rather than measurement - see
 * `src/testing/viewport.ts`.
 */

restoreViewportAfterEach();

/** One of the three entries; present for every role, unlike the other two. */
const MY_DESTINATION = "My Destination";
const TOGGLE = "Map legend";

describe("MapLegend on mobile", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("starts collapsed", () => {
    // Half of the pair. A version that dropped the collapse state and just
    // rendered the panel would satisfy the reachability test below while
    // covering the map it explains.
    render(<MapLegend role="RIDER" />);

    expect(screen.queryByText(MY_DESTINATION)).not.toBeInTheDocument();
  });

  it("offers a toggle that reveals the entries", async () => {
    render(<MapLegend role="RIDER" />);

    await userEvent.click(screen.getByRole("button", { name: TOGGLE }));

    expect(screen.getByText(MY_DESTINATION)).toBeInTheDocument();
  });

  it("closes again on a second press", async () => {
    // So the toggle is a toggle rather than a one-way reveal, which is the
    // easy thing to get wrong when the state starts false.
    render(<MapLegend role="RIDER" />);
    const toggle = screen.getByRole("button", { name: TOGGLE });

    await userEvent.click(toggle);
    await userEvent.click(toggle);

    expect(screen.queryByText(MY_DESTINATION)).not.toBeInTheDocument();
  });

  it("reports its state to assistive technology", async () => {
    // A control whose only visible effect is elsewhere in the panel needs
    // `aria-expanded`, otherwise a screen reader user presses it and is told
    // nothing happened.
    render(<MapLegend role="RIDER" />);
    const toggle = screen.getByRole("button", { name: TOGGLE });

    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the driver entry to a rider once open", async () => {
    // The legend's actual purpose: a RIDER needs to know which colour is a
    // driver. Role-dependent, so it is worth one assertion beyond the row
    // every role gets.
    render(<MapLegend role="RIDER" />);

    await userEvent.click(screen.getByRole("button", { name: TOGGLE }));

    expect(screen.getByText("Driver Destination")).toBeInTheDocument();
    expect(screen.queryByText("Rider Destination")).not.toBeInTheDocument();
  });
});

describe("MapLegend on desktop", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("shows the entries with no toggle at all", () => {
    // Desktop is unchanged, and this is the assertion that says so. It would
    // fail against a version that applied the collapse state on both
    // platforms - which would have hidden a panel that has always been open
    // here, with a control that had never existed.
    render(<MapLegend role="RIDER" />);

    expect(screen.getByText(MY_DESTINATION)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TOGGLE }),
    ).not.toBeInTheDocument();
  });

  it("shows every entry a viewer should see", () => {
    // VIEWER is the role that gets all three rows, so it is the one that
    // catches an entry dropped while the entries were moved inside a wrapper.
    render(<MapLegend role="VIEWER" />);

    for (const label of [
      MY_DESTINATION,
      "Driver Destination",
      "Rider Destination",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
