import { PrismaClient, Role } from "@prisma/client";
import { range } from "lodash";
import Random from "random-seed";
import { generateUser } from "../src/utils/recommendation";
import {
  assertSeedTargetIsLocal,
  SeedEnvironment,
  SeedGuardError,
} from "../src/utils/seedGuard";
import {
  AddressResolver,
  createAddressResolver,
} from "../src/utils/seedAddresses";

const prisma = new PrismaClient();

/**
 * Every table the seed writes to, in an order safe to delete in.
 *
 * **The order is proved from `schema.prisma`, not assumed.** `relationMode =
 * "prisma"` means MySQL enforces no foreign key at all: every referential
 * action is emulated by Prisma Client, so an order that would merely be
 * inefficient under real constraints can here throw, or silently leave rows
 * behind. Three facts decide it, and each is a `@relation` in the schema:
 *
 *   1. **A required relation with no `onDelete` is `Restrict`, and Prisma
 *      enforces it.** `Request.fromUser` / `toUser` and `Message.User` are
 *      required relations to `User` with no action declared, and
 *      `CarpoolSearch.homeLocation` / `companyLocation` are required relations
 *      to `Location`. So `user` cannot go before `request` and `message`, and
 *      `location` cannot go before `carpoolSearch`. Reversing either pair does
 *      not orphan rows — it fails the run.
 *   2. **`Conversation` cascades outward, not inward.** The foreign key lives
 *      on `Request.conversationId` with `onDelete: Cascade`, and on
 *      `Message.conversationId` likewise. `Conversation.requestId` is a bare
 *      `@unique` *scalar* with no `@relation` behind it — nothing enforces it
 *      in either direction. That is why `conversation` sits after the two
 *      tables that point at it: by then both cascades are no-ops over empty
 *      tables, so what gets deleted is exactly what this list says.
 *   3. **`CarpoolSearch.carpool` is optional**, so its default action is
 *      `SetNull`. Deleting `carpoolGroup` first would emit a wave of
 *      `UPDATE`s on rows that are about to be deleted anyway; deleting
 *      `carpoolSearch` first makes it a no-op.
 *
 * `conversation` is in the list because it was once missed. With no
 * database-level foreign key, orphaned conversations simply survived a re-seed
 * pointing at deleted requests — and since `Conversation.requestId` is
 * `@unique`, a later request reusing an id would collide with one of those
 * ghosts. That is the same defect class as the 620 orphan conversations
 * SCRUM-295 found in production.
 *
 * **This tuple is the only source of truth.** {@link deletableModels} is typed
 * `Record<SeededModel, …>`, so a name added here without a delegate — or a
 * delegate without a name — is a compile error rather than a silent drift
 * between a documented order and an executed one.
 */
export const SEED_DELETE_ORDER = [
  "request",
  "message",
  "conversation",
  "carpoolSearch",
  "location",
  "carpoolGroup",
  "user",
] as const;

export type SeededModel = (typeof SEED_DELETE_ORDER)[number];

/** The one method {@link deleteAllData} needs from a Prisma model delegate. */
type Deletable = { deleteMany: (args: object) => Promise<{ count: number }> };

/**
 * The subset of `PrismaClient` the destructive half touches.
 *
 * Narrowed to an interface rather than taking `PrismaClient` so the tests can
 * pass a recording fake and prove that a refused target reaches **zero**
 * deletes. That property is the whole point of the guard, and it is not
 * provable against a real client without a database to point it at.
 */
export type SeedDeleteClient = Record<SeededModel, Deletable> & {
  $executeRawUnsafe: (query: string) => Promise<number>;
};

/**
 * Maps each name in {@link SEED_DELETE_ORDER} to the delegate that deletes it.
 *
 * The `Record<SeededModel, …>` annotation is what makes the two lists one:
 * TypeScript requires every member of the tuple to appear here, and rejects any
 * key that is not one.
 */
const deletableModels = (
  client: SeedDeleteClient,
): Record<SeededModel, Deletable> => ({
  request: client.request,
  message: client.message,
  conversation: client.conversation,
  carpoolSearch: client.carpoolSearch,
  location: client.location,
  carpoolGroup: client.carpoolGroup,
  user: client.user,
});

