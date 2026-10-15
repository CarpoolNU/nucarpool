/**
 * Which users the "Set to Viewer" control may be offered for, and what it says
 * when it may not.
 *
 * Tested as a function rather than through a render because the branching is
 * the whole of it: the control itself is one antd `Button` whose `disabled` and
 * `title` come straight from the value below. Driving the user picker to reach
 * each branch would mean clicking through an antd `Select`'s portal in jsdom
 * for no added coverage of the decision.
 *
 * **These rules deliberately duplicate the server's.** `setUserToViewer`
 * refuses a non-manager, a grouped user and an existing viewer regardless of
 * what the screen offers, and that is the boundary that counts — the repo's
 * own rule that a check belongs server-side "because it is the only place the
 * invariant cannot be routed around" applies here too. The copy exists so a
 * manager is told why a user is ineligible before clicking, instead of being
 * shown an error toast. If the two ever disagree, the server wins and this is
 * the one to fix.
 */

import { Permission, Role } from "@prisma/client";
import { AdminUser } from "../../utils/types";
import { viewerActionState } from "./viewerAction";

const user = (
  overrides: Partial<AdminUser> & {
    search?: { role: Role; carpoolId: string | null } | null;
  } = {},
): AdminUser => {
  const { search, ...rest } = overrides;
  return {
    id: "u1",
    email: "someone@northeastern.edu",
    permission: Permission.USER,
    carpoolSearches:
      search === null ? [] : [search ?? { role: Role.RIDER, carpoolId: null }],
    ...rest,
  };
};

describe("viewerActionState", () => {
  it("enables the action for an ungrouped rider when the caller is a manager", () => {
    expect(viewerActionState(user(), Permission.MANAGER)).toEqual({
      enabled: true,
    });
  });

  it("enables it for an ungrouped driver too", () => {
    const driver = user({ search: { role: Role.DRIVER, carpoolId: null } });

    expect(viewerActionState(driver, Permission.MANAGER)).toEqual({
      enabled: true,
    });
  });

  it("disables it for an admin, who cannot perform it", () => {
    const state = viewerActionState(user(), Permission.ADMIN);

    expect(state.enabled).toBe(false);
    expect(state).toHaveProperty("reason", expect.stringMatching(/manager/i));
  });

  it("disables it when no user is selected yet", () => {
    const state = viewerActionState(null, Permission.MANAGER);

    expect(state.enabled).toBe(false);
    expect(state).toHaveProperty("reason", expect.stringMatching(/select/i));
  });

  it("disables it for a user who is already a viewer", () => {
    const viewer = user({ search: { role: Role.VIEWER, carpoolId: null } });
    const state = viewerActionState(viewer, Permission.MANAGER);

    expect(state.enabled).toBe(false);
    expect(state).toHaveProperty("reason", expect.stringMatching(/already/i));
  });

  it("disables it for a user in a carpool group, naming the group as the reason", () => {
    // The server refuses this one to protect a group invariant, not merely to
    // be tidy: a group whose only driver became a viewer cannot be dissolved
    // by anyone. Saying so here is what stops a manager retrying it.
    const grouped = user({
      search: { role: Role.DRIVER, carpoolId: "group-1" },
    });
    const state = viewerActionState(grouped, Permission.MANAGER);

    expect(state.enabled).toBe(false);
    expect(state).toHaveProperty("reason", expect.stringMatching(/group/i));
  });

  it("disables it for a user who never set up a carpool search", () => {
    const state = viewerActionState(user({ search: null }), Permission.MANAGER);

    expect(state.enabled).toBe(false);
    expect(state).toHaveProperty(
      "reason",
      expect.stringMatching(/carpool search/i),
    );
  });

  it("reports the caller's permission before anything about the target", () => {
    // An admin looking at an ineligible user should be told the thing that is
    // true of every row for them, not a per-row reason that would change if
    // they picked someone else.
    const grouped = user({
      search: { role: Role.DRIVER, carpoolId: "group-1" },
    });
    const state = viewerActionState(grouped, Permission.USER);

    expect(state).toHaveProperty("reason", expect.stringMatching(/manager/i));
  });
});
