import { Permission, Role, Status } from "@prisma/client";
import type { CarpoolSearch, Location } from "@prisma/client";
import {
  convertCarpoolSearchToPublic,
  convertCarpoolSearchToPublicWithExactHome,
  convertToPublic,
  roundCoord,
} from "./publicUser";
import type { User } from "./types";

/**
 * These converters are the boundary between a user's stored record and what other
 * users are allowed to see, so the interesting behaviour is what they drop, what
 * they rename, and how coarse they make a home address.
 */

const EPOCH = new Date(2024, 0, 1);

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@northeastern.edu",
  emailVerified: EPOCH,
  image: "https://example.test/ada.png",
  bio: "Commuting from Somerville",
  preferredName: "Ada",
  pronouns: "they/them",
  permission: Permission.MANAGER,
  isOnboarded: true,
  licenseSigned: true,
  dateCreated: EPOCH,
  dateModified: EPOCH,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: new Date(2024, 0, 1, 9),
  endTime: new Date(2024, 0, 1, 17),
  coopStartDate: new Date(2024, 0, 1),
  coopEndDate: new Date(2024, 5, 1),
  carpoolId: "group-1",
  groupMessage: "See you at 8:45",
  groupNotes: "Prefer the Green Line stop",
  groupMusicPreference: "Podcasts",
  groupConversationStyle: "Light chat",
  startCoordLng: -71.1,
  startCoordLat: 42.39,
  startStreet: "Highland Ave",
  startCity: "Somerville",
  startState: "MA",
  startAddress: "12 Highland Ave, Somerville, MA 02143",
  companyCoordLng: -71.05,
  companyCoordLat: 42.35,
  companyStreet: "Congress St",
  companyCity: "Boston",
  companyState: "MA",
  companyAddress: "100 Congress St",
  companyPOIAddress: "",
  companyPOICoordLng: 0,
  companyPOICoordLat: 0,
  startPOILocation: "",
  startPOICoordLng: 0,
  startPOICoordLat: 0,
  ...overrides,
});

const location = (overrides: Partial<Location> = {}): Location => ({
  id: "loc-1",
  city: "Somerville",
  state: "MA",
  street: "Highland Ave",
  streetAddress: "12 Highland Ave",
  coordLng: -71.1,
  coordLat: 42.39,
  dateCreated: EPOCH,
  dateModified: EPOCH,
  ...overrides,
});

// Derived from the *wider* converter on purpose. A row that carries an email is
// accepted by both, so the fixture can be handed to either - which is what lets
// the tests below prove the coarsened one drops it rather than never having it.
type SearchWithRelations = Parameters<
  typeof convertCarpoolSearchToPublicWithExactHome
>[0];

const buildSearch = (
  overrides: Partial<CarpoolSearch> = {},
  relations: Partial<
    Pick<SearchWithRelations, "homeLocation" | "companyLocation">
  > = {},
): SearchWithRelations => ({
  id: "search-1",
  userId: "user-1",
  role: Role.DRIVER,
  companyName: "Acme",
  companyLocationId: "loc-company",
  homeLocationId: "loc-home",
  startTime: new Date(2024, 0, 1, 9),
  endTime: new Date(2024, 0, 1, 17),
  startDate: new Date(2024, 0, 1),
  endDate: new Date(2024, 5, 1),
  daysWorking: "0,1,1,1,1,1,0",
  seatsAvail: 3,
  status: Status.ACTIVE,
  carpoolId: "group-1",
  groupMessage: "See you at 8:45",
  groupNotes: "Prefer the Green Line stop",
  groupMusicPreference: "Podcasts",
  groupConversationStyle: "Light chat",
  dateCreated: EPOCH,
  dateModified: EPOCH,
  ...overrides,
  user: {
    // The converter reads the joined user's id, so it follows userId.
    id: overrides.userId ?? "user-1",
    name: "Ada Lovelace",
    email: "ada@northeastern.edu",
    image: "https://example.test/ada.png",
    bio: "Commuting from Somerville",
    preferredName: "Ada",
    pronouns: "they/them",
  },
  homeLocation: location({ id: "loc-home" }),
  companyLocation: location({
    id: "loc-company",
    city: "Boston",
    street: "Congress St",
    streetAddress: "100 Congress St",
    coordLng: -71.05,
    coordLat: 42.35,
  }),
  ...relations,
});

/** Fields that must never reach another user, whichever converter produced the row. */
const SENSITIVE_FIELDS = [
  "permission",
  "emailVerified",
  "licenseSigned",
  "isOnboarded",
  "groupMessage",
  // Group ride preferences are for group members, delivered by `groups.me`
  // (SCRUM-253). They must not ride along on a map or recommendation result.
  "groupNotes",
  "groupMusicPreference",
  "groupConversationStyle",
  "startStreet",
  "startPOICoordLat",
  "startPOICoordLng",
];