/**
 * The implicit many-to-many join table behind `User.favorites` /
 * `favoritedBy`.
 *
 * Prisma owns this table and generates no model for it, so it cannot appear in
 * {@link SEED_DELETE_ORDER} and there is no `prisma._favorites` to call. It is
 * cleared with one statement instead.
 *
 * **Why not rely on the emulated cascade.** Prisma may well remove the join
 * rows when the users on either end are deleted — but "may well" is the
 * problem, and no test in this repository can settle it, because the suite runs
 * on mocks and would only be asserting what the mock does. The failure mode if
 * it does not is specific and silent: the seed recreates users with the *same*
 * ids (`"0"`–`"69"`), so surviving join rows re-attach to the next seed's users
 * and favourites accumulate across runs. `requests.delete` deletes its messages
 * explicitly for exactly this reason — two explicit statements need no
 * assumption about what the client did.
 */
const FAVORITES_JOIN_TABLE = "_Favorites";

/**
 * Deletes every row the seed is responsible for.
 *
 * **Guarded independently of `main()`.** The entry point checks the target
 * before doing anything, and that is not enough on its own: this function is
 * exported, so an import, a future script, or a refactor that stops going
 * through `main()` would otherwise reach seven unconditional `deleteMany`
 * calls against whatever `DATABASE_URL` names. The check is cheap and runs
 * before the first statement, so the destructive primitive is safe by itself
 * rather than by convention.
 *
 * This also replaces the previous `clearConnections()` pass, which ran
 * immediately before it and issued roughly 4,900 no-op `favorites.disconnect`
 * writes against rows that were about to be deleted anyway.
 */
export const deleteAllData = async (
  client: SeedDeleteClient = prisma,
  env: SeedEnvironment = process.env,
) => {
  // First statement, before any delegate is touched. A refusal throws
  // SeedGuardError and nothing below runs.
  assertSeedTargetIsLocal(env);

  // Before `user`, since every join row references two of them.
  await client.$executeRawUnsafe(`DELETE FROM \`${FAVORITES_JOIN_TABLE}\``);

  const delegates = deletableModels(client);
  for (const model of SEED_DELETE_ORDER) {
    await delegates[model].deleteMany({});
  }
};

/**
 * Creates one request together with the conversation and messages the
 * application would have created alongside it.
 *
 * Mirrors `requests.create` in `src/server/router/user/requests.ts`: the request
 * carries an empty `message` column, the conversation is keyed by `requestId`,
 * the request is then back-linked through `conversationId`, and the greeting
 * lives in a `Message` row rather than on the request.
 *
 * A reply from the recipient is added as well, left unread, so the messaging UI
 * has a two-sided thread and an unread indicator to render locally.
 */
export const seedRequestWithConversation = async (
  fromUserId: string,
  toUserId: string,
) => {
  const request = await prisma.request.create({
    data: {
      message: "",
      fromUser: { connect: { id: fromUserId } },
      toUser: { connect: { id: toUserId } },
    },
  });

  const conversation = await prisma.conversation.create({
    data: { requestId: request.id },
  });

  await prisma.request.update({
    where: { id: request.id },
    data: { conversationId: conversation.id },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: fromUserId,
      content: `Hi! I saw we have similar commutes — want to carpool?`,
      isRead: true,
    },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: toUserId,
      content: `Sounds good, what time do you usually leave?`,
      isRead: false,
    },
  });

  return { requestId: request.id, conversationId: conversation.id };
};

/**
 * Generates requests between users in our database, each with a conversation
 * and messages so the messaging feature is exercisable against seeded data.
 */
const generateRequests = async (userIds: string[]) => {
  await Promise.all(
    userIds.map((_, idx) =>
      seedRequestWithConversation(
        idx.toString(),
        pickConnection(idx, userIds.length),
      ),
    ),
  );
};

/**
 * Generate a random number thats not the same as the userId
 * @param userId the userId
 * @param limit the limit of the number
 * @returns
 */
const pickConnection = (userId: number, limit: number) => {
  let rand = userId;
  while (rand === userId) {
    rand = Random.create()(limit);
  }
  return rand.toString();
};

