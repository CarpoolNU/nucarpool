/**
 * That signing out also drops the Mixpanel identity, and only when the user
 * really does sign out.
 *
 * This is the shared-browser case: without a reset, the next person to use the
 * machine keeps emitting events against the previous user's distinct id, and
 * because `persistence: "localStorage"` those survive the tab being closed.
 *
 * It lives here rather than in a component test because this function is the
 * single choke point both sign-out buttons go through. The set of exits from
 * the profile page was famously not written down anywhere, and was discovered
 * one at a time across SCRUM-384 and SCRUM-468; putting the reset beside
 * `signOut` itself is what keeps a third button from missing it.
 *
 * A `.test.tsx` so it lands in the jsdom project. The module now imports
 * `utils/mixpanel`, which calls `mixpanel.init` at module scope, and the
 * `mixpanel-browser` stub in `jest.config.js` is scoped to that project.
 */

import { signOut } from "next-auth/react";
import { resetIdentity } from "../mixpanel";
import { signOutWithGuard, UnsavedChangesGuard } from "./signOutWithGuard";

jest.mock("next-auth/react", () => ({ signOut: jest.fn() }));
jest.mock("../mixpanel", () => ({ resetIdentity: jest.fn() }));

const mockSignOut = signOut as jest.MockedFunction<typeof signOut>;
const mockReset = resetIdentity as jest.MockedFunction<typeof resetIdentity>;

/** The order the two calls happened in, which is the half that matters. */
let order: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  mockReset.mockImplementation(() => {
    order.push("reset");
  });
  mockSignOut.mockImplementation(() => {
    order.push("signOut");
    return Promise.resolve(undefined as never);
  });
});

describe("signOutWithGuard with nothing to lose", () => {
  it("resets the Mixpanel identity and signs out", async () => {
    await signOutWithGuard();

    expect(order).toEqual(["reset", "signOut"]);
  });

  it("resets before signing out, not after", async () => {
    /*
     * Not a restatement of the assertion above. `signOut` navigates away, so a
     * reset queued behind it may never run at all - the ordering is the
     * behaviour, not an incidental detail of how the function is written.
     */
    await signOutWithGuard();

    expect(order.indexOf("reset")).toBeLessThan(order.indexOf("signOut"));
  });
});

describe("signOutWithGuard behind an unsaved-changes guard", () => {
  it("resets once the guard lets the sign-out proceed", async () => {
    const proceedImmediately: UnsavedChangesGuard = (proceed) => proceed();

    await signOutWithGuard(proceedImmediately);

    expect(order).toEqual(["reset", "signOut"]);
  });

  it("leaves the identity alone when the user cancels", async () => {
    // The guard holds `proceed` and never runs it, which is what `UnsavedModal`
    // does on Cancel: the user stays signed in with their edits still in the
    // form. Resetting there would orphan the rest of their session's events.
    const neverProceeds: UnsavedChangesGuard = () => undefined;

    await signOutWithGuard(neverProceeds);

    expect(order).toEqual([]);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
