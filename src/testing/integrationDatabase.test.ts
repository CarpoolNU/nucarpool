import type { PrismaClient } from "@prisma/client";
import {
  MARKER_TABLE,
  PRESERVED_TABLES,
  claimIntegrationDatabase,
  describeApprovedTarget,
  describeRefusedClaim,
  discoverTables,
  dropClaimMarker,
  markIntegrationDatabase,
  truncateAll,
  type ApprovedTarget,
} from "./integrationDatabase";

/**
 * The harness's decisions, tested without a database.
 *
 * What table it would empty, what it would leave alone, and — the one that
 * matters — whether it writes anything at all to a database it does not
 * recognise. Those are set-arithmetic questions, so they belong in the fast
 * suite where they run on every push rather than only where MySQL is
 * available. `integrationDatabase.db.test.ts` covers the half that genuinely
 * needs a server.
 *
 * Importing this module opens no connection: every export takes its client as
 * an argument or builds one lazily, so nothing here reaches the guard either.
 */

/** A Prisma stand-in with only the two raw methods the harness uses. */
const buildRawClient = (tables: string[]) => {
  const client = {
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValue(tables.map((tableName) => ({ tableName }))),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };

  return {
    client: client as unknown as PrismaClient,
    calls: client,
    /** Every statement the harness sent, in order. */
    statements: () =>
      client.$executeRawUnsafe.mock.calls.map((call) => String(call[0])),
  };
};

const target: ApprovedTarget = {
  hostname: "127.0.0.1",
  databaseName: "nucarpool_test",
  url: "mysql://root:pw-must-not-appear@127.0.0.1:3306/nucarpool_test",
};

