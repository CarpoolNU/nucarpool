import { Prisma, Role, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../testing/integrationDatabase";
import type { Context } from "./context";
import { appRouter } from "./index";

/**
 * `user.me` and the referential actions, against a real MySQL.
 *
 * These are the two things the mocked suite is structurally unable to check. A
 * mocked `ctx.prisma` returns whatever the test told it to, so an `include`
 * naming a relation that does not exist, or a `select` naming a dropped
 * column, passes there and fails in production. And `relationMode = "prisma"`
 * means the foreign keys are emulated: `onDelete: Cascade` is executed by
 * Prisma's client, not by MySQL, so cascade behaviour is a property of the
 * query engine rather than of the schema file.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test, never in `beforeAll`: `jest.integration.setupAfterEnv.js`
 * truncates every table before each one.
 */

const prisma = integrationPrisma();

/** A session for a user id, shaped the way `createContext` produces one. */
const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

/** The real router over the real database. */
const callerFor = (userId: string) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/**
 * A user with one CarpoolSearch pointing at two distinct Locations — the shape
 * the whole data model assumes and that `user.me` flattens.
 */
const seedDriver = async () => {
  const user = await prisma.user.create({
    data: { name: "Ada Lovelace", email: "ada@northeastern.edu" },
  });

  const home = await prisma.location.create({
    data: {
      city: "Somerville",
      state: "MA",
      street: "Elm St",
      streetAddress: "12 Elm St",
      coordLng: -71.1,
      coordLat: 42.39,
    },
  });
  const company = await prisma.location.create({
    data: {
      city: "Boston",
      state: "MA",
      street: "Congress St",
      streetAddress: "1 Congress St",
      coordLng: -71.05,
      coordLat: 42.36,
    },
  });

  const search = await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: Role.DRIVER,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: 3,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });

  return { user, home, company, search };
};

