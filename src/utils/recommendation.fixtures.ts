import { Role, Status } from "@prisma/client";
import type { CarpoolSearch, Location } from "@prisma/client";
import type { FInputs } from "./recommendation";

/**
 * Test fixtures for `calculateScore`. Kept in their own module because
 * `recommendation.test.ts` and future router-level tests both need to build the
 * same joined `CarpoolSearch` shape.
 */

/**
 * The exact shape `calculateScore` consumes: a `CarpoolSearch` row joined to its
 * owning user and to its two `Location` rows.
 */
export type SearchFixture = CarpoolSearch & {
  user: { id: string };
  homeLocation: Location | null;
  companyLocation: Location | null;
};

export type Coord = { lat: number; lng: number };

/** Mirrors `MILES_PER_DEGREE_LATITUDE` inside recommendation.ts. */
const MILES_PER_DEGREE_LATITUDE = 69.09;

export const ORIGIN: Coord = { lat: 0, lng: 0 };

/** Boston, for tests that care about the latitude correction on longitude. */
export const BOSTON: Coord = { lat: 42.34, lng: -71.09 };

/** A coordinate exactly `miles` north of `ORIGIN`. */
export const milesNorth = (miles: number): Coord => ({
  lat: miles / MILES_PER_DEGREE_LATITUDE,
  lng: 0,
});

/** A coordinate exactly `miles` due north of `from`. */
export const milesNorthOf = (from: Coord, miles: number): Coord => ({
  lat: from.lat + miles / MILES_PER_DEGREE_LATITUDE,
  lng: from.lng,
});

/**
 * A coordinate exactly `miles` due east of `from`.
 *
 * A degree of longitude narrows with latitude, so the conversion needs the
 * cosine that `milesNorthOf` does not.
 */
export const milesEastOf = (from: Coord, miles: number): Coord => ({
  lat: from.lat,
  lng:
    from.lng +
    miles / (MILES_PER_DEGREE_LATITUDE * Math.cos((from.lat * Math.PI) / 180)),
});

/**
 * Local-time constructor, because the scoring code reads `Date#getHours` and
 * `Date#getMinutes`. Building the date in local time makes the fixture mean the
 * same thing in every timezone a developer or CI runner might use.
 */
export const at = (hour: number, minute = 0): Date =>
  new Date(2024, 0, 1, hour, minute, 0, 0);

export const day = (year: number, month: number, dayOfMonth: number): Date =>
  new Date(year, month - 1, dayOfMonth);

export const TERM_START = day(2024, 1, 1);
export const TERM_END = day(2024, 6, 1);

/** Monday through Friday, in the Sunday-indexed format the app stores. */
export const WEEKDAYS = "0,1,1,1,1,1,0";

const EPOCH = new Date(2024, 0, 1);

const location = (coord: Coord, id: string): Location => ({
  id,
  city: "Boston",
  state: "MA",
  street: "Huntington Ave",
  streetAddress: "360 Huntington Ave",
  coordLng: coord.lng,
  coordLat: coord.lat,
  dateCreated: EPOCH,
  dateModified: EPOCH,
});

export type SearchOptions = {
  id?: string;
  role?: Role;
  seatsAvail?: number;
  daysWorking?: string;
  startTime?: Date | null;
  endTime?: Date | null;
  coopStart?: Date | null;
  coopEnd?: Date | null;
  carpoolId?: string | null;
  /** `null` models a search whose Location relation did not load. */
  home?: Coord | null;
  company?: Coord | null;
  status?: Status;
};

/**
 * A fully populated search that lines up perfectly with `anyFilters()`: sitting on
 * the origin, working weekdays 9-to-5, term dates equal to the filter window. Tests
 * start from this and change only the dimension under test, so any score they see
 * is attributable to that one change.
 */
export const buildSearch = (options: SearchOptions = {}): SearchFixture => {
  const {
    id = "candidate",
    role = Role.DRIVER,
    seatsAvail = 4,
    daysWorking = WEEKDAYS,
    startTime = at(9),
    endTime = at(17),
    coopStart = TERM_START,
    coopEnd = TERM_END,
    carpoolId = null,
    home = ORIGIN,
    company = ORIGIN,
    status = Status.ACTIVE,
  } = options;

  return {
    id: `search-${id}`,
    userId: id,
    role,
    companyName: "Acme",
    companyLocationId: `company-${id}`,
    homeLocationId: `home-${id}`,
    startTime,
    endTime,
    startDate: coopStart,
    endDate: coopEnd,
    daysWorking,
    seatsAvail,
    status,
    carpoolId,
    groupMessage: null,
    groupNotes: null,
    groupMusicPreference: null,
    groupConversationStyle: null,
    dateCreated: EPOCH,
    dateModified: EPOCH,
    user: { id },
    homeLocation: home ? location(home, `home-${id}`) : null,
    companyLocation: company ? location(company, `company-${id}`) : null,
  };
};

/**
 * Filters with every cutoff disabled, so a test exercises only the filter it
 * overrides. Distances of 20 and times of 4 are the "any" sentinels the production
 * filter UI sends; `days: 0` and `dateOverlap: 0` mean no day or date requirement.
 */
export const anyFilters = (overrides: Partial<FInputs> = {}): FInputs => ({
  startDistance: 20,
  endDistance: 20,
  startTime: 4,
  endTime: 4,
  days: 0,
  flexDays: 0,
  startDate: TERM_START,
  endDate: TERM_END,
  dateOverlap: 0,
  daysWorking: WEEKDAYS,
  ...overrides,
});
