/**
 * That following the post-carpool feedback prompt is counted, and counted
 * apart from the same link in the account menu.
 *
 * The two feedback links point at one Jira form, so the destination alone
 * says nothing: what the ticket wants to know is whether the prompt shown
 * when a carpool ends converts better than the standing menu item. That is
 * the `surface` property, and it is the whole value of the event here -
 * an implementation that emitted `Link Clicked` with the right destination
 * and the wrong surface would read as the menu doing work the toast did.
 *
 * `mixpanel-browser` is mocked locally rather than left to the
 * `moduleNameMapper` stub, whose methods are deliberately plain no-ops with
 * nothing to assert against. See `src/testing/mixpanelBrowserStub.js`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CarpoolEndedToast } from "./CarpoolEndedToast";
import { FEEDBACK_FORM_URL } from "../../utils/feedbackForm";
import { suppressLinkNavigation } from "../../testing/suppressLinkNavigation";

jest.mock("mixpanel-browser", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

const { track } = (
  jest.requireMock("mixpanel-browser") as {
    default: Record<"init" | "track" | "identify" | "reset", jest.Mock>;
  }
).default;

const LINK_TEXT = "Tell us how the carpool went";

beforeEach(() => {
  jest.clearAllMocks();
  suppressLinkNavigation.install();
});

afterEach(suppressLinkNavigation.uninstall);

describe("CarpoolEndedToast", () => {
  it("counts the click against the toast, not the menu", async () => {
    render(<CarpoolEndedToast message="You left the carpool." />);

    await userEvent.click(screen.getByRole("link", { name: LINK_TEXT }));

    expect(track.mock.calls).toEqual([
      ["Link Clicked", { link: "feedback", surface: "carpool-ended-toast" }],
    ]);
  });

  it("still opens the feedback form in a new tab", async () => {
    render(<CarpoolEndedToast message="You left the carpool." />);

    const link = screen.getByRole("link", { name: LINK_TEXT });

    /*
     * The attributes tracking must not have disturbed. `target="_blank"` is
     * why the event is worth recording at all - the reader leaves for Jira
     * and may never come back to this tab - and `rel` is what keeps that tab
     * from reaching back through `window.opener`.
     */
    expect(link).toHaveAttribute("href", FEEDBACK_FORM_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    await userEvent.click(link);
    expect(link).toHaveAttribute("href", FEEDBACK_FORM_URL);
  });

  it("emits nothing when the toast is merely shown", () => {
    render(<CarpoolEndedToast message="You left the carpool." />);

    // The counterpart to the first case: were this to fire on render, the
    // dashboard would count everyone who ended a carpool as having answered.
    expect(track).not.toHaveBeenCalled();
  });
});