describe("user.me against a real database", () => {
  it("resolves its nested include, so the relation traversal is real", async () => {
    // The assertion a mock cannot make. `me` issues one `findUnique` with
    // `carpoolSearches.include.{homeLocation,companyLocation}` — two levels of
    // relation across three tables. If any of those relation names or their
    // underlying columns were wrong, this line would throw rather than return.
    const { user, home, company } = await seedDriver();

    const me = await callerFor(user.id).user.me();

    expect(me.id).toBe(user.id);
    expect(me.startCity).toBe(home.city);
    expect(me.companyCity).toBe(company.city);
    expect(me.startCoordLat).toBeCloseTo(home.coordLat);
    expect(me.companyCoordLng).toBeCloseTo(company.coordLng);
  });

  it("renames the fields that change name across the API boundary", async () => {
    // `seatsAvail` -> `seatAvail` and `startDate`/`endDate` ->
    // `coopStartDate`/`coopEndDate`. The flattened shape is hand-maintained in
    // `src/utils/types.ts` rather than inferred from Prisma, so the rename is
    // exactly the kind of thing that drifts silently.
    const { user } = await seedDriver();

    const me = await callerFor(user.id).user.me();

    expect(me.seatAvail).toBe(3);
    expect(me).not.toHaveProperty("seatsAvail");
    expect(me).toHaveProperty("coopStartDate");
    expect(me).toHaveProperty("coopEndDate");
    expect(me.role).toBe(Role.DRIVER);
    expect(me.companyName).toBe("Acme Robotics");
  });

  it("falls back to VIEWER when the user has no CarpoolSearch at all", async () => {
    // `carpoolSearches[0]` on an empty array. Every flattened field has to
    // come back as its declared default rather than undefined, because the
    // frontend is typed as though they are always present.
    const user = await prisma.user.create({
      data: { name: "No Search", email: "nosearch@northeastern.edu" },
    });

    const me = await callerFor(user.id).user.me();

    expect(me.role).toBe(Role.VIEWER);
    expect(me.seatAvail).toBe(0);
    expect(me.companyName).toBe("");
    expect(me.startCoordLat).toBe(0);
    expect(me.coopStartDate).toBeNull();
  });

  it("throws NOT_FOUND for a session naming a user that no longer exists", async () => {
    // Authentication is not existence: a valid cookie can outlive its row.
    await expect(
      callerFor("cuid-that-was-deleted").user.me(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe('referential actions under relationMode = "prisma"', () => {
  it("cascades a user delete to their CarpoolSearch, because Prisma emulates it", async () => {
    // `CarpoolSearch.user` declares `onDelete: Cascade`. With
    // `relationMode = "prisma"` there is no foreign key in MySQL to enforce
    // that, so the cascade is executed by the query engine — which makes it a
    // behaviour worth asserting rather than reading off the schema.
    const { user, search } = await seedDriver();

    await prisma.user.delete({ where: { id: user.id } });

    expect(
      await prisma.carpoolSearch.findUnique({ where: { id: search.id } }),
    ).toBeNull();
  });

  it("does not cascade when the delete bypasses Prisma, which is the whole catch", async () => {
    // The same delete as raw SQL. MySQL has no constraint to act on, so the
    // child row survives and the database is left inconsistent. This is why
    // `relationMode = "prisma"` is a statement about the client and not about
    // the database, and why scripts in `scripts/` must go through Prisma.
    const { user, search } = await seedDriver();

    await prisma.$executeRawUnsafe("DELETE FROM `user` WHERE id = ?", user.id);

    const orphan = await prisma.carpoolSearch.findUnique({
      where: { id: search.id },
    });
    expect(orphan).not.toBeNull();
    expect(orphan?.userId).toBe(user.id);
  });

  it("leaves Location rows behind, which is the gap SCRUM-232 tracks", async () => {
    // Documenting current behaviour, not endorsing it. `CarpoolSearch` points
    // at two `Location` rows and declares no referential action on them, so
    // deleting the user cascades the search away and strands both locations.
    // When SCRUM-232 gives Locations an owner, this expectation is the one to
    // invert.
    const { user, home, company } = await seedDriver();

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.location.count()).toBe(2);
    expect(
      await prisma.location.findUnique({ where: { id: home.id } }),
    ).not.toBeNull();
    expect(
      await prisma.location.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
  });
});

describe("one CarpoolSearch per user", () => {
  /** A first-time profile save: a DRIVER with both addresses resolved. */
  const firstSave = (companyName: string) => ({
    role: Role.DRIVER,
    status: Status.ACTIVE,
    seatAvail: 3,
    companyName,
    preferredName: "Ada",
    pronouns: "",
    isOnboarded: true,
    daysWorking: "0,1,1,1,1,1,0",
    coopStartDate: null,
    coopEndDate: null,
    bio: "",
    startStreet: "Elm St",
    startCity: "Somerville",
    startState: "MA",
    startAddress: "12 Elm St",
    startCoordLng: -71.1,
    startCoordLat: 42.39,
    companyStreet: "Congress St",
    companyCity: "Boston",
    companyState: "MA",
    companyAddress: "1 Congress St",
    companyCoordLng: -71.05,
    companyCoordLat: 42.36,
  });

  it("rejects a second search for the same user", async () => {
    // The unique index is a real MySQL index even under
    // `relationMode = "prisma"`, so this is the database refusing, not Prisma.
    // The target is asserted too: it is the string `user.edit` matches on to
    // decide that a refused save lost the race and should be retried.
    const { user, home, company } = await seedDriver();

    const error = await prisma.carpoolSearch
      .create({
        data: {
          userId: user.id,
          homeLocationId: home.id,
          companyLocationId: company.id,
        },
      })
      .then(
        () => null,
        (rejection: unknown) => rejection,
      );

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({
      code: "P2002",
      meta: { target: "carpool_search_userId_key" },
    });
    expect(await prisma.carpoolSearch.count()).toBe(1);
  });

  it("resolves two concurrent first-time saves to one search", async () => {
    // The race SCRUM-544 closes. Two saves for a user with no search both read
    // "none" and both create one. Left to timing the race rarely fires, so the
    // test forces it: each save's first attempt takes its snapshot and then
    // waits at a barrier until the other has taken one too. From there the
    // interleaving is MySQL's - one save wins, the other's insert is refused
    // by the unique index, and `user.edit` retries it.
    const user = await prisma.user.create({
      data: { name: "Ada Lovelace", email: "ada@northeastern.edu" },
    });

    let attempts = 0;
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothSnapshotted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const racing = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") {
          return Reflect.get(target, property);
        }
        return (save: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          const attempt = ++attempts;
          return target.$transaction(async (tx) => {
            if (attempt <= 2) {
              // InnoDB fixes a transaction's snapshot at its first plain read.
              await tx.$queryRaw`SELECT 1 FROM carpool_search LIMIT 1`;
              if (++arrived === 2) release();
              await bothSnapshotted;
            }
            return save(tx);
          });
        };
      },
    });

    const callerOver = (client: typeof prisma) =>
      appRouter.createCaller({
        req: undefined,
        res: undefined,
        session: sessionFor(user.id),
        prisma: client,
        sesClient: { send: jest.fn() },
      } as unknown as Context);

    const results = await Promise.allSettled([
      callerOver(racing).user.edit(firstSave("First Co")),
      callerOver(racing).user.edit(firstSave("Second Co")),
    ]);

    // Neither save surfaced the refusal.
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    // Exactly one save lost and was retried. Two attempts would mean the race
    // never fired, and this test proved nothing.
    expect(attempts).toBe(3);

    const searches = await prisma.carpoolSearch.findMany({
      where: { userId: user.id },
    });
    expect(searches).toHaveLength(1);
    // The retry updated the winner's row. Which save won is MySQL's choice.
    expect(["First Co", "Second Co"]).toContain(searches[0]?.companyName);
    // The losing attempt's Location rows rolled back with it, and the retry
    // rewrote the winner's in place, so the save stranded nothing.
    expect(await prisma.location.count()).toBe(2);
  });
});
