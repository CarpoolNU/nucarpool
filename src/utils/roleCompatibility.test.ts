import { Role, Status } from "@prisma/client";
import {
  canCarpoolTogether,
  carpoolUnavailableExplanation,
  roleMismatchExplanation,
} from "./roleCompatibility";

/**
 * The predicate that used to be spread across `requests.me`,
 * `getUnreadMessageCount` and the recommendation scorer, now in one place.
 *
 * What matters here is that it agrees with discovery about which pairs are
 * possible - `recommendation.ts` drops RIDER/RIDER, DRIVER/DRIVER and any
 * VIEWER, and `candidateSearch.ts`'s `compatibleRoles` is the SQL mirror of the
 * same rule - while `requests.me` no longer uses it to decide visibility.
 */
describe("canCarpoolTogether", () => {
  it("accepts one driver and one rider, in either order", () => {
    expect(canCarpoolTogether(Role.DRIVER, Role.RIDER)).toBe(true);
    expect(canCarpoolTogether(Role.RIDER, Role.DRIVER)).toBe(true);
  });

  it("rejects a pair with the same role", () => {
    expect(canCarpoolTogether(Role.DRIVER, Role.DRIVER)).toBe(false);
    expect(canCarpoolTogether(Role.RIDER, Role.RIDER)).toBe(false);
    expect(canCarpoolTogether(Role.VIEWER, Role.VIEWER)).toBe(false);
  });

  it("rejects a VIEWER on either side, because VIEWER is neither seat", () => {
    for (const other of [Role.DRIVER, Role.RIDER]) {
      expect(canCarpoolTogether(Role.VIEWER, other)).toBe(false);
      expect(canCarpoolTogether(other, Role.VIEWER)).toBe(false);
    }
  });
});

describe("roleMismatchExplanation", () => {
  it("explains nothing when the pair can carpool", () => {
    expect(roleMismatchExplanation(Role.DRIVER, Role.RIDER, "Alex")).toBeNull();
    expect(roleMismatchExplanation(Role.RIDER, Role.DRIVER, "Alex")).toBeNull();
  });

  it("names the shared role, and who would have to move, for two drivers", () => {
    const message = roleMismatchExplanation(
      Role.DRIVER,
      Role.DRIVER,
      "Alex",
    ) as string;

    expect(message).toContain("Alex");
    expect(message).toContain("both drivers");
    expect(message).toContain("switch to Rider");
  });

  it("does the same for two riders", () => {
    const message = roleMismatchExplanation(
      Role.RIDER,
      Role.RIDER,
      "Alex",
    ) as string;

    expect(message).toContain("Alex");
    expect(message).toContain("both riders");
    expect(message).toContain("switch to Driver");
  });

  it("points at the other person when they are the one in Viewer mode", () => {
    const message = roleMismatchExplanation(
      Role.RIDER,
      Role.VIEWER,
      "Alex",
    ) as string;

    expect(message).toContain("Alex has switched to Viewer mode");
  });

  it("points at the reader when they are the one in Viewer mode", () => {
    // Their own role is the one they can act on, so it wins even when both
    // sides are VIEWERs.
    for (const other of [Role.DRIVER, Role.RIDER, Role.VIEWER]) {
      const message = roleMismatchExplanation(
        Role.VIEWER,
        other,
        "Alex",
      ) as string;

      expect(message).toContain("You are in Viewer mode");
      expect(message).toContain("Switch to Driver or Rider");
    }
  });

  it("always explains a pair it calls incompatible, and never one it does not", () => {
    // The two exports cannot disagree: an unexplained refusal would leave the
    // Accept button hidden with nothing in its place.
    const roles = [Role.DRIVER, Role.RIDER, Role.VIEWER];

    for (const mine of roles) {
      for (const theirs of roles) {
        const explained =
          roleMismatchExplanation(mine, theirs, "Alex") !== null;
        expect(explained).toBe(!canCarpoolTogether(mine, theirs));
      }
    }
  });
});

/**
 * SCRUM-351: the favourites-tab wording.
 *
 * `favorites.me` used to hide a favourite whose role matched the reader's, was
 * VIEWER, or whose search was INACTIVE — which took away the card and with it
 * the only un-favourite star, so the `_Favorites` row became permanent and
 * invisible. They are shown explained instead, and this is the copy.
 *
 * Two things separate it from `roleMismatchExplanation`: status is not a role,
 * and that function's other-VIEWER branch ends "or clear the request", which is
 * request copy that would be wrong on a favourite.
 */
const other = (
  over: Partial<Parameters<typeof carpoolUnavailableExplanation>[1]> = {},
) => ({
  role: Role.DRIVER,
  status: Status.ACTIVE,
  preferredName: "Alex",
  ...over,
});

describe("carpoolUnavailableExplanation", () => {
  it("explains nothing for a compatible favourite who is still searching", () => {
    expect(carpoolUnavailableExplanation(Role.RIDER, other())).toBeNull();
    expect(
      carpoolUnavailableExplanation(Role.DRIVER, other({ role: Role.RIDER })),
    ).toBeNull();
  });

  it("answers a paused search first, because a paused search has no role to fit", () => {
    // Both incompatible *and* paused: the paused search is the fact reported,
    // since someone not searching at all makes their role beside the point.
    expect(
      carpoolUnavailableExplanation(
        Role.RIDER,
        other({ role: Role.RIDER, status: Status.INACTIVE }),
      ),
    ).toBe(
      "Alex has paused their carpool search, so you cannot carpool with them right now.",
    );
  });

  it("explains a paused search even when the roles would otherwise fit", () => {
    expect(
      carpoolUnavailableExplanation(
        Role.RIDER,
        other({ status: Status.INACTIVE }),
      ),
    ).toBe(
      "Alex has paused their carpool search, so you cannot carpool with them right now.",
    );
  });

  it("drops the request instruction when the other person is in Viewer mode", () => {
    const message = carpoolUnavailableExplanation(
      Role.RIDER,
      other({ role: Role.VIEWER }),
    );

    expect(message).toBe(
      "Alex has switched to Viewer mode and is not carpooling right now.",
    );
    // The requests version of this sentence continues "You can keep messaging
    // them, or clear the request." A favourite has no request to clear.
    expect(message).not.toContain("request");
    expect(roleMismatchExplanation(Role.RIDER, Role.VIEWER, "Alex")).toContain(
      "clear the request",
    );
  });

  it("names the reader's own Viewer mode ahead of the other person's", () => {
    // Both VIEWERs: the one the reader can act on is their own, which is the
    // behaviour inherited from `roleMismatchExplanation`.
    expect(
      carpoolUnavailableExplanation(Role.VIEWER, other({ role: Role.VIEWER })),
    ).toBe(
      "You are in Viewer mode, so you cannot carpool with Alex. " +
        "Switch to Driver or Rider in your profile.",
    );
  });

  it("shares the same-role wording with the requests copy", () => {
    // These three cases read correctly for a favourite as they stand, so they
    // are deliberately not reworded - this pins that they stay shared.
    for (const [reader, otherRole] of [
      [Role.RIDER, Role.RIDER],
      [Role.DRIVER, Role.DRIVER],
      [Role.VIEWER, Role.DRIVER],
    ] as const) {
      expect(
        carpoolUnavailableExplanation(reader, other({ role: otherRole })),
      ).toBe(roleMismatchExplanation(reader, otherRole, "Alex"));
    }
  });

  it("uses the preferred name it is given", () => {
    expect(
      carpoolUnavailableExplanation(
        Role.RIDER,
        other({ role: Role.RIDER, preferredName: "Jordan" }),
      ),
    ).toContain("Jordan");
  });
});
