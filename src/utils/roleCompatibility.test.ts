import { Role } from "@prisma/client";
import {
  canCarpoolTogether,
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