/**
 * Generates favorites between users in our database.
 */
const generateFavorites = async (userIds: string[]) => {
  await Promise.all(
    userIds.map((_, idx) =>
      prisma.user.update({
        where: {
          id: `${idx}`,
        },
        data: {
          favorites: {
            connect: pickConnections(idx, userIds.length, 5),
          },
        },
      }),
    ),
  );
};

/**
 * Returns a list of connections for a given user.
 *
 * @param userId the user we're picking favorites for
 * @param userCount the total amount of users in our database
 * @param favoriteCount the number of favorites each user should have
 * @returns a list of objects with a single key ``id`` mapping to a int represented as a string
 */
const pickConnections = (
  userId: number,
  userCount: number,
  favoriteCount: number,
) => {
  const random = Random.create();
  return range(favoriteCount)
    .map(() => random(userCount))
    .filter((i) => i !== userId)
    .map((i) => {
      return { id: `${i}` };
    });
};

/**
 * How many groups the fixture builds, and how many members each gets.
 *
 * Named because the post-seed check has to know what to expect, and a literal
 * `10` in the loop plus a literal `[0..9]` in the `createMany` beside it were
 * two places to change and one to forget.
 */
const SEED_GROUP_COUNT = 10;
const SEED_GROUP_SIZE = 4;

/**
 * Generates favorites between users in our database.
 */
const generateGroups = async (
  userIds: string[],
): Promise<Map<string, string>> => {
  const userToGroupMap = new Map<string, string>();
  const groups: string[][] = [];
  let i = 0;
  for (let j = 0; j < SEED_GROUP_COUNT; j++) {
    for (let k = 0; k < SEED_GROUP_SIZE; k++) {
      (groups[j] ??= []).push(userIds[i]);
      i++;
    }
  }
  await prisma.carpoolGroup.createMany({
    data: range(SEED_GROUP_COUNT).map((idx) => ({
      id: idx.toString(),
      message: "hello",
    })),
  });

  // Build the mapping for later use when creating CarpoolSearch
  groups.forEach((group, idx) => {
    group.forEach((userId) => {
      userToGroupMap.set(userId, idx.toString());
    });
  });

  return userToGroupMap;
};

// Type for generated user data (includes all fields for CarpoolSearch/Location)
type GeneratedUserData = {
  id: string;
  role: Role;
  seatAvail: number;
  companyCoordLng: number;
  companyCoordLat: number;
  startCoordLng: number;
  startCoordLat: number;
  daysWorking: string;
  startTime: string;
  endTime: string;
  coopStartDate: Date | null;
  coopEndDate: Date | null;
  companyAddress: string;
  startAddress: string;
  companyStreet: string;
  companyCity: string;
  companyState: string;
  startStreet: string;
  startCity: string;
  startState: string;
};

/**
 * Creates users and adds them to the database.
 */