describe("discoverTables", () => {
  it("reads the names out of the information_schema rows", async () => {
    const { client } = buildRawClient(["user", "_Favorites"]);

    expect(await discoverTables(client)).toEqual(["user", "_Favorites"]);
  });

  it("scopes the query to the connected database rather than naming it", async () => {
    // `DATABASE()` keeps the schema name out of the SQL entirely, so it cannot
    // be got wrong and cannot be injected.
    const { client, calls } = buildRawClient([]);
    await discoverTables(client);

    const sql = String(calls.$queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain("information_schema.TABLES");
    expect(sql).toContain("TABLE_SCHEMA = DATABASE()");
    expect(sql).toContain("TABLE_TYPE = 'BASE TABLE'");
  });
});

describe("truncateAll", () => {
  it("empties every application table it finds", async () => {
    const { client, statements } = buildRawClient([
      "user",
      "carpool_search",
      "location",
    ]);

    const truncated = await truncateAll(client);

    expect(truncated).toEqual(["user", "carpool_search", "location"]);
    expect(statements()).toEqual([
      "TRUNCATE TABLE `user`",
      "TRUNCATE TABLE `carpool_search`",
      "TRUNCATE TABLE `location`",
    ]);
  });

  it("empties the implicit join table Prisma has no delegate for", async () => {
    // The reason discovery goes through information_schema at all: a
    // model-driven truncation cannot see `_Favorites`, and favourite rows
    // surviving between tests is order-dependence.
    const { client, statements } = buildRawClient(["user", "_Favorites"]);

    expect(await truncateAll(client)).toContain("_Favorites");
    expect(statements()).toContain("TRUNCATE TABLE `_Favorites`");
  });

  it.each([...PRESERVED_TABLES])("never touches %s", async (preserved) => {
    const { client, statements } = buildRawClient(["user", preserved]);

    const truncated = await truncateAll(client);

    expect(truncated).not.toContain(preserved);
    expect(statements()).toEqual(["TRUNCATE TABLE `user`"]);
  });

  it("preserves Prisma's bookkeeping and the harness's own marker", async () => {
    // Stated as the set rather than through the loop above, so removing an
    // entry from PRESERVED_TABLES fails here rather than silently reducing
    // what the loop covers.
    expect([...PRESERVED_TABLES].sort()).toEqual(
      ["_prisma_migrations", MARKER_TABLE].sort(),
    );
  });

  it.each([
    "user`; DROP TABLE user; --",
    "user table",
    "user-1",
    "..",
    "sch.user",
  ])("refuses to interpolate the unsafe name %p", async (unsafe) => {
    // Table names are the one value here that reaches SQL as an identifier,
    // and identifiers cannot be bound as parameters. They come from
    // information_schema in an approved database, so this is not defending
    // against anything realistic - it costs one regex and removes the
    // question.
    const { client, statements } = buildRawClient([unsafe]);

    await expect(truncateAll(client)).rejects.toThrow(/plain identifier/);
    expect(statements()).toEqual([]);
  });
});

describe("claimIntegrationDatabase", () => {
  it("adopts an empty database, and writes nothing while deciding", async () => {
    // The decision is read-only now. Marking is a separate step that has to
    // wait until after `prisma migrate deploy` - see the marking tests below.
    const { client, statements } = buildRawClient([]);

    expect(await claimIntegrationDatabase(client)).toEqual({
      claimed: true,
      reason: "empty-database",
      markerOnly: true,
    });

    expect(statements()).toEqual([]);
  });

  it("recognises a database it claimed before, and rewrites nothing", async () => {
    const { client, statements } = buildRawClient([
      MARKER_TABLE,
      "user",
      "_prisma_migrations",
    ]);

    expect(await claimIntegrationDatabase(client)).toEqual({
      claimed: true,
      reason: "already-claimed",
      markerOnly: false,
    });
    expect(statements()).toEqual([]);
  });

  it("flags a database holding only the marker, which is the P3005 trap", async () => {
    // Left by a run that claimed the database and then failed before
    // migrating. It is ours, so it is claimable - but its schema is not empty
    // and carries no `_prisma_migrations`, which is exactly what makes
    // `prisma migrate deploy` raise P3005. Before `markerOnly` existed, that
    // state was permanent: every later run took the already-claimed path
    // straight back into the same failure.
    const { client, statements } = buildRawClient([MARKER_TABLE]);

    expect(await claimIntegrationDatabase(client)).toEqual({
      claimed: true,
      reason: "already-claimed",
      markerOnly: true,
    });
    expect(statements()).toEqual([]);
  });

  it("refuses a database that holds tables it did not create", async () => {
    // The case the name rule cannot catch: a developer's own database called
    // `nucarpool_test`, on 127.0.0.1, which satisfies every rule in
    // testDatabaseGuard.ts.
    const { client } = buildRawClient([
      "user",
      "carpool_search",
      "_prisma_migrations",
    ]);

    expect(await claimIntegrationDatabase(client)).toEqual({
      claimed: false,
      reason: "not-ours",
      tables: ["user", "carpool_search", "_prisma_migrations"],
    });
  });

  it("writes absolutely nothing when it refuses", async () => {
    // The property the whole lock rests on. A claim that refused *after*
    // creating its marker, or after letting `migrate deploy` run, would have
    // already modified the database it was protecting.
    const { client, statements } = buildRawClient(["user", "message"]);

    const outcome = await claimIntegrationDatabase(client);

    expect(outcome.claimed).toBe(false);
    expect(statements()).toEqual([]);
  });

  it("does not adopt a database that merely has migrations applied", async () => {
    // `_prisma_migrations` alone is not a claim: it is what any Prisma
    // database has. Refusing this is a false negative for a database that
    // really was ours and lost its marker, and the remedy is to drop it.
    const { client, statements } = buildRawClient(["_prisma_migrations"]);

    expect(await claimIntegrationDatabase(client)).toMatchObject({
      claimed: false,
      reason: "not-ours",
    });
    expect(statements()).toEqual([]);
  });
});

describe("markIntegrationDatabase", () => {
  /**
   * The marking path reads a COUNT and then may write, so the table-listing
   * stub above is the wrong shape for it: one `$queryRawUnsafe` here returns a
   * count row rather than table names.
   */
  const buildMarkClient = (existingRows: number) => {
    const client = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValue([{ marker_rows: existingRows }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    return {
      client: client as unknown as PrismaClient,
      statements: () =>
        client.$executeRawUnsafe.mock.calls.map((call) => String(call[0])),
      queries: () =>
        client.$queryRawUnsafe.mock.calls.map((call) => String(call[0])),
    };
  };

  it("creates the marker table and records the claim", async () => {
    const { client, statements } = buildMarkClient(0);

    await markIntegrationDatabase(client);

    expect(statements()[0]).toContain(
      `CREATE TABLE IF NOT EXISTS \`${MARKER_TABLE}\``,
    );
    expect(statements()[1]).toContain(`INSERT INTO \`${MARKER_TABLE}\``);
  });

  it("is idempotent: a second run adds no second claim row", async () => {
    const { client, statements } = buildMarkClient(1);

    await markIntegrationDatabase(client);

    expect(statements()).toEqual([
      expect.stringContaining(`CREATE TABLE IF NOT EXISTS \`${MARKER_TABLE}\``),
    ]);
    expect(statements().join("\n")).not.toContain("INSERT INTO");
  });

  it("does not alias the count as `rows`, which MySQL 8 reserves", async () => {
    // `SELECT COUNT(*) AS rows` is a syntax error on MySQL 8.0, and this
    // statement only ever runs against a real server - so the fast suite is
    // the only place that can hold the line on it.
    const { client, queries } = buildMarkClient(0);

    await markIntegrationDatabase(client);

    expect(queries()[0]).toContain("AS marker_rows");
    expect(queries()[0]).not.toMatch(/\bAS rows\b/);
  });
});

describe("dropClaimMarker", () => {
  it("drops the marker and nothing else", async () => {
    const { client, statements } = buildRawClient([MARKER_TABLE]);

    await dropClaimMarker(client);

    expect(statements()).toEqual([`DROP TABLE IF EXISTS \`${MARKER_TABLE}\``]);
  });
});

describe("the messages the harness prints", () => {
  it("describes a target by host and database, never by URL", () => {
    const described = describeApprovedTarget(target);

    expect(described).toBe('database "nucarpool_test" on 127.0.0.1');
    expect(described).not.toContain(target.url);
    expect(described).not.toContain("pw-must-not-appear");
  });

  it("explains a refused claim without leaking the connection string", () => {
    const message = describeRefusedClaim(target, ["user", "carpool_search"]);

    expect(message).toContain("refusing to use");
    expect(message).toContain("user, carpool_search");
    expect(message).toContain("Nothing has been changed.");
    expect(message).not.toContain(target.url);
    expect(message).not.toContain("pw-must-not-appear");
  });

  it("truncates a very long table list rather than printing all of it", () => {
    const many = Array.from({ length: 30 }, (_, i) => `table_${i}`);

    const message = describeRefusedClaim(target, many);

    expect(message).toContain("30 table(s)");
    expect(message).toContain("...");
    expect(message).not.toContain("table_29");
  });
});
