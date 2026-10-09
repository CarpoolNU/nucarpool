/**
 * The overlay's one action has to finish the journey it starts.
 *
 * `InactiveBlocker` covers the map for a deactivated user and offers a single
 * button. It pushed a bare `/profile`, which opens on "User Profile" - so the
 * only way out of the overlay landed the user two tabs from the status
 * toggle, and the copy did not name the tab either. SCRUM-667.
 *
 * The destination is asserted as the object Next receives rather than a
 * built string, because that is what the component passes; a test that
 * matched `"/profile?tab=account"` would fail on a correct change of form.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InactiveBlocker from "./InactiveBlocker";
import { parseProfileTab } from "../../utils/profile/profileTab";
import { resetRouterSpies, routerSpies } from "../../testing/nextRouterStub";

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);

beforeEach(() => {
  resetRouterSpies();
});

describe("the way out of the overlay", () => {
  it("sends the user to the tab that holds the status toggle", async () => {
    render(<InactiveBlocker />);

    fireEvent.click(screen.getByRole("button", { name: "Go to Profile" }));

    await waitFor(() => expect(routerSpies().push).toHaveBeenCalledTimes(1));
    expect(routerSpies().push).toHaveBeenCalledWith({
      pathname: "/profile",
      query: { tab: "account" },
    });
  });

  it("names a tab the profile page will actually accept", async () => {
    // Guards the seam rather than the spelling: the page parses this value,
    // so a typo here would be a silent fall back to "User Profile" - exactly
    // the defect this ticket fixes, reintroduced without any test failing.
    render(<InactiveBlocker />);

    fireEvent.click(screen.getByRole("button", { name: "Go to Profile" }));

    await waitFor(() => expect(routerSpies().push).toHaveBeenCalledTimes(1));
    const [route] = routerSpies().push.mock.calls[0] as [
      { query: { tab: string } },
    ];
    expect(parseProfileTab(route.query.tab)).toBe("account");
  });
});

describe("the copy", () => {
  it("names the Account tab, for a user who arrives by another route", () => {
    render(<InactiveBlocker />);

    expect(
      screen.getByText(/Account tab of your profile/i),
    ).toBeInTheDocument();
  });

  it("announces itself, because it covers the page the user was using", () => {
    render(<InactiveBlocker />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You are currently inactive",
    );
  });
});
