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
    render(<AdminMobileNotice reservesMobileNav={true} />);

    // Deliberate removal of a capability, so it has to say so rather than
    // looking like a page that failed to load.
    expect(
      screen.getByRole("heading", { name: /bigger screen/i }),
    ).toBeInTheDocument();
  });

  it("offers a labelled way back to the map", () => {
    render(<AdminMobileNotice reservesMobileNav={true} />);

    // The acceptance criterion this panel exists to satisfy. An accessible
    // name, not just a tappable glyph.
    expect(
      screen.getByRole("button", { name: /back to map/i }),
    ).toBeInTheDocument();
  });

  it("navigates to the map when that control is used", async () => {
    render(<AdminMobileNotice reservesMobileNav={true} />);

    await userEvent.click(screen.getByRole("button", { name: /back to map/i }));

    // A client-side push is correct here: unlike the profile page there is no
    // unsaved form to lose, and this page supplies no `checkChanges` guard.
    expect(push).toHaveBeenCalledWith("/");
  });

  it("gives that control the 44px target the rest of the mobile UI uses", () => {
    render(<AdminMobileNotice reservesMobileNav={true} />);

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

  /**
   * SCRUM-484 made this panel serve two viewports rather than one: mobile
   * width, where `Header` renders a fixed bottom navigation, and adequate
   * width with inadequate height, where it renders the in-flow desktop bar.
   *
   * **Both assertions here are class-and-style checks, and that is the ceiling
   * in jsdom, not a shortcut.** Whether 91.5% plus 8.5% actually lands on the
   * viewport's bottom edge is a layout question, and jsdom computes no layout
   * - `getBoundingClientRect` is zeros throughout. The geometry was measured
   * in Chromium through `scripts/measure-layout.ts` and belongs, durably, in
   * SCRUM-264's Playwright suite. What is assertable is that the component
   * *requests* the right box for the header it was told about, which is the
   * step that was wrong.
   */
  describe("the space it claims", () => {
    /* The panel is the outermost element the component renders, and it carries
       no role - so this reaches for it by container rather than by query. The
       alternative is a test id on a presentational wrapper, which the rest of
       this file avoids. */
    const panel = (reservesMobileNav: boolean): HTMLElement => {
      const { container } = render(
        <AdminMobileNotice reservesMobileNav={reservesMobileNav} />,
      );

      return container.firstElementChild as HTMLElement;
    };

    it("fills the page and clears the navigation when the bottom bar is rendered", () => {
      const element = panel(true);

      /* `h-full` is right precisely because the bar is `position: fixed` and
         therefore takes no space in flow. The padding is what keeps the
         content off it. */
      expect(element).toHaveClass("h-full");
      expect(element.style.paddingBottom).not.toBe("");
    });

    it("takes the content row's share and reserves nothing when the desktop bar is rendered", () => {
      const element = panel(false);

      /* The desktop bar is in flow at 8.5%, so this sibling gets the 91.5%
         remainder - the same figure the console's own row takes. `h-full`
         here would overrun the viewport by the height of the bar. */
      expect(element).toHaveClass("h-[91.5%]");
      expect(element).not.toHaveClass("h-full");

      /* Absent, not zero. A reserved 60px would push this panel's centred
         content down past a navigation that is not on screen. */
      expect(element.style.paddingBottom).toBe("");
    });

    it("says nothing about width, because the screen reaching it may be wide", () => {
      /*
       * The copy regression this ticket fixed. A landscape phone is 667px
       * wide and lands here on the height term alone, so "wider" was telling
       * a user to do the one thing that would not help. Asserted as the
       * absence of the old wording rather than only the presence of the new,
       * because the heading could gain a second sentence and still be wrong.
       */
      panel(false);

      const heading = screen.getByRole("heading");

      expect(heading).toHaveTextContent(/bigger screen/i);
      expect(heading).not.toHaveTextContent(/wider/i);
    });
  });
});
