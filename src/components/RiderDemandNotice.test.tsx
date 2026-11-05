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
import { stubIntersectionObserverForEach } from "../testing/intersectionObserverStub";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

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
      // jsdom's default width is 1024, so these two blocks run as a desktop
      // reader. `the viewport dimension` below drives both sides explicitly.
      viewport: "desktop",
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
      viewport: "desktop",
    });
  });
});

/**
 * The gate, and what a green run here does and does not prove.
 *
 * jsdom does no layout, so no test in this file can show that the mobile
 * sheet's collapse actually produces a non-intersecting entry — there is no
 * geometry for an observer to read. What these cover is the logic either side
 * of that: that the notice is observed, that nothing is reported until the
 * observer says it is on screen, and that it is reported exactly once when it
 * is. The browser half is stated in the PR and is not asserted anywhere.
 *
 * `installIntersectionObserverStub` never fires on its own, so each negative
 * below is paired with the drive that makes it fire — otherwise "no event"
 * would be what a component wired to nothing also produces.
 */
describe("the impression gate", () => {
  const observer = stubIntersectionObserverForEach();

  it("observes the notice element itself", async () => {
    renderNotice(14);
    const region = await screen.findByRole("status");

    // Observing a wrapper, or the document, would report an impression for a
    // notice scrolled past rather than one seen.
    expect(observer().observed.length).toBeGreaterThan(0);
    expect(new Set(observer().observed)).toEqual(new Set([region]));

    // StrictMode attaches, detaches and re-attaches the ref, so the element is
    // legitimately observed more than once. What must not happen is two live
    // observers — which is why the stub records an array rather than a set.
    expect(observer().liveObservers).toBe(1);
  });

  it("reports nothing for a notice that is mounted but not on screen", async () => {
    renderNotice(14);
    await screen.findByRole("status");

    // The notice is in the DOM. On the explore page that is true in every
    // sheet detent, including the two that render it at zero height or
    // `display: none` — the defect this gate exists for.
    expect(trackShown).not.toHaveBeenCalled();

    // Positive control in the same harness, so the negative above is not
    // vacuous: this *can* fire, and does the moment the observer says so.
    observer().intersect(true);
    expect(trackShown).toHaveBeenCalledTimes(1);
  });

  it("reports once, however many times the notice crosses the edge", async () => {
    renderNotice(14);
    await screen.findByRole("status");

    observer().intersect(true);
    observer().intersect(false);
    observer().intersect(true);

    // Scrolling the sheet up and down is not three impressions.
    expect(trackShown).toHaveBeenCalledTimes(1);
  });

  it("holds a count that arrives while the notice is off screen until it is seen", async () => {
    // The actual race: the page mounts, the reader collapses the sheet or
    // opens a conversation, and `user.recommendations.riderDemand` resolves
    // afterwards. Rendering an already-suppressed notice would not catch this
    // — there would be no mount to count — so the count has to arrive second.
    const { rerender } = renderNotice(undefined);
    expect(notice()).toBeNull();

    rerender(
      <RiderDemandNotice
        count={14}
        role="RIDER"
        surface="empty-recommendations"
      />,
    );
    await screen.findByRole("status");

    expect(trackShown).not.toHaveBeenCalled();

    observer().intersect(true);
    expect(trackShown).toHaveBeenCalledTimes(1);
  });

  it("stops observing once the notice has been counted", async () => {
    renderNotice(14);
    const region = await screen.findByRole("status");
    observer().intersect(true);

    // Nothing left to watch for: the impression is recorded and the event
    // cannot fire again. A live observer per mounted notice would be a leak
    // that only shows up on a long-lived page.
    expect(observer().unobserved).toContain(region);
  });

  it("reports immediately where the browser has no observer to ask", async () => {
    // Fails open, deliberately. `IntersectionObserver` is universal in the
    // browsers this app supports, so this path is really about jsdom and
    // anything exotic — and in an analytics gate a missing API must not
    // silently stop the measurement, which would look exactly like a feature
    // nobody ever saw.
    observer().restore();
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;

    renderNotice(14);
    await screen.findByRole("status");

    expect(trackShown).toHaveBeenCalledTimes(1);
  });
});

describe("the viewport dimension", () => {
  const observer = stubIntersectionObserverForEach();
  restoreViewportAfterEach();

  it("reports a mobile reader as mobile", async () => {
    setViewportWidth(MOBILE_WIDTH);
    renderNotice(14, "VIEWER");
    await screen.findByRole("status");
    observer().intersect(true);

    expect(trackShown).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: "mobile" }),
    );
  });

  it("reports a desktop reader as desktop", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    renderNotice(14, "VIEWER");
    await screen.findByRole("status");
    observer().intersect(true);

    // The two surfaces render very differently on a phone, and without this
    // property the mobile and desktop readings cannot be separated at all.
    expect(trackShown).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: "desktop" }),
    );
  });

  it("carries the viewport on the dismissal too, not only the impression", async () => {
    const user = userEvent.setup();
    setViewportWidth(MOBILE_WIDTH);
    renderNotice(14);
    await screen.findByRole("status");
    observer().intersect(true);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    // A dismissal rate is a ratio of these two. Dimensioning one and not the
    // other leaves the ratio unsegmentable, which is the whole defect.
    expect(trackDismissed).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: "mobile" }),
    );
  });
});