describe("convertToPublic", () => {
  it("drops every sensitive field from the merged user record", () => {
    const result = convertToPublic(buildUser());

    for (const field of SENSITIVE_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("coarsens the home address to city and state, hiding the street", () => {
    const result = convertToPublic(
      buildUser({ startAddress: "12 Highland Ave, Somerville, MA 02143" }),
    );

    expect(result.startAddress).toBe("Somerville, MA");
    expect(result.startAddress).not.toContain("Highland");
  });

  it("falls back to the stored address when the city or state is missing", () => {
    expect(
      convertToPublic(buildUser({ startCity: "", startState: "MA" }))
        .startAddress,
    ).toBe("12 Highland Ave, Somerville, MA 02143");
    expect(
      convertToPublic(buildUser({ startCity: "Somerville", startState: "" }))
        .startAddress,
    ).toBe("12 Highland Ave, Somerville, MA 02143");
  });

  it("reports an explicit placeholder when no address information exists at all", () => {
    const result = convertToPublic(
      buildUser({ startCity: "", startState: "", startAddress: "" }),
    );

    expect(result.startAddress).toBe("Exact Location Unavailable");
  });

  it("keeps the company address exact, since that is not a home location", () => {
    expect(convertToPublic(buildUser()).companyAddress).toBe("100 Congress St");
  });

  it("passes through the fields other users need to evaluate a match", () => {
    const result = convertToPublic(buildUser());

    expect(result).toMatchObject({
      id: "user-1",
      preferredName: "Ada",
      pronouns: "they/them",
      role: Role.DRIVER,
      status: Status.ACTIVE,
      seatAvail: 3,
      companyName: "Acme",
      daysWorking: "0,1,1,1,1,1,0",
      carpoolId: "group-1",
    });
  });
});

describe("convertCarpoolSearchToPublic", () => {
  it("drops every sensitive field", () => {
    const result = convertCarpoolSearchToPublic(buildSearch());

    for (const field of SENSITIVE_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("reports the user's id, not the search row's id", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch({ id: "search-999", userId: "user-7" }),
    );

    expect(result.id).toBe("user-7");
  });

  it("renames the storage fields to the names the frontend expects", () => {
    // seatsAvail -> seatAvail, startDate/endDate -> coopStartDate/coopEndDate.
    const result = convertCarpoolSearchToPublic(
      buildSearch({
        seatsAvail: 2,
        startDate: new Date(2025, 0, 6),
        endDate: new Date(2025, 5, 27),
      }),
    );

    expect(result.seatAvail).toBe(2);
    expect(result.coopStartDate).toEqual(new Date(2025, 0, 6));
    expect(result.coopEndDate).toEqual(new Date(2025, 5, 27));
  });

  it("coarsens the home address to city and state", () => {
    expect(convertCarpoolSearchToPublic(buildSearch()).startAddress).toBe(
      "Somerville, MA",
    );
  });

  it("reports an explicit placeholder when the home Location is missing", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch({}, { homeLocation: null }),
    );

    expect(result.startAddress).toBe("Exact Location Unavailable");
    expect(result.startCoordLat).toBe(0);
    expect(result.startCoordLng).toBe(0);
  });

  it("returns an empty company address and zeroed coordinates when the company Location is missing", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch({}, { companyLocation: null }),
    );

    expect(result.companyAddress).toBe("");
    expect(result.companyCoordLat).toBe(0);
    expect(result.companyCoordLng).toBe(0);
  });

  it("produces the same public shape as convertToPublic for equivalent input", () => {
    const fromSearch = convertCarpoolSearchToPublic(buildSearch());
    const fromUser = convertToPublic(buildUser());

    expect(Object.keys(fromSearch).sort()).toEqual(
      Object.keys(fromUser).sort(),
    );
    expect(fromSearch).toEqual(fromUser);
  });
});

