import {
  checkSeedIntegrity,
  deleteAllData,
  SEED_DELETE_ORDER,
  SeedExpectation,
  SeedSnapshot,
  type SeedDeleteClient,
} from "./seed";
import { SeedGuardError } from "../src/utils/seedGuard";

/**
 * Safety regressions for the destructive half of the seed.
 *
 * `prisma/seed.ts` empties seven tables. The guard in `main()` is not the thing
 * under test here — `src/utils/seedGuard.test.ts` covers which targets are
 * refused — this file covers the property that matters after that decision is
 * made: **a refusal must reach zero deletes**, including when `deleteAllData`
 * is called directly rather than through `main()`.
 *
 * That is testable only because `deleteAllData` takes an injectable client. A
 * recording fake proves the delegates were never touched, which no assertion
 * against a real `PrismaClient` could do without a database to point it at —
 * and pointing one at a remote database to prove it stays untouched is exactly
 * the thing this guard exists to prevent.
 *
 * Importing this module runs no seed: `seed.ts` only calls `main()` under
 * `require.main === module`.
 */

const REMOTE_URLS = {
  "PlanetScale main":
    "mysql://main-user:not-a-real-password@aws.connect.psdb.cloud/nucarpool?sslaccept=strict",
  "PlanetScale staging":
    "mysql://staging-user:not-a-real-password@aws.connect.psdb.cloud/nucarpool-staging?sslaccept=strict",
  "an arbitrary remote host": "mysql://u:p@db.internal.example.com:3306/app",
  "a malformed URL": "not a url",
} as const;

const LOCAL_URLS = {
  localhost: "mysql://root:password@localhost:3306/nucoop",
  "127.0.0.1": "mysql://root:password@127.0.0.1:3306/nucoop",
  "::1": "mysql://root:password@[::1]:3306/nucoop",
  "the Compose service name": "mysql://root:password@mysql:3306/nucoop",
  "the Compose container name":
    "mysql://root:password@mysql-on-docker:3306/nucoop",
} as const;

/** A client that records every destructive call instead of making one. */
const recordingClient = () => {
  const deletes: string[] = [];
  const raw: string[] = [];

  const client = {
    $executeRawUnsafe: async (query: string) => {
      raw.push(query);
      return 0;
    },
  } as unknown as SeedDeleteClient & {
    $executeRawUnsafe: (query: string) => Promise<number>;
  };

  for (const model of SEED_DELETE_ORDER) {
    (client as unknown as Record<string, unknown>)[model] = {
      deleteMany: async () => {
        deletes.push(model);
        return { count: 0 };
      },
    };
  }

  return { client, deletes, raw };
};

describe("deleteAllData — the guard is on the primitive, not just the caller", () => {
  it.each(Object.entries(REMOTE_URLS))(
    "refuses %s and issues no delete at all",
    async (_name, url) => {
      const { client, deletes, raw } = recordingClient();

      await expect(
        deleteAllData(client, { DATABASE_URL: url }),
      ).rejects.toBeInstanceOf(SeedGuardError);

      // The assertion this file exists for. Not "the rows survived" — nothing
      // was even asked to delete them.
      expect(deletes).toEqual([]);
      expect(raw).toEqual([]);
    },
  );

  it("refuses a missing DATABASE_URL and issues no delete", async () => {
    const { client, deletes, raw } = recordingClient();

    await expect(deleteAllData(client, {})).rejects.toBeInstanceOf(
      SeedGuardError,
    );

    expect(deletes).toEqual([]);
    expect(raw).toEqual([]);
  });

  it("ignores the removed SEED_ALLOW_REMOTE override", async () => {
    // A stale value in a shell or a .env must not reopen the path SCRUM-410
    // closed.
    const { client, deletes } = recordingClient();

    await expect(
      deleteAllData(client, {
        DATABASE_URL: REMOTE_URLS["PlanetScale main"],
        SEED_ALLOW_REMOTE: "1",
      }),
    ).rejects.toBeInstanceOf(SeedGuardError);

    expect(deletes).toEqual([]);
  });

  it.each(Object.entries(LOCAL_URLS))("allows %s", async (_name, url) => {
    const { client, deletes } = recordingClient();

    await deleteAllData(client, { DATABASE_URL: url });

    expect(deletes).toEqual([...SEED_DELETE_ORDER]);
  });

  it("deletes in exactly the documented order", async () => {
    // SEED_DELETE_ORDER is the only source of truth, and this proves the loop
    // follows it rather than a second hand-written sequence beside it.
    const { client, deletes } = recordingClient();

    await deleteAllData(client, { DATABASE_URL: LOCAL_URLS.localhost });

    expect(deletes).toEqual([
      "request",
      "message",
      "conversation",
      "carpoolSearch",
      "location",
      "carpoolGroup",
      "user",
    ]);
  });

  it("clears the favorites join table before deleting users", async () => {
    // Prisma generates no model for an implicit m2m join table, so it cannot
    // appear in SEED_DELETE_ORDER and is cleared with one statement. It has to
    // happen while the users on either end still exist to be unambiguous.
    const { client, raw } = recordingClient();

    await deleteAllData(client, { DATABASE_URL: LOCAL_URLS.localhost });

    expect(raw).toEqual(["DELETE FROM `_Favorites`"]);
  });
});