const createUserData = async (resolveAddress: AddressResolver) => {
  // updated function to handle async getRandomUsers
  const userGroups = await Promise.all([
    genRandomUsers(
      {
        // MISSION HILL => DOWNTOWN
        startCoordLat: 42.33,
        startCoordLng: -71.1,
        companyCoordLat: 42.35,
        companyCoordLng: -71.06,
        count: 30,
        seed: "sjafdlsdjfjadljflasjkfdl;",
      },
      resolveAddress,
    ),
    genRandomUsers(
      {
        // CAMPUS => WALTHAM
        startCoordLat: 42.34,
        startCoordLng: -71.09,
        companyCoordLat: 42.4,
        companyCoordLng: -71.26,
        count: 10,
        seed: "kajshdkfjhasdkjfhla",
      },
      resolveAddress,
    ),
    genRandomUsers(
      {
        // MISSION HILL => CAMBRIDGE
        startCoordLat: 42.32,
        startCoordLng: -71.095,
        companyCoordLat: 42.37,
        companyCoordLng: -71.1,
        count: 15,
        seed: "asjfwieoiroqweiaof",
        timezone: "UTC",
      },
      resolveAddress,
    ),
    genRandomUsers(
      {
        // BROOKLINE => FENWAY
        startCoordLat: 42.346,
        startCoordLng: -71.127,
        companyCoordLat: 42.344,
        companyCoordLng: -71.1,
        count: 15,
        seed: "dfsiuyisryrklewuoiadusruasi",
        timezone: "UTC",
      },
      resolveAddress,
    ),
  ]);

  const usersData: GeneratedUserData[] = userGroups
    .flat()
    .map((user, index) => ({
      id: index.toString(),
      ...user,
    }));

  await deleteAllData();

  // Create users with only non-migrated fields
  await Promise.all(
    usersData.map((userData) =>
      prisma.user.upsert(generateUser({ id: userData.id })),
    ),
  );

  const userIds = usersData.map((u) => u.id);

  // Generate groups and get the userId -> groupId mapping
  const userToGroupMap = await generateGroups(userIds);

  await Promise.all([generateFavorites(userIds), generateRequests(userIds)]);

  // create Location and CarpoolSearch records for each user
  for (const userData of usersData) {
    try {
      // A Location belongs to one slot of one CarpoolSearch, so every user gets
      // their own pair of rows. This used to reuse an existing row whose
      // address text matched, which silently gave the seeded user the *other*
      // user's coordinates - so local data did not reproduce the geometry the
      // recommendation algorithm is scored on.
      const homeLocation = await prisma.location.create({
        data: {
          street: userData.startStreet || "",
          city: userData.startCity || "",
          state: userData.startState || "",
          streetAddress: userData.startAddress || "",
          coordLng: userData.startCoordLng,
          coordLat: userData.startCoordLat,
        },
      });

      const companyLocation = await prisma.location.create({
        data: {
          street: userData.companyStreet || "",
          city: userData.companyCity || "",
          state: userData.companyState || "",
          streetAddress: userData.companyAddress || "",
          coordLng: userData.companyCoordLng,
          coordLat: userData.companyCoordLat,
        },
      });

      // get carpoolId from the mapping
      const carpoolId = userToGroupMap.get(userData.id) || null;

      // Parse time strings to Date objects
      const startTimeDate = userData.startTime
        ? new Date(userData.startTime)
        : null;
      const endTimeDate = userData.endTime ? new Date(userData.endTime) : null;

      // create CarpoolSearch
      await prisma.carpoolSearch.create({
        data: {
          userId: userData.id,
          role: userData.role as Role,
          status: "ACTIVE",
          seatsAvail: userData.seatAvail || 0,
          companyName: "Sandbox Inc.",
          daysWorking: userData.daysWorking || "",
          startTime: startTimeDate,
          endTime: endTimeDate,
          startDate: userData.coopStartDate,
          endDate: userData.coopEndDate,
          carpoolId: carpoolId,
          groupMessage: null,
          homeLocationId: homeLocation.id,
          companyLocationId: companyLocation.id,
        },
      });
    } catch (error) {
      // Fail the whole run. This used to log and continue, so a partially
      // seeded database — some users with no location or carpool search —
      // looked like a successful seed.
      throw new Error(
        `Failed to seed location and carpool search for user ${userData.id}`,
        { cause: error },
      );
    }
  }

  // Returned so `main` can check the result against what was asked for, rather
  // than against a number written down twice.
  return {
    users: usersData.length,
    groups: SEED_GROUP_COUNT,
    ...SEED_EXPECTATION,
  } satisfies SeedExpectation;
};

/**
 * Creates randomized users that can be deployed and used for testing the app.
 *
 * @param param0 An object specifying the options of the randomization,
 *               including the start/end coordinates to congregate data
 *               around, the offset of that congregation (how spread should
 *               the points be), the num of outputs, and a random seed.
 * @param resolveAddress resolves a coordinate to a street address
 * @returns An array of size "count" of generated user data, without ids.
 */