describe("home coordinate precision (SCRUM-226)", () => {
  /**
   * `startAddress` is deliberately coarsened to "City, State", but the raw home
   * coordinate used to ride along beside it in bulk responses, where it could
   * just be reverse-geocoded. The rule is now: neighbourhood precision by
   * default, full precision only for a counterpart.
   */
  const preciseHome = location({
    coordLng: -71.08874812,
    coordLat: 42.33907341,
  });

  it("coarsens the home coordinate for a viewer with no relationship", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch({}, { homeLocation: preciseHome }),
    );

    expect(result.startCoordLng).toBe(-71.09);
    expect(result.startCoordLat).toBe(42.34);
  });

  it("keeps the home coordinate exact for a counterpart", () => {
    const result = convertCarpoolSearchToPublicWithExactHome(
      buildSearch({}, { homeLocation: preciseHome }),
    );

    expect(result.startCoordLng).toBe(-71.08874812);
    expect(result.startCoordLat).toBe(42.33907341);
  });

  it("gives two users on different streets in one neighbourhood the same published point", () => {
    // The point of coarsening: a published coordinate should describe an area,
    // not a household, so nearby users become indistinguishable.
    const a = convertCarpoolSearchToPublic(
      buildSearch(
        {},
        { homeLocation: location({ coordLng: -71.0887, coordLat: 42.339 }) },
      ),
    );
    const b = convertCarpoolSearchToPublic(
      buildSearch(
        {},
        { homeLocation: location({ coordLng: -71.0912, coordLat: 42.3402 }) },
      ),
    );

    expect([a.startCoordLng, a.startCoordLat]).toEqual([
      b.startCoordLng,
      b.startCoordLat,
    ]);
  });

  it("leaves the company coordinate exact, because a workplace is not a home", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch(
        {},
        {
          companyLocation: location({
            coordLng: -71.05123456,
            coordLat: 42.35123456,
          }),
        },
      ),
    );

    expect(result.companyCoordLng).toBe(-71.05123456);
    expect(result.companyCoordLat).toBe(42.35123456);
  });

  it("reports zero rather than inventing a point when the home Location is missing", () => {
    const result = convertCarpoolSearchToPublic(
      buildSearch({}, { homeLocation: null }),
    );

    expect(result.startCoordLng).toBe(0);
    expect(result.startCoordLat).toBe(0);
  });
});

describe("roundCoord", () => {
  it.each([
    { input: 42.123456789, expected: 42.12346 },
    { input: -71.987654321, expected: -71.98765 },
    { input: 0, expected: 0 },
    { input: 42.1, expected: 42.1 },
  ])("rounds $input to five decimal places", ({ input, expected }) => {
    expect(roundCoord(input)).toBe(expected);
  });

  it("keeps roughly one metre of precision, enough to place a marker", () => {
    expect(roundCoord(42.360081234)).toBe(42.36008);
  });
});

/**
 * Who gets an email address (SCRUM-292).
 *
 * `PublicUser` carried `email` unconditionally, so the bulk list endpoints -
 * the map, recommendations, favorites - shipped every active user's
 * `@northeastern.edu` address to any signed-in viewer, on screens that never
 * displayed it. One request returned up to 150 of them; a VIEWER got the whole
 * ranked set. Only two consumers ever needed the field and both have a
 * relationship with the user.
 *
 * This is the same split SCRUM-226 built for home coordinates, applied to the
 * field that sat beside them in the struct and was missed at the time.
 */
describe("email disclosure (SCRUM-292)", () => {
  it("omits the email address for a viewer with no relationship", () => {
    // The fixture *does* carry an email, so this pins the converter dropping it
    // rather than a row that never had one. That matters: a caller whose
    // `include` still selects the column must not leak it through this path.
    const search = buildSearch();
    expect(search.user.email).toBe("ada@northeastern.edu");

    const result = convertCarpoolSearchToPublic(search);

    expect(result).not.toHaveProperty("email");
  });

  it("includes it for a counterpart", () => {
    const result = convertCarpoolSearchToPublicWithExactHome(buildSearch());

    expect(result.email).toBe("ada@northeastern.edu");
  });

  it("omits it from every record in a list, not just the first", () => {
    // The exposure was a bulk one, so the absence has to hold per record.
    const results = [
      buildSearch({ userId: "user-1" }),
      buildSearch({ userId: "user-2" }),
      buildSearch({ userId: "user-3" }),
    ].map(convertCarpoolSearchToPublic);

    for (const result of results) {
      expect(result).not.toHaveProperty("email");
    }
  });

  it("serialises to JSON with no email key at all", () => {
    // `not.toHaveProperty` would pass for a key set to undefined, which still
    // says "there is an email field here" to anyone reading the response.
    const serialised = JSON.parse(
      JSON.stringify(convertCarpoolSearchToPublic(buildSearch())),
    );

    expect(Object.keys(serialised)).not.toContain("email");
  });

  it("still coarsens the home coordinate when it omits the email", () => {
    // The two disclosures are governed by the same rule, so neither change
    // should have loosened the other.
    const result = convertCarpoolSearchToPublic(
      buildSearch(
        {},
        {
          homeLocation: location({
            coordLng: -71.08874812,
            coordLat: 42.33907341,
          }),
        },
      ),
    );

    expect(result).not.toHaveProperty("email");
    expect(result.startCoordLng).toBe(-71.09);
  });
});
