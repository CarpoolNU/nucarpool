/**
 * Which sessions get identified to Mixpanel, and which deliberately do not.
 *
 * `utils/mixpanel` is mocked rather than exercised: what is under test is the
 * decision of *when* to identify, and the call it eventually makes is pinned
 * separately in `src/utils/mixpanel.test.tsx`. The mock also stands in for the
 * component's deferred `import()`, which Jest resolves through the same module
 * registry.
 *
 * Every negative case below is paired with a positive control, because the
 * cheapest way to pass a file of `not.toHaveBeenCalled()` assertions is to
 * identify nobody at all.
 */

import { act, render, waitFor } from "@testing-library/react";
import { MixpanelIdentity } from "./MixpanelIdentity";

const useSession = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => useSession(),
}));

const identifyUser = jest.fn();
jest.mock("../utils/mixpanel", () => ({
  identifyUser: (userId: string) => identifyUser(userId),
}));

const USER_ID = "cl9xq0000000user1";

/**
 * A session shaped like the real one, PII included.
 *
 * `next-auth.d.ts` puts `email`, `name` and `image` on `session.user` through
 * `DefaultSession`, so they are genuinely in reach of anything holding the
 * session. Populating them is what lets the test below assert that reach was
 * not taken.
 */
const signedInAs = (id: string | undefined) =>
  useSession.mockReturnValue({
    status: "authenticated",
    data: {
      user: {
        id,
        email: "student@northeastern.edu",
        name: "A Student",
        image: null,
      },
    },
  });

const stillLoading = () =>
  useSession.mockReturnValue({ status: "loading", data: null });

const signedOut = () =>
  useSession.mockReturnValue({ status: "unauthenticated", data: null });

/**
 * Lets the component's deferred `import()` settle.
 *
 * The identify call is one microtask behind the effect, so a bare synchronous
 * assertion would report "not called" for the passing case too.
 */
const settle = () => waitFor(() => expect(identifyUser).toHaveBeenCalled());

/**
 * Drains the microtask queue, for the cases that assert nothing happened.
 *
 * `settle` cannot serve those - there is nothing to wait *for* - and a bare
 * synchronous `not.toHaveBeenCalled()` passes against a component with no
 * guards at all, because the identify call is two microtasks behind the
 * effect either way. Mutation testing caught exactly that: deleting the
 * `!userId` check below left all nine tests here green.
 *
 * A zero-delay timer rather than `await Promise.resolve()`, because the timer
 * callback is a macrotask and therefore runs only once every pending microtask
 * has, however many turns the deferred `import()` takes.
 */
const flushDeferredImport = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs(USER_ID);
});

describe("MixpanelIdentity with a signed-in user", () => {
  it("identifies them by their User.id", async () => {
    render(<MixpanelIdentity />);

    await settle();
    expect(identifyUser).toHaveBeenCalledWith(USER_ID);
  });

  it("identifies once, not once per StrictMode effect pass", async () => {
    /*
     * `jest.setup.dom.ts` renders every component test inside StrictMode,
     * because the app does. Effects therefore mount, clean up and mount again,
     * and an identify written without a guard runs twice - which is why the
     * component tracks the id it has already sent in a ref rather than relying
     * on the dependency array alone.
     */
    render(<MixpanelIdentity />);

    await settle();
    expect(identifyUser).toHaveBeenCalledTimes(1);
  });

  it("does not re-identify across an unrelated re-render", async () => {
    const { rerender } = render(<MixpanelIdentity />);
    await settle();

    rerender(<MixpanelIdentity />);

    expect(identifyUser).toHaveBeenCalledTimes(1);
  });

  it("re-identifies when a different user takes over the session", async () => {
    const { rerender } = render(<MixpanelIdentity />);
    await settle();

    signedInAs("cl9xq0000000user2");
    rerender(<MixpanelIdentity />);

    await waitFor(() => expect(identifyUser).toHaveBeenCalledTimes(2));
    expect(identifyUser).toHaveBeenLastCalledWith("cl9xq0000000user2");
  });

  it("sends the id alone - no email, name or image", async () => {
    render(<MixpanelIdentity />);

    await settle();
    // The whole argument list, so an added second parameter fails here.
    expect(identifyUser.mock.calls).toEqual([[USER_ID]]);
  });

  it("renders nothing", () => {
    const { container } = render(<MixpanelIdentity />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("MixpanelIdentity without a usable session", () => {
  /**
   * Proves the negative cases are not vacuous: the same component, rendered
   * again once the session resolves, does identify.
   */
  const thenResolvesToAUser = async (
    rerender: (ui: React.ReactElement) => void,
  ) => {
    signedInAs(USER_ID);
    rerender(<MixpanelIdentity />);
    await settle();
  };

  it("waits while the session is still loading", async () => {
    stillLoading();

    const { rerender } = render(<MixpanelIdentity />);

    await flushDeferredImport();
    expect(identifyUser).not.toHaveBeenCalled();
    await thenResolvesToAUser(rerender);
  });

  it("identifies nobody for a signed-out visitor", async () => {
    /*
     * Not merely "no event to send". `resetIdentity` is deliberately *not*
     * wired to this status either - next-auth reports it on every signed-out
     * page load, so resetting here would discard the anonymous distinct id,
     * and with it the first-touch referrer, on every visit to `/sign-in`.
     */
    signedOut();

    const { rerender } = render(<MixpanelIdentity />);

    await flushDeferredImport();
    expect(identifyUser).not.toHaveBeenCalled();
    await thenResolvesToAUser(rerender);
  });

  it("identifies nobody when the session carries no user id", async () => {
    /*
     * `next-auth.d.ts` declares `id` optional on `session.user`, so this is a
     * shape the types permit rather than a hypothetical. Passing `undefined`
     * to `mixpanel.identify` would leave the anonymous `$device:` id in place
     * and log an error, so the guard is worth pinning.
     */
    signedInAs(undefined);

    const { rerender } = render(<MixpanelIdentity />);

    await flushDeferredImport();
    expect(identifyUser).not.toHaveBeenCalled();
    await thenResolvesToAUser(rerender);
  });

  it("does not un-identify by passing an absent id through", async () => {
    /*
     * The case the check above genuinely exists for, and the reason this test
     * is separate from the one before it. On a *first* render the ref and a
     * missing id are both empty, so the once-only guard happens to absorb it;
     * only after somebody has been identified do the two disagree, and a
     * component missing the check reaches `identifyUser(undefined)` here.
     * `mixpanel.identify` would log an error and leave the anonymous
     * `$device:` id in place, silently detaching the rest of the session.
     */
    const { rerender } = render(<MixpanelIdentity />);
    await settle();

    signedInAs(undefined);
    rerender(<MixpanelIdentity />);

    await flushDeferredImport();
    expect(identifyUser.mock.calls).toEqual([[USER_ID]]);
  });
});