const genRandomUsers = async (
  {
    startCoordLat,
    startCoordLng,
    companyCoordLat,
    companyCoordLng,
    coordOffset = 0.03,
    count,
    seed,
    timezone,
  }: {
    startCoordLat: number;
    startCoordLng: number;
    companyCoordLat: number;
    companyCoordLng: number;
    coordOffset?: number;
    count: number;
    seed?: string;
    timezone?: string;
  },
  resolveAddress: AddressResolver,
): Promise<Omit<GeneratedUserData, "id">[]> => {
  const random = Random.create(seed);
  const doubleOffset = coordOffset * 2;
  const rand = (max: number) => max * random.random();

  const users = [];

  for (let i = 0; i < count; i++) {
    const startMin = 15 * Math.floor(rand(3.9));
    const endMin = 15 * Math.floor(rand(3.9));
    const startHour =
      timezone === "UTC" ? 2 + Math.floor(rand(3)) : 8 + Math.floor(rand(3));
    const endHour =
      timezone === "UTC" ? 10 + Math.floor(rand(3)) : 16 + Math.floor(rand(3));
    const startTime = new Date(2023, 0, 1, startHour, startMin).toISOString();
    const endTime = new Date(2023, 0, 1, endHour, endMin).toISOString();

    const userStartLat = startCoordLat - coordOffset + rand(doubleOffset);
    const userStartLng = startCoordLng - coordOffset + rand(doubleOffset);
    const userCompanyLat = companyCoordLat - coordOffset + rand(doubleOffset);
    const userCompanyLng = companyCoordLng - coordOffset + rand(doubleOffset);

    // Resolve structured address data. Offline and free unless
    // SEED_REVERSE_GEOCODE opts into Mapbox — see src/utils/seedAddresses.ts.
    const [startAddress, companyAddress] = await Promise.all([
      resolveAddress(userStartLng, userStartLat),
      resolveAddress(userCompanyLng, userCompanyLat),
    ]);

    const output = {
      role: "RIDER" as Role,
      seatAvail: 0,
      startTime,
      startCoordLat: userStartLat,
      startCoordLng: userStartLng,
      endTime,
      companyCoordLat: userCompanyLat,
      companyCoordLng: userCompanyLng,
      daysWorking: new Array(7)
        .fill(undefined)
        .map((_, ind) => (rand(1) < 0.5 ? "0" : "1"))
        .join(","),
      coopStartDate: null,
      coopEndDate: null,
      // Add the new structured address fields
      startStreet: startAddress.street,
      startCity: startAddress.city,
      startState: startAddress.state,
      companyStreet: companyAddress.street,
      companyCity: companyAddress.city,
      companyState: companyAddress.state,
      // Keep the old address fields for backward compatibility
      startAddress: startAddress.address,
      companyAddress: companyAddress.address,
    };

    if (rand(1) < 0.5) {
      users.push({
        ...output,
        role: "DRIVER" as Role,
        seatAvail: Math.ceil(rand(3)),
      });
    } else {
      users.push(output);
    }
  }

  return users;
};

/**
 * The rows the integrity check reads, in the shape it needs them.
 *
 * Deliberately a plain data structure rather than a client: the checking is
 * pure, so it can be exercised on hand-built inconsistent fixtures without a
 * database — which is the only way to test that the checks actually fail.
 */
export type SeedSnapshot = {
  users: readonly { id: string }[];
  requests: readonly {
    id: string;
    fromUserId: string;
    toUserId: string;
    conversationId: string | null;
  }[];
  conversations: readonly { id: string; requestId: string }[];
  messages: readonly { id: string; conversationId: string; userId: string }[];
  searches: readonly {
    id: string;
    userId: string;
    homeLocationId: string;
    companyLocationId: string;
    carpoolId: string | null;
  }[];
  locations: readonly { id: string }[];
  groups: readonly { id: string }[];
};

/** What the fixture is supposed to produce, per seeded user. */
export type SeedExpectation = {
  users: number;
  groups: number;
  /** Messages written per request: an opening message and one reply. */
  messagesPerRequest: number;
  /** Locations per user: home and company. */
  locationsPerUser: number;
};

export const SEED_EXPECTATION: Omit<SeedExpectation, "users" | "groups"> = {
  messagesPerRequest: 2,
  locationsPerUser: 2,
};