/**
 * The seeded graph is built by hand across four `prisma.create` calls per
 * request, on a schema where `relationMode = "prisma"` means the database
 * enforces none of it. These exercise the checker on deliberately broken
 * fixtures, because a validation that has never failed is not known to work.
 */
describe("checkSeedIntegrity", () => {
  const expectation: SeedExpectation = {
    users: 2,
    groups: 1,
    messagesPerRequest: 2,
    locationsPerUser: 2,
  };

  /**
   * The same shape as {@link SeedSnapshot} with the arrays mutable, so a case
   * can break one field of an otherwise valid fixture in place.
   */
  type MutableSnapshot = {
    -readonly [K in keyof SeedSnapshot]: SeedSnapshot[K][number][];
  };

  /** A minimal fixture with the shape the real seed produces. */
  const consistent = (): MutableSnapshot => ({
    users: [{ id: "0" }, { id: "1" }],
    requests: [
      { id: "r0", fromUserId: "0", toUserId: "1", conversationId: "c0" },
      { id: "r1", fromUserId: "1", toUserId: "0", conversationId: "c1" },
    ],
    conversations: [
      { id: "c0", requestId: "r0" },
      { id: "c1", requestId: "r1" },
    ],
    messages: [
      { id: "m0", conversationId: "c0", userId: "0" },
      { id: "m1", conversationId: "c0", userId: "1" },
      { id: "m2", conversationId: "c1", userId: "1" },
      { id: "m3", conversationId: "c1", userId: "0" },
    ],
    searches: [
      {
        id: "s0",
        userId: "0",
        homeLocationId: "l0",
        companyLocationId: "l1",
        carpoolId: "g0",
      },
      {
        id: "s1",
        userId: "1",
        homeLocationId: "l2",
        companyLocationId: "l3",
        carpoolId: null,
      },
    ],
    locations: [{ id: "l0" }, { id: "l1" }, { id: "l2" }, { id: "l3" }],
    groups: [{ id: "g0" }],
  });

  it("reports nothing for a consistent fixture", () => {
    expect(checkSeedIntegrity(consistent(), expectation)).toEqual([]);
  });

  it("catches a self-request", () => {
    const snapshot = consistent();
    snapshot.requests[0].toUserId = snapshot.requests[0].fromUserId;

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "request r0 has the same user on both ends",
    );
  });

  it("catches a request that was never back-linked to its conversation", () => {
    // The failure `requests.me` and the unread badge would hit: both read the
    // thread through `Request.conversationId`.
    const snapshot = consistent();
    snapshot.requests[0].conversationId = null;

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "request r0 was not back-linked to its conversation",
    );
  });

  it("catches the two links disagreeing", () => {
    const snapshot = consistent();
    snapshot.requests[0].conversationId = "c1";

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "request r0 and conversation c0 disagree about their link",
    );
  });

  it("catches an orphan conversation", () => {
    // The exact defect class behind production's 620.
    const snapshot = consistent();
    snapshot.conversations.push({ id: "ghost", requestId: "gone" });

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "conversation ghost is orphaned — its request does not exist",
    );
  });

  it("catches an orphan message", () => {
    const snapshot = consistent();
    snapshot.messages.push({
      id: "stray",
      conversationId: "gone",
      userId: "0",
    });

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "message stray is orphaned — its conversation does not exist",
    );
  });

  it("catches a carpool search whose user was not seeded", () => {
    const snapshot = consistent();
    snapshot.searches[0].userId = "99";

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "carpool_search s0 is orphaned — its user does not exist",
    );
  });

  it("catches a carpool search pointing at a missing location", () => {
    const snapshot = consistent();
    snapshot.searches[0].homeLocationId = "gone";

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "carpool_search s0 points at a missing home location",
    );
  });

  it("catches a carpool search pointing at a missing group", () => {
    const snapshot = consistent();
    snapshot.searches[0].carpoolId = "gone";

    expect(checkSeedIntegrity(snapshot, expectation)).toContain(
      "carpool_search s0 points at a group that does not exist",
    );
  });

  it("accepts a carpool search in no group at all", () => {
    // Null is the ordinary case — only 40 of the seeded users get a group.
    const snapshot = consistent();
    snapshot.searches[0].carpoolId = null;

    expect(checkSeedIntegrity(snapshot, expectation)).toEqual([]);
  });

  it("catches a location nothing points at", () => {
    const snapshot = consistent();
    snapshot.locations.push({ id: "spare" });

    const problems = checkSeedIntegrity(snapshot, expectation);
    expect(problems).toContain(
      "location spare is orphaned — no carpool_search points at it",
    );
  });

  // A seed that silently produced fewer rows than the fixture describes is the
  // failure these counts exist for — a partial run that looked successful.
  it.each([
    ["user rows", (s: MutableSnapshot) => s.users.pop()],
    ["request rows", (s: MutableSnapshot) => s.requests.pop()],
    ["conversation rows", (s: MutableSnapshot) => s.conversations.pop()],
    ["message rows", (s: MutableSnapshot) => s.messages.pop()],
    ["carpool_search rows", (s: MutableSnapshot) => s.searches.pop()],
    ["location rows", (s: MutableSnapshot) => s.locations.pop()],
    ["group rows", (s: MutableSnapshot) => s.groups.pop()],
  ])("catches a short count of %s", (label, drop) => {
    const snapshot = consistent();
    drop(snapshot);

    expect(
      checkSeedIntegrity(snapshot, expectation).some((problem) =>
        problem.includes(label),
      ),
    ).toBe(true);
  });
});
