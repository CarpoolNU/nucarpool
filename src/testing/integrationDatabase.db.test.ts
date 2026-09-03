import {
  MARKER_TABLE,
  PRESERVED_TABLES,
  approvedIntegrationTarget,
  describeApprovedTarget,
  discoverTables,
  integrationPrisma,
  truncateAll,
} from "./integrationDatabase";

/**
 * The harness testing itself.
 *
 * Everything else in the integration suite assumes two things: that the
 * database it is pointed at is a disposable test one, and that it is empty at
 * the start of every test. Those are properties of this module, so they are
 * asserted here rather than assumed by forty other files.
 *
 * **This file needs a real MySQL** and runs only through `yarn test:db`. It is
 * excluded from `yarn test` by the `\.db\.test\.ts$` pattern in
 * `jest.config.js`, which is what lets the mocked suite keep running with no
 * database and no Docker.
 */

const prisma = integrationPrisma();

/** `COUNT(*)` for a table Prisma has no delegate for. */
const countRows = async (table: string): Promise<number> => {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
    `SELECT COUNT(*) AS count FROM \`${table}\``,
  );
  return Number(rows[0].count);
};

describe("the approved target", () => {
  it("is a local, test-only database", () => {
    // The guard has already refused anything else - reaching this line at all
    // is most of the assertion. Restated so the suite says out loud which
    // database it is about to empty.
    const target = approvedIntegrationTarget();

    expect(target.databaseName.toLowerCase().split(/[_-]/)).toContain("test");
    expect(describeApprovedTarget(target)).toContain(target.hostname);
  });

  it("never puts the connection string in the description", () => {
    const target = approvedIntegrationTarget();
    expect(describeApprovedTarget(target)).not.toContain(target.url);
  });
});

describe("discoverTables", () => {
  it("finds every table the migration history creates", async () => {
    const tables = await discoverTables(prisma);

    // A subset rather than an exact list: a new model should not fail this
    // test, it should simply be truncated along with the rest. The names below
    // are the ones the application actually depends on existing.
    expect(tables).toEqual(
      expect.arrayContaining([
        "account",
        "carpool_search",
        "conversation",
        "group",
        "location",
        "message",
        "request",
        "session",
        "user",
        "verification_token",
      ]),
    );
  });

  it("finds the implicit many-to-many join table, which Prisma exposes no delegate for", async () => {
    // The reason this module asks `information_schema` instead of walking
    // Prisma's models. `_Favorites` backs `User.favorites`; a model-driven
    // truncation misses it entirely and leaves favourite rows standing between
    // tests.
    expect(await discoverTables(prisma)).toContain("_Favorites");
  });

  it("finds Prisma's own bookkeeping table too, so truncation has to exclude it", async () => {
    expect(await discoverTables(prisma)).toContain("_prisma_migrations");
    expect(PRESERVED_TABLES.has("_prisma_migrations")).toBe(true);
  });

  it("returns only plain identifiers, so nothing reaches TRUNCATE unquoted", async () => {
    for (const table of await discoverTables(prisma)) {
      expect(table).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});

describe("truncateAll", () => {
  it("empties a table Prisma does have a delegate for", async () => {
    await prisma.user.create({ data: { preferredName: "truncate-me" } });
    expect(await prisma.user.count()).toBe(1);

    await truncateAll(prisma);

    expect(await prisma.user.count()).toBe(0);
  });

  it("empties the join table Prisma has no delegate for", async () => {
    const [one, two] = await Promise.all([
      prisma.user.create({ data: { preferredName: "one" } }),
      prisma.user.create({ data: { preferredName: "two" } }),
    ]);
    await prisma.user.update({
      where: { id: one.id },
      data: { favorites: { connect: { id: two.id } } },
    });

    expect(await countRows("_Favorites")).toBe(1);

    await truncateAll(prisma);

    // The assertion that justifies the whole `information_schema` approach.
    expect(await countRows("_Favorites")).toBe(0);
  });

  it("leaves the migration bookkeeping alone", async () => {
    // Truncating `_prisma_migrations` would make the next `migrate deploy`
    // replay every migration into a database that already has the schema, so
    // the suite would work once and then never again.
    const before = await countRows("_prisma_migrations");
    expect(before).toBeGreaterThan(0);

    const truncated = await truncateAll(prisma);

    expect(truncated).not.toContain("_prisma_migrations");
    expect(await countRows("_prisma_migrations")).toBe(before);
  });

  it("reports what it emptied", async () => {
    const truncated = await truncateAll(prisma);

    expect(truncated).toContain("user");
    expect(truncated).toContain("_Favorites");
    expect(new Set(truncated).size).toBe(truncated.length);
  });
});

describe("the claim marker", () => {
  it("is present, because globalSetup claimed this database", async () => {
    // If this is missing, `prepareIntegrationDatabase` did not run - which
    // means the suite is talking to a database nothing approved.
    expect(await discoverTables(prisma)).toContain(MARKER_TABLE);
  });

  it("survives truncation, so a second run still recognises the database", async () => {
    const before = await countRows(MARKER_TABLE);
    expect(before).toBeGreaterThan(0);

    const truncated = await truncateAll(prisma);

    expect(truncated).not.toContain(MARKER_TABLE);
    expect(await countRows(MARKER_TABLE)).toBe(before);
  });

  it("says what claimed the database", async () => {
    const rows = await prisma.$queryRawUnsafe<{ note: string }[]>(
      `SELECT note FROM \`${MARKER_TABLE}\` LIMIT 1`,
    );

    expect(rows[0].note).toContain("integration test harness");
  });
});

describe("isolation between tests", () => {
  /*
   * These two run in declaration order and pass in either: the first inserts
   * its own row, and the second only asserts that nothing survived into it.
   * What they prove together is that the `beforeEach` in
   * jest.integration.setupAfterEnv.js is actually wired up - without it the
   * second test sees the first one's row.
   */
  it("leaves a row behind within its own test", async () => {
    await prisma.user.create({ data: { preferredName: "leaks?" } });

    expect(await prisma.user.count()).toBe(1);
  });

  it("starts from an empty database regardless", async () => {
    expect(await prisma.user.count()).toBe(0);
    expect(await countRows("_Favorites")).toBe(0);
  });
});
