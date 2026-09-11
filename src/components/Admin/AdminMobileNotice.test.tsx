/**
 * The panel `/admin` shows instead of its dashboard on a phone.
 *
 * The subject is the labelled way back. `Header`'s mobile branch renders only
 * the bottom navigation, so the desktop admin header - whose sole control is a
 * "Home" button - never reaches the screen, and before this panel existed the
 * only route back to the map was tapping Explore in a bar that was
 * simultaneously claiming Explore was the current page.
 *
 * **What this cannot check.** jsdom does no layout, so "the panel fits at
 * 375px" and "the button clears the fixed navigation" are both unobservable
 * here - `getBoundingClientRect` is all zeros and the `env()` term in
 * `MOBILE_NAV_SPACE` is mangled by jsdom's parser. See
 * `src/testing/viewport.ts`. What is assertable is reachability and wiring:
 * that the control exists, is a real button, and navigates when activated.
 * The 44px assertion below is a class-name check for the same reason, and is
 * worth only what that is.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({ push }),
}));

import AdminMobileNotice from "./AdminMobileNotice";

beforeEach(() => {
  push.mockReset();
});

describe("AdminMobileNotice", () => {
  it("explains why the dashboard is not here", () => {
    render(<AdminMobileNotice />);

    // Deliberate removal of a capability, so it has to say so rather than
    // looking like a page that failed to load.
    expect(
      screen.getByRole("heading", { name: /wider screen/i }),
    ).toBeInTheDocument();
  });

  it("offers a labelled way back to the map", () => {
    render(<AdminMobileNotice />);

    // The acceptance criterion this panel exists to satisfy. An accessible
    // name, not just a tappable glyph.
    expect(
      screen.getByRole("button", { name: /back to map/i }),
    ).toBeInTheDocument();
  });

  it("navigates to the map when that control is used", async () => {
    render(<AdminMobileNotice />);

    await userEvent.click(screen.getByRole("button", { name: /back to map/i }));

    // A client-side push is correct here: unlike the profile page there is no
    // unsaved form to lose, and this page supplies no `checkChanges` guard.
    expect(push).toHaveBeenCalledWith("/");
  });

  it("gives that control the 44px target the rest of the mobile UI uses", () => {
    render(<AdminMobileNotice />);

    /*
     * `min-h-11` is 44px, the size Apple's HIG and WCAG 2.5.5 ask for and the
     * figure `RecentreButton` and `MapLegend` already carry.
     *
     * A class-name assertion, which is the weakest useful form: it pins the
     * intent against a later refactor that drops the class, and proves nothing
     * about rendered geometry, because jsdom computes none.
     */
    expect(screen.getByRole("button", { name: /back to map/i })).toHaveClass(
      "min-h-11",
    );
  });
});