/**
 * Every invariant the seeded graph is supposed to hold, as a list of problems.
 *
 * **Why this exists at all.** `relationMode = "prisma"` means the database
 * enforces nothing: a request may point at a conversation that was never
 * created, a message may outlive its thread, and MySQL will not object. The
 * seed builds a two-way request/conversation/message graph by hand
 * (`seedRequestWithConversation`), and until now nothing checked the result.
 * Production already carries 620 orphan conversations from precisely this class
 * of mistake, found six months after the fact — a local fixture that reproduces
 * it silently is not a good place to develop the fix.
 *
 * Read-only and pure. It reports; the caller decides to throw.
 */
export const checkSeedIntegrity = (
  snapshot: SeedSnapshot,
  expected: SeedExpectation,
): string[] => {
  const problems: string[] = [];

  const userIds = new Set(snapshot.users.map((row) => row.id));
  const requestIds = new Set(snapshot.requests.map((row) => row.id));
  const conversationIds = new Set(snapshot.conversations.map((row) => row.id));
  const locationIds = new Set(snapshot.locations.map((row) => row.id));
  const groupIds = new Set(snapshot.groups.map((row) => row.id));

  const count = (actual: number, want: number, what: string) => {
    if (actual !== want) {
      problems.push(`expected ${want} ${what}, found ${actual}`);
    }
  };

  count(snapshot.users.length, expected.users, "user rows");
  count(snapshot.groups.length, expected.groups, "group rows");
  count(snapshot.requests.length, expected.users, "request rows");
  count(snapshot.conversations.length, expected.users, "conversation rows");
  count(
    snapshot.messages.length,
    expected.users * expected.messagesPerRequest,
    "message rows",
  );
  count(snapshot.searches.length, expected.users, "carpool_search rows");
  count(
    snapshot.locations.length,
    expected.users * expected.locationsPerUser,
    "location rows",
  );

  // A self-request is the defect `requests.create` refuses and production still
  // carries two of (SCRUM-409). `pickConnection` is supposed to make one
  // impossible; this proves it did rather than assuming the loop is correct.
  for (const request of snapshot.requests) {
    if (request.fromUserId === request.toUserId) {
      problems.push(`request ${request.id} has the same user on both ends`);
    }
    if (!userIds.has(request.fromUserId) || !userIds.has(request.toUserId)) {
      problems.push(
        `request ${request.id} references a user that was not seeded`,
      );
    }
    // Both links, because both are read: `requests.me` and the unread count go
    // through `Request.conversationId`, `getConversationMessages` through
    // `Conversation.requestId`. One of the two being right is not enough.
    if (request.conversationId === null) {
      problems.push(
        `request ${request.id} was not back-linked to its conversation`,
      );
    } else if (!conversationIds.has(request.conversationId)) {
      problems.push(
        `request ${request.id} points at a conversation that does not exist`,
      );
    }
  }

  const conversationsByRequest = new Map(
    snapshot.conversations.map((row) => [row.requestId, row]),
  );
  for (const request of snapshot.requests) {
    const conversation = conversationsByRequest.get(request.id);
    if (!conversation) {
      problems.push(`request ${request.id} has no conversation keyed to it`);
    } else if (request.conversationId !== conversation.id) {
      problems.push(
        `request ${request.id} and conversation ${conversation.id} disagree about their link`,
      );
    }
  }

  for (const conversation of snapshot.conversations) {
    if (!requestIds.has(conversation.requestId)) {
      problems.push(
        `conversation ${conversation.id} is orphaned — its request does not exist`,
      );
    }
  }

  for (const message of snapshot.messages) {
    if (!conversationIds.has(message.conversationId)) {
      problems.push(
        `message ${message.id} is orphaned — its conversation does not exist`,
      );
    }
    if (!userIds.has(message.userId)) {
      problems.push(
        `message ${message.id} was written by a user that was not seeded`,
      );
    }
  }

  const referencedLocations = new Set<string>();
  for (const search of snapshot.searches) {
    if (!userIds.has(search.userId)) {
      problems.push(
        `carpool_search ${search.id} is orphaned — its user does not exist`,
      );
    }
    for (const [slot, id] of [
      ["home", search.homeLocationId],
      ["company", search.companyLocationId],
    ] as const) {
      referencedLocations.add(id);
      if (!locationIds.has(id)) {
        problems.push(
          `carpool_search ${search.id} points at a missing ${slot} location`,
        );
      }
    }
    if (search.carpoolId !== null && !groupIds.has(search.carpoolId)) {
      problems.push(
        `carpool_search ${search.id} points at a group that does not exist`,
      );
    }
  }

  // The seed creates a fresh pair per user and reuses none, so every location
  // it wrote must be referenced. An unreferenced one is the residue
  // `cleanup-orphan-locations.ts` exists to delete in production.
  for (const location of snapshot.locations) {
    if (!referencedLocations.has(location.id)) {
      problems.push(
        `location ${location.id} is orphaned — no carpool_search points at it`,
      );
    }
  }

  return problems;
};

