import { Role } from "@prisma/client";
import {
  isUnresolvedCoordinate,
  latitudeSchema,
  longitudeSchema,
  unresolvedAddressFields,
} from "./coordinates";

/**
 * The coordinate contract shared by the form, `user.edit` and `getDirections`.
 * Two distinct failures: a value that is not a place at all, and
 * the in-range sentinel that means "no address picked yet".
 */

describe("longitudeSchema / latitudeSchema", () => {
  it("accepts a Boston point", () => {
    expect(longitudeSchema.safeParse(-71.0589).success).toBe(true);
    expect(latitudeSchema.safeParse(42.3601).success).toBe(true);
  });

  it("accepts the extremes of the WGS 84 range", () => {
    for (const lng of [-180, 180]) {
      expect(longitudeSchema.safeParse(lng).success).toBe(true);
    }
    for (const lat of [-90, 90]) {
      expect(latitudeSchema.safeParse(lat).success).toBe(true);
    }
  });

  it("rejects anything outside it", () => {
    for (const lng of [-180.1, 180.1, 1e9]) {
      expect(longitudeSchema.safeParse(lng).success).toBe(false);
    }
    // 100 is a valid longitude and an invalid latitude, which is the mistake a
    // swapped pair makes.
    for (const lat of [-90.1, 90.1, 100]) {
      expect(latitudeSchema.safeParse(lat).success).toBe(false);
    }
  });

  it("rejects NaN and Infinity", () => {
    // `Number.parseFloat` of a malformed value yields NaN, and every comparison
    // against it is false - so a bare `z.number()` let it through.
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(longitudeSchema.safeParse(value).success).toBe(false);
      expect(latitudeSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("isUnresolvedCoordinate", () => {
  it("recognises the [0, 0] sentinel", () => {
    expect(isUnresolvedCoordinate(0, 0)).toBe(true);
    expect(isUnresolvedCoordinate(-0, 0)).toBe(true);
  });

  it("leaves a point on one axis alone", () => {
    // Greenwich and the equator are real places. Only the pair is the sentinel;
    // treating either component alone as unresolved would be a false positive.
    expect(isUnresolvedCoordinate(0, 51.48)).toBe(false);
    expect(isUnresolvedCoordinate(-78.45, 0)).toBe(false);
  });

  it("leaves a real point alone", () => {
    expect(isUnresolvedCoordinate(-71.0589, 42.3601)).toBe(false);
  });
});

describe("unresolvedAddressFields", () => {
  const boston: [number, number] = [-71.0589, 42.3601];
  const somerville: [number, number] = [-71.0995, 42.3876];
  const unset: [number, number] = [0, 0];

  it("passes a rider with both addresses resolved", () => {
    expect(
      unresolvedAddressFields({
        role: Role.RIDER,
        home: somerville,
        company: boston,
      }),
    ).toEqual([]);
  });

  it("names the home field alone", () => {
    expect(
      unresolvedAddressFields({
        role: Role.RIDER,
        home: unset,
        company: boston,
      }),
    ).toEqual(["startAddress"]);
  });

  it("names the company field alone", () => {
    expect(
      unresolvedAddressFields({
        role: Role.DRIVER,
        home: somerville,
        company: unset,
      }),
    ).toEqual(["companyAddress"]);
  });

  it("names both when neither resolved", () => {
    expect(
      unresolvedAddressFields({
        role: Role.DRIVER,
        home: unset,
        company: unset,
      }),
    ).toEqual(["startAddress", "companyAddress"]);
  });

  it("exempts a VIEWER", () => {
    // A VIEWER has no Locations and `user.me` reports (0, 0) for them, so
    // refusing this would make their profile unsaveable.
    expect(
      unresolvedAddressFields({
        role: Role.VIEWER,
        home: unset,
        company: unset,
      }),
    ).toEqual([]);
  });
});
