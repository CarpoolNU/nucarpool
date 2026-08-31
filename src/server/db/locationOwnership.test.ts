import type { PrismaClient } from "@prisma/client";
import {
  findOrphanLocationIds,
  resolveOwnedLocations,
  type LocationFields,
} from "./locationOwnership";

/**
 * Tests for Location ownership.
 *
 * The bug these pin: `user.edit` matched an existing Location on street, city,
 * state and streetAddress and reused it as-is, so the coordinates the client
 * submitted were discarded and whoever saved a given address string first
 * decided where everyone else's pin went.
 *
 * The Prisma double below is not inert — `location.create` and
 * `location.update` mutate an in-memory store, so a test can assert the
 * *effect*: whose coordinates ended up where, and whether another user's row
 * moved. It models exactly the three queries this module issues and throws on
 * anything else, so a change in how the module talks to Prisma fails loudly
 * rather than passing against a mock that answers everything.
 *
 * It is a stand-in for a database, not a substitute for one. Real
 * multi-user behaviour needs a real database.
 */

type LocationRow = { id: string } & LocationFields;
type SearchRow = {
  id: string;
  homeLocationId: string;
  companyLocationId: string;
};

const fields = (overrides: Partial<LocationFields> = {}): LocationFields => ({
  street: "Huntington Ave",
  city: "Boston",
  state: "Massachusetts",
  streetAddress: "360 Huntington Ave",
  coordLng: -71.0892,
  coordLat: 42.3398,
  ...overrides,
});

const buildDb = (locations: LocationRow[], searches: SearchRow[]) => {
  const locationStore = new Map(locations.map((row) => [row.id, { ...row }]));
  const searchStore = searches.map((row) => ({ ...row }));
  let created = 0;

  const create = jest.fn(async ({ data }: { data: LocationFields }) => {
    const id = `loc-created-${++created}`;
    const row = { id, ...data };
    locationStore.set(id, row);
    return row;
  });

  const update = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: LocationFields;
    }) => {
      const row = locationStore.get(where.id);
      // Models Prisma rejecting an update whose `where` matches no row, so a
      // resolver that invents an id fails here instead of writing nowhere.
      if (!row) {
        throw new Error(`No location row matching where.id=${where.id}`);
      }
      Object.assign(row, data);
      return row;
    },
  );

  const findMany = jest.fn(async ({ where }: { where: any }) => {
    const or = where?.OR;
    if (
      !Array.isArray(or) ||
      or.length !== 2 ||
      !("homeLocationId" in or[0]) ||
      !("companyLocationId" in or[1])
    ) {
      throw new Error(
        `Unsupported carpoolSearch.findMany filter: ${JSON.stringify(where)}`,
      );
    }
    const homeId = or[0].homeLocationId;
    const companyId = or[1].companyLocationId;
    return searchStore
      .filter(
        (search) =>
          search.homeLocationId === homeId ||
          search.companyLocationId === companyId,
      )
      .map((search) => ({ id: search.id }));
  });

  return {
    prisma: {
      location: { create, update },
      carpoolSearch: { findMany },
    } as unknown as PrismaClient,
    locationById: (id: string) => locationStore.get(id),
    locationCount: () => locationStore.size,
    createCalls: create,
    updateCalls: update,
    /** Ids still pointed at by some CarpoolSearch, after applying a save. */
    referencedIds: (repointed: SearchRow[]) => {
      const applied = searchStore.map(
        (search) => repointed.find((r) => r.id === search.id) ?? search,
      );
      return new Set(
        applied.flatMap((s) => [s.homeLocationId, s.companyLocationId]),
      );
    },
    allIds: () => [...locationStore.keys()],
  };
};

const MY_HOME = fields({ coordLng: -71.1, coordLat: 42.31 });
const MY_COMPANY = fields({
  street: "Congress St",
  streetAddress: "1 Congress St",
  coordLng: -71.05,
  coordLat: 42.36,
});

