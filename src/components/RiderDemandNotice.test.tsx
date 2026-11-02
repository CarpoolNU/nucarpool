/**
 * The rider-demand notice: what it renders, what it refuses to render, and
 * that a dismissal sticks.
 *
 * The states this is really about are the ones nobody looks at — a `null`
 * count and a dismissed notice — because both are *absence*, and absence is
 * what a broken implementation also produces. Every negative assertion below
 * is therefore paired with a positive control in the same harness, per the
 * trap recorded for `queryByRole` inside an inert subtree: a query that
 * cannot match anything passes whether or not the component works.
 *
 * `localStorage` is real here — jsdom provides it — and cleared between tests.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RiderDemandNotice } from "./RiderDemandNotice";
import {
  RIDER_DEMAND_DISMISSED_KEY,
  readDismissed,
} from "../utils/riderDemand/dismissal";

const trackShown = jest.fn();
const trackDismissed = jest.fn();

jest.mock("../utils/mixpanel", () => ({
  trackRiderDemandShown: (properties: unknown) => trackShown(properties),
  trackRiderDemandDismissed: (properties: unknown) =>
    trackDismissed(properties),
}));

const renderNotice = (count: number | null | undefined, role = "RIDER") =>
  render(
    <RiderDemandNotice
      count={count}
      role={role}
      surface="empty-recommendations"
    />,
  );

/** The notice's region, or null. Keyed on the role, not on the copy. */
const notice = () => screen.queryByRole("status");

beforeEach(() => {
  window.localStorage.clear();
  trackShown.mockClear();
  trackDismissed.mockClear();
});

describe("what the notice renders", () => {
  it("states a count at or above the floor", async () => {
    renderNotice(14);

    expect(await screen.findByRole("status")).toHaveTextContent(
      /14 riders you could carpool with/i,
    );
  });

  it("points at the action that would show them", async () => {
    renderNotice(14);

    // The count on its own is a statistic. The ticket's whole argument is
    // that the reader does not know they are needed *or* what to do about it.
    expect(await screen.findByRole("status")).toHaveTextContent(
      /switching to driver/i,
    );
  });

  it("names no person, in the text or in any image", async () => {
    renderNotice(14);
    const region = await screen.findByRole("status");

    // "A count, never a list" is the design. Nothing identifying can reach
    // this component - it is handed a number - but a later change that passed
    // it a list would fail here rather than ship.
    expect(region.querySelectorAll("img")).toHaveLength(0);
    expect(region.textContent).not.toMatch(/@/);
  });
});

describe("what the notice refuses to render", () => {
  it("renders nothing for a suppressed count", async () => {
    renderNotice(null);

    // Positive control in the same harness, so the negative above is not
    // vacuous: the query *can* match when there is something to match.
    expect(notice()).toBeNull();
    renderNotice(14);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("renders nothing while the count is still in flight", () => {
    renderNotice(undefined);

    expect(notice()).toBeNull();
  });

  it("renders nothing, rather than a zero, when nobody is there", () => {
    // Zero never reaches here - the server floors it to `null` - but a caller
    // that passed the raw count would otherwise print "There are 0 riders you
    // could carpool with", which is the dead end this feature exists to
    // replace, with extra steps.
    renderNotice(0);

    expect(notice()).toBeNull();
  });
});

describe("dismissal", () => {
  it("disappears on dismiss and stays gone on the next render", async () => {
    const user = userEvent.setup();
    const first = renderNotice(14);
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(notice()).toBeNull();

    // A fresh mount is what a page load is. This is the acceptance criterion
    // - "not asked again on every load" - rather than the click working.
    first.unmount();
    renderNotice(14);
    expect(notice()).toBeNull();
  });

  it("writes the dismissal where a later session can read it", async () => {
    const user = userEvent.setup();
    renderNotice(14);
    await screen.findByRole("status");

    expect(readDismissed()).toBe(false);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(readDismissed()).toBe(true);
    expect(
      window.localStorage.getItem(RIDER_DEMAND_DISMISSED_KEY),
    ).not.toBeNull();
  });

  it("stays dismissed across both surfaces, not just the one it was dismissed on", async () => {
    const user = userEvent.setup();
    const first = renderNotice(14);
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    first.unmount();

    render(
      <RiderDemandNotice count={14} role="RIDER" surface="profile-role" />,
    );

    // One flag, one key. Dismissing on the explore page and then being asked
    // again on the profile page is the nagging the ticket warns about, and
    // would be the natural result of keying storage per surface.
    expect(notice()).toBeNull();
  });

  it("renders when storage cannot be read, rather than hiding", async () => {
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    try {
      renderNotice(14);
      // A reader in a private window has dismissed nothing. Failing closed
      // would lose them the feature silently; failing open shows it again.
      expect(await screen.findByRole("status")).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });

  it("still disappears when the dismissal cannot be written", async () => {
    const user = userEvent.setup();
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });

    try {
      renderNotice(14);
      await screen.findByRole("status");
      await user.click(screen.getByRole("button", { name: /dismiss/i }));

      // The click is the reader's instruction. A storage failure is not
      // something they can act on, and refusing to hide would make the button
      // look broken.
      expect(notice()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("the measurement", () => {
  it("reports a shown notice once, with the count, role and surface", async () => {
    renderNotice(14, "VIEWER");
    await screen.findByRole("status");

    // Once despite StrictMode's double-invoked effects, which is what the ref
    // in the component is for.
    expect(trackShown).toHaveBeenCalledTimes(1);
    expect(trackShown).toHaveBeenCalledWith({
      count: 14,
      role: "VIEWER",
      surface: "empty-recommendations",
    });
  });

  it("reports nothing for a suppressed count", () => {
    renderNotice(null);

    // A "shown" event for a notice nobody saw would put a floor of its own
    // under the conversion rate and make the funnel unreadable.
    expect(trackShown).not.toHaveBeenCalled();
  });

  it("reports nothing on a load where the reader had already dismissed", async () => {
    const user = userEvent.setup();
    const first = renderNotice(14);
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    first.unmount();
    trackShown.mockClear();

    renderNotice(14);
    expect(trackShown).not.toHaveBeenCalled();
  });

  it("reports the dismissal, which is the reading that can kill the feature", async () => {
    const user = userEvent.setup();
    renderNotice(14);
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(trackDismissed).toHaveBeenCalledWith({
      count: 14,
      role: "RIDER",
      surface: "empty-recommendations",
    });
  });
});