/** Thrown when the seeded data does not satisfy its own invariants. */
export class SeedIntegrityError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        `Seed completed but produced ${problems.length} inconsistency(ies):`,
        "",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "The data is local, so this is safe to investigate and re-run. It means",
        "the seed fixture is wrong, not that the database is.",
      ].join("\n"),
    );
    this.name = "SeedIntegrityError";
    this.problems = problems;
  }
}

/**
 * Reads the seeded rows back and throws if they are inconsistent.
 *
 * Read-only: it issues seven `findMany` calls and nothing else. A failure here
 * means the fixture is wrong; the local database is left as it is so the
 * problem can be inspected.
 */
export const validateSeededData = async (expected: SeedExpectation) => {
  const [
    users,
    requests,
    conversations,
    messages,
    searches,
    locations,
    groups,
  ] = await Promise.all([
    prisma.user.findMany({ select: { id: true } }),
    prisma.request.findMany({
      select: {
        id: true,
        fromUserId: true,
        toUserId: true,
        conversationId: true,
      },
    }),
    prisma.conversation.findMany({ select: { id: true, requestId: true } }),
    prisma.message.findMany({
      select: { id: true, conversationId: true, userId: true },
    }),
    prisma.carpoolSearch.findMany({
      select: {
        id: true,
        userId: true,
        homeLocationId: true,
        companyLocationId: true,
        carpoolId: true,
      },
    }),
    prisma.location.findMany({ select: { id: true } }),
    prisma.carpoolGroup.findMany({ select: { id: true } }),
  ]);

  const problems = checkSeedIntegrity(
    { users, requests, conversations, messages, searches, locations, groups },
    expected,
  );

  if (problems.length > 0) {
    throw new SeedIntegrityError(problems);
  }

  console.log(
    `Verified ${users.length} users, ${requests.length} requests, ` +
      `${messages.length} messages, ${searches.length} searches and ` +
      `${locations.length} locations are internally consistent.`,
  );
};

/**
 * Populates our database with fake data.
 */
const main = async () => {
  // First statement in the script. createUserData() wipes every table in
  // SEED_DELETE_ORDER, and it is reached by `yarn seed`, by a bare
  // `prisma db seed`, and by a database reset during `yarn db:schema` or
  // `prisma migrate reset`. Refuse anything that is not a local database before
  // doing any work.
  //
  // `deleteAllData` asserts this again for itself. The duplication is the point:
  // this call makes the refusal happen before the several seconds of address
  // generation that precede the first delete, and that one makes the primitive
  // safe no matter who calls it.
  const target = assertSeedTargetIsLocal();

  console.log(
    [
      `Target:  ${target.hostname} (local)`,
      `Action:  DELETING every existing row in ${SEED_DELETE_ORDER.join(", ")}`,
      `         and ${FAVORITES_JOIN_TABLE}, then inserting generated data.`,
      "",
    ].join("\n"),
  );

  const expectation = await createUserData(createAddressResolver());

  await validateSeededData(expectation);

  console.log(`Seeded ${target.hostname}.`);
};

// Only run when executed as a script (`prisma db seed` runs `ts-node
// prisma/seed.ts`). Guarding this keeps the module importable, so the helpers
// above can be exercised by tests without seeding anything.
if (require.main === module) {
  main()
    .catch((e) => {
      // A guard refusal is an expected, self-explanatory message rather than a
      // crash, so print it without a stack trace that would bury the reason.
      if (e instanceof SeedGuardError || e instanceof SeedIntegrityError) {
        console.error(e.message);
      } else {
        console.error(e);
      }
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