describe("resolveOwnedLocations", () => {
  it("creates two fresh rows for a user who has no CarpoolSearch yet", async () => {
    const db = buildDb([], []);

    const { homeLocationId, companyLocationId } = await resolveOwnedLocations(
      db.prisma,
      {
        carpoolSearchId: null,
        currentHomeLocationId: null,
        currentCompanyLocationId: null,
        home: MY_HOME,
        company: MY_COMPANY,
      },
    );

    expect(homeLocationId).not.toBe(companyLocationId);
    expect(db.locationById(homeLocationId)).toMatchObject(MY_HOME);
    expect(db.locationById(companyLocationId)).toMatchObject(MY_COMPANY);
    expect(db.updateCalls).not.toHaveBeenCalled();
  });

  it("rewrites rows it exclusively owns rather than creating new ones", async () => {
    const db = buildDb(
      [
        { id: "loc-home", ...fields({ coordLng: 0, coordLat: 0 }) },
        { id: "loc-company", ...fields({ coordLng: 0, coordLat: 0 }) },
      ],
      [
        {
          id: "search-mine",
          homeLocationId: "loc-home",
          companyLocationId: "loc-company",
        },
      ],
    );

    const result = await resolveOwnedLocations(db.prisma, {
      carpoolSearchId: "search-mine",
      currentHomeLocationId: "loc-home",
      currentCompanyLocationId: "loc-company",
      home: MY_HOME,
      company: MY_COMPANY,
    });

    // Same rows, new coordinates. Nothing was orphaned because nothing moved.
    expect(result).toEqual({
      homeLocationId: "loc-home",
      companyLocationId: "loc-company",
    });
    expect(db.locationById("loc-home")).toMatchObject(MY_HOME);
    expect(db.locationById("loc-company")).toMatchObject(MY_COMPANY);
    expect(db.createCalls).not.toHaveBeenCalled();
    expect(db.locationCount()).toBe(2);
  });

  it("stores the submitted coordinates even when another user's row has the same address text", async () => {
    // This is the reported bug. Both users parse to identical street/city/
    // state/streetAddress, but they are at different points on a long street.
    const theirCoords = { coordLng: -71.2, coordLat: 42.4 };
    const db = buildDb(
      [{ id: "loc-theirs", ...fields(theirCoords) }],
      [
        {
          id: "search-theirs",
          homeLocationId: "loc-theirs",
          companyLocationId: "loc-theirs",
        },
      ],
    );

    const { homeLocationId } = await resolveOwnedLocations(db.prisma, {
      carpoolSearchId: "search-mine",
      currentHomeLocationId: null,
      currentCompanyLocationId: null,
      home: MY_HOME,
      company: MY_COMPANY,
    });

    expect(homeLocationId).not.toBe("loc-theirs");
    expect(db.locationById(homeLocationId)).toMatchObject({
      coordLng: MY_HOME.coordLng,
      coordLat: MY_HOME.coordLat,
    });
    // The other user must not have been moved.
    expect(db.locationById("loc-theirs")).toMatchObject(theirCoords);
  });

  it("refuses to rewrite a row another CarpoolSearch also points at", async () => {
    // Legacy data from the find-or-create era: two users share one row.
    const sharedCoords = { coordLng: -71.2, coordLat: 42.4 };
    const db = buildDb(
      [
        { id: "loc-shared", ...fields(sharedCoords) },
        { id: "loc-company", ...fields() },
      ],
      [
        {
          id: "search-mine",
          homeLocationId: "loc-shared",
          companyLocationId: "loc-company",
        },
        {
          id: "search-theirs",
          homeLocationId: "loc-shared",
          companyLocationId: "loc-shared",
        },
      ],
    );

    const { homeLocationId } = await resolveOwnedLocations(db.prisma, {
      carpoolSearchId: "search-mine",
      currentHomeLocationId: "loc-shared",
      currentCompanyLocationId: "loc-company",
      home: MY_HOME,
      company: MY_COMPANY,
    });

    expect(homeLocationId).not.toBe("loc-shared");
    expect(db.locationById("loc-shared")).toMatchObject(sharedCoords);
    // The shared row keeps its other reference, so nothing is orphaned.
    expect(
      db.referencedIds([
        {
          id: "search-mine",
          homeLocationId,
          companyLocationId: "loc-company",
        },
      ]),
    ).toContain("loc-shared");
  });

  it("keeps the row for home and gives company a new one when both slots share it", async () => {
    // Legal in today's data: a user whose home and work addresses parse
    // identically ends up with both columns on one row. Only one slot can
    // rewrite it, and abandoning it from both would orphan it.
    const db = buildDb(
      [{ id: "loc-both", ...fields({ coordLng: 0, coordLat: 0 }) }],
      [
        {
          id: "search-mine",
          homeLocationId: "loc-both",
          companyLocationId: "loc-both",
        },
      ],
    );

    const { homeLocationId, companyLocationId } = await resolveOwnedLocations(
      db.prisma,
      {
        carpoolSearchId: "search-mine",
        currentHomeLocationId: "loc-both",
        currentCompanyLocationId: "loc-both",
        home: MY_HOME,
        company: MY_COMPANY,
      },
    );

    expect(homeLocationId).toBe("loc-both");
    expect(companyLocationId).not.toBe("loc-both");
    expect(db.locationById("loc-both")).toMatchObject(MY_HOME);
    expect(db.locationById(companyLocationId)).toMatchObject(MY_COMPANY);

    // Every row that existed before the save is still referenced afterwards.
    const referenced = db.referencedIds([
      { id: "search-mine", homeLocationId, companyLocationId },
    ]);
    expect(referenced).toContain("loc-both");
  });

  describe.each([
    {
      name: "exclusively owned, separate rows",
      locations: ["a", "b"],
      searches: [{ id: "mine", homeLocationId: "a", companyLocationId: "b" }],
      currentHome: "a",
      currentCompany: "b",
    },
    {
      name: "exclusively owned, one row in both slots",
      locations: ["a"],
      searches: [{ id: "mine", homeLocationId: "a", companyLocationId: "a" }],
      currentHome: "a",
      currentCompany: "a",
    },
    {
      name: "home shared with another search",
      locations: ["a", "b"],
      searches: [
        { id: "mine", homeLocationId: "a", companyLocationId: "b" },
        { id: "theirs", homeLocationId: "a", companyLocationId: "a" },
      ],
      currentHome: "a",
      currentCompany: "b",
    },
    {
      name: "both slots shared with another search",
      locations: ["a"],
      searches: [
        { id: "mine", homeLocationId: "a", companyLocationId: "a" },
        { id: "theirs", homeLocationId: "a", companyLocationId: "a" },
      ],
      currentHome: "a",
      currentCompany: "a",
    },
    {
      name: "no existing search",
      locations: [],
      searches: [],
      currentHome: null,
      currentCompany: null,
    },
  ])("$name", (shape) => {
    // The invariant that makes a cleanup script a one-off rather than a
    // recurring chore: whatever the starting shape, a save leaves every
    // pre-existing row still pointed at by something.
    it("leaves no Location unreferenced", async () => {
      const db = buildDb(
        shape.locations.map((id) => ({ id, ...fields() })),
        shape.searches,
      );
      const before = db.allIds();

      const { homeLocationId, companyLocationId } = await resolveOwnedLocations(
        db.prisma,
        {
          carpoolSearchId: shape.searches.length ? "mine" : null,
          currentHomeLocationId: shape.currentHome,
          currentCompanyLocationId: shape.currentCompany,
          home: MY_HOME,
          company: MY_COMPANY,
        },
      );

      const referenced = db.referencedIds([
        { id: "mine", homeLocationId, companyLocationId },
      ]);

      expect([...referenced].sort()).toEqual(
        expect.arrayContaining(before.sort()),
      );
    });

    it("gives home and company separate rows", async () => {
      // One row in two slots cannot hold two addresses: whichever slot is
      // written second silently overwrites the first.
      const db = buildDb(
        shape.locations.map((id) => ({ id, ...fields() })),
        shape.searches,
      );

      const { homeLocationId, companyLocationId } = await resolveOwnedLocations(
        db.prisma,
        {
          carpoolSearchId: shape.searches.length ? "mine" : null,
          currentHomeLocationId: shape.currentHome,
          currentCompanyLocationId: shape.currentCompany,
          home: MY_HOME,
          company: MY_COMPANY,
        },
      );

      expect(homeLocationId).not.toBe(companyLocationId);
      expect(db.locationById(homeLocationId)).toMatchObject(MY_HOME);
      expect(db.locationById(companyLocationId)).toMatchObject(MY_COMPANY);
    });
  });
});

