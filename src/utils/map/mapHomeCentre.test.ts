import { Role } from "@prisma/client";
import {
  NEU_CENTRE,
  hasWorkplaceCentre,
  mapHomeCentre,
  mapHomeSubject,
} from "./mapHomeCentre";

/**
 * Where the map belongs, and what to call it.
 *
 * The defect this covers was a *disagreement* rather than a wrong answer:
 * `index.tsx` computed the initial centre with a VIEWER case and the Recentre
 * button's handler took the company coordinates unconditionally. So the
 * interesting assertions here are not "a VIEWER gets the campus" on its own -
 * they are that the point, the button's label and the predicate behind both
 * always agree, because two of those three disagreeing is the bug.
 */

const user = (over: Partial<Parameters<typeof mapHomeCentre>[0]> = {}) => ({
  role: Role.RIDER,
  companyCoordLng: -71.05,
  companyCoordLat: 42.36,
  ...over,
});

describe("mapHomeCentre", () => {
  it("centres a user with a resolved workplace on that workplace", () => {
    expect(mapHomeCentre(user())).toEqual([-71.05, 42.36]);
  });

  it("centres a VIEWER on campus rather than on (0, 0)", () => {
    // The production case. `user.me` reports `?? 0` for both components of a
    // missing `Location`, and a VIEWER has no `Location` at all - so the old
    // recentre handler flew a third of production into the Gulf of Guinea.
    expect(
      mapHomeCentre(
        user({ role: Role.VIEWER, companyCoordLng: 0, companyCoordLat: 0 }),
      ),
    ).toEqual(NEU_CENTRE);
  });

  it("keeps a VIEWER on campus even when stale company coordinates survive on the row", () => {
    // Switching DRIVER -> VIEWER leaves the old company location on the
    // `CarpoolSearch`. The role test is kept ahead of the coordinate test
    // precisely so a browsing user is not centred on a workplace they no
    // longer commute to, which is the behaviour SCRUM-508 settled.
    expect(mapHomeCentre(user({ role: Role.VIEWER }))).toEqual(NEU_CENTRE);
  });

  it("centres a non-VIEWER whose address never resolved on campus too", () => {
    // Not a VIEWER, but carrying the same `(0, 0)` sentinel - a profile saved
    // before its address resolved. The old role-only test sent these rows to
    // the Gulf as well; this is the case a role check alone does not reach.
    expect(
      mapHomeCentre(
        user({ role: Role.DRIVER, companyCoordLng: 0, companyCoordLat: 0 }),
      ),
    ).toEqual(NEU_CENTRE);
  });

  it("treats Greenwich and the equator as real places", () => {
    // `isUnresolvedCoordinate` matches the exact pair and nothing else, for
    // the reason `utils/coordinates.ts` sets out: longitude 0 alone is
    // Greenwich and latitude 0 alone is the equator. Rejecting either would be
    // a false positive, so neither falls back to campus.
    expect(mapHomeCentre(user({ companyCoordLng: 0 }))).toEqual([0, 42.36]);
    expect(mapHomeCentre(user({ companyCoordLat: 0 }))).toEqual([-71.05, 0]);
  });
});

describe("mapHomeSubject", () => {
  it("names the workplace only when there is one to name", () => {
    expect(mapHomeSubject(user())).toBe("workplace");
    expect(mapHomeSubject(user({ role: Role.VIEWER }))).toBe("campus");
    expect(
      mapHomeSubject(user({ companyCoordLng: 0, companyCoordLat: 0 })),
    ).toBe("campus");
  });
});

describe("the point and the label", () => {
  /**
   * The invariant the defect broke, asserted directly: the label says
   * "workplace" exactly when the destination *is* the workplace. A fix that
   * corrected the `flyTo` and left the copy promising a workplace would pass
   * every case above and fail here.
   */
  it.each([
    ["a rider with a workplace", user()],
    ["a viewer", user({ role: Role.VIEWER })],
    ["a viewer with stale coordinates", user({ role: Role.VIEWER })],
    [
      "an unresolved driver",
      user({ role: Role.DRIVER, companyCoordLng: 0, companyCoordLat: 0 }),
    ],
  ])("agree for %s", (_label, subject) => {
    const centre = mapHomeCentre(subject);
    const onWorkplace =
      centre[0] === subject.companyCoordLng &&
      centre[1] === subject.companyCoordLat;

    expect(mapHomeSubject(subject) === "workplace").toBe(onWorkplace);
    expect(hasWorkplaceCentre(subject)).toBe(onWorkplace);
  });
});
