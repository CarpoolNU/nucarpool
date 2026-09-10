import { render, screen } from "@testing-library/react";
import { MobileBanner } from "./MobileBanner";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

/**
 * The desktop-nudge banner, now that it is its own component (SCRUM-415).
 *
 * Extracting it from `index.tsx`'s render body is the fix for a remount, and
 * a remount is invisible to a test - nothing here asserts it directly, because
 * the property that guarantees it is structural: a component declared at
 * module scope has a stable type by construction. What these tests pin is the
 * behaviour that had to survive the move, which is the part a careless
 * extraction would have changed.
 *
 * That matters more than it looks. The component was self-hiding, and the
 * obvious way to extract it - lift the `isMobile` check to the call site and
 * take a prop - would have been a silent contract change. These assertions
 * fail against that version, so they pin the decision rather than describing
 * it in a comment.
 *
 * *Not covered:* whether the bar is 24px tall, whether it sits above the map,
 * or whether the offsets that compensate for it are correct. jsdom does not
 * lay out - see `src/testing/viewport.ts` for what that rules out. The 4px
 * discrepancy between its rendered height and the explore page's `mt-5`
 * compensation is recorded on SCRUM-415 and is not assertable here.
 */

restoreViewportAfterEach();

const TEXT = "For the full experience, try using CarpoolNU on desktop";

describe("MobileBanner", () => {
  it("shows the desktop nudge on a mobile viewport", () => {
    setViewportWidth(MOBILE_WIDTH);

    render(<MobileBanner />);

    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it("renders nothing on a desktop viewport", () => {
    // The other half, and the half that would break if the `isMobile` check
    // were dropped during the move on the assumption the caller still gated
    // it. A banner telling a desktop user to switch to desktop.
    setViewportWidth(DESKTOP_WIDTH);

    const { container } = render(<MobileBanner />);

    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
    // Nothing at all, not merely hidden text: it returns `null`, so it must
    // not leave an empty wrapper occupying the top of the page.
    expect(container).toBeEmptyDOMElement();
  });

  it("hides itself rather than relying on its caller", () => {
    // Pins the contract the extraction preserved. Rendered with no props at
    // all at a desktop width, a caller-gated version would show the banner,
    // because there would be no caller to gate it.
    setViewportWidth(DESKTOP_WIDTH);

    const { container } = render(<MobileBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it("is fixed to the top so the page cannot scroll it away", () => {
    setViewportWidth(MOBILE_WIDTH);

    render(<MobileBanner />);

    // Asserting the inline style, which is the declaration that actually
    // wins: the element also carries an `absolute` class that `position:
    // fixed` here overrides. That contradiction is copied verbatim from the
    // original and is deliberately not tidied - see the component's docblock.
    // This is a style *string* assertion, not a layout one; jsdom computes no
    // geometry.
    expect(screen.getByText(TEXT)).toHaveStyle({ position: "fixed", top: 0 });
  });
});