describe("findOrphanLocationIds", () => {
  it("returns rows no CarpoolSearch points at", () => {
    expect(
      findOrphanLocationIds(
        ["a", "b", "c", "d"],
        [
          { homeLocationId: "a", companyLocationId: "b" },
          { homeLocationId: "c", companyLocationId: "c" },
        ],
      ),
    ).toEqual(["d"]);
  });

  it("returns nothing when every row is referenced", () => {
    expect(
      findOrphanLocationIds(
        ["a", "b"],
        [{ homeLocationId: "a", companyLocationId: "b" }],
      ),
    ).toEqual([]);
  });

  it("treats every row as an orphan when there are no searches", () => {
    expect(findOrphanLocationIds(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("ignores null references rather than counting them as a reference", () => {
    // Both columns are non-nullable in the schema, but the reader that feeds
    // this hands over whatever the database returns. A null must never make
    // an unrelated row look referenced, and must never crash the diff.
    expect(
      findOrphanLocationIds(
        ["a", "b"],
        [
          { homeLocationId: null, companyLocationId: "b" },
          { homeLocationId: null, companyLocationId: null },
        ],
      ),
    ).toEqual(["a"]);
  });

  it("preserves the order it was given, so output is stable across runs", () => {
    expect(findOrphanLocationIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
  });
});
