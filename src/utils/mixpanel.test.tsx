/**
 * What `identifyUser` and `resetIdentity` actually hand to `mixpanel-browser`.
 *
 * `mixpanel-browser` is mocked locally rather than left to the
 * `moduleNameMapper` entry in `jest.config.js`. That stub is plain no-ops on
 * purpose - it is required once per suite and `clearMocks` is not configured,
 * so shared spies would accumulate calls across the files in a project and read
 * as flakiness. Its own comment points at exactly this route for a test that
 * wants to assert on what was tracked: a local `jest.mock` takes precedence
 * over the mapper.
 *
 * A `.test.tsx` despite containing no JSX, so that the file lands in the jsdom
 * project. The module under test is browser-only, and the mapper stub then
 * stands behind the local mock as a second line of defence - in the node
 * project a removed `jest.mock` here would silently load the real analytics
 * library rather than fail.
 *
 * The argument list is asserted *exactly*, not just its first element. The
 * criterion being pinned is a negative one - that no email address, name,
 * preferred name or bio reaches a third party - and `identify` accepts seven
 * further parameters after the distinct id, so "was called with the id" alone
 * would still pass if a profile object were appended to it.
 */

import { identifyUser, resetIdentity, trackEvent } from "./mixpanel";

/*
 * Only the four methods `utils/mixpanel` is allowed to use are defined, which
 * is load-bearing rather than merely minimal: `people.set` and `register` would
 * put profile properties into Mixpanel, and this ticket deliberately sends
 * none, so reaching for either throws here instead of passing quietly.
 *
 * The spies are created *inside* the factory and read back afterwards, rather
 * than declared above and closed over. `jest.mock` is hoisted above the import
 * of `./mixpanel`, and that module calls `mixpanel.init` at module scope - so a
 * factory referring to an outer `const` runs before the `const` initialises and
 * dies in the temporal dead zone, taking the whole suite out of the run.
 */
jest.mock("mixpanel-browser", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

const { track, identify, reset } = (
  jest.requireMock("mixpanel-browser") as {
    default: Record<"init" | "track" | "identify" | "reset", jest.Mock>;
  }
).default;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("identifyUser", () => {
  it("identifies with the User.id and nothing else", () => {
    identifyUser("cl9xq0000000user1");

    expect(identify.mock.calls).toEqual([["cl9xq0000000user1"]]);
  });

  it("sends no profile properties alongside the id", () => {
    identifyUser("cl9xq0000000user1");

    // The positive control for the negative assertion beside it: something
    // *was* sent, so a wrapper that silently did nothing cannot pass this file.
    expect(identify).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalled();
  });
});

describe("resetIdentity", () => {
  it("resets the distinct id, taking no arguments", () => {
    resetIdentity();

    expect(reset.mock.calls).toEqual([[]]);
  });
});

describe("the tracking helpers this ticket did not change", () => {
  it("still route through mixpanel.track, and identify nobody by themselves", () => {
    trackEvent("Sign In Attempt", { provider: "azure-ad" });

    expect(track).toHaveBeenCalledWith("Sign In Attempt", {
      provider: "azure-ad",
    });
    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});
