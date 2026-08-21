import { CarpoolGroup, PrismaClient, Role, User } from "@prisma/client";
import { range } from "lodash";
import Random from "random-seed";
import { generateUser } from "../src/utils/recommendation";
import { timeEnd } from "console";
import {
  assertSeedTargetIsLocal,
  SEED_OVERRIDE_ENV,
  SeedGuardError,
} from "../src/utils/seedGuard";
import {
  AddressResolver,
  createAddressResolver,
} from "../src/utils/seedAddresses";

const prisma = new PrismaClient();

/**
 * Every table the seed writes to, in an order safe to delete in: rows that
 * reference another table go first.
 *
 * `conversation` is included because it was previously missed. Under
 * `relationMode = "prisma"` there is no database-level foreign key, so orphaned
 * conversations simply survived a re-seed pointing at deleted requests — and
 * since `Conversation.requestId` is `@unique`, a later request reusing an id
 * would collide with one of those ghosts.
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

/**
 * Deletes every row the seed is responsible for.
 *
 * This replaces the previous `clearConnections()` pass, which ran immediately
 * before this and issued roughly 4,900 no-op `favorites.disconnect` writes
 * against rows that were about to be deleted anyway.
 */
export const deleteAllData = async () => {
  await prisma.request.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.conversation.deleteMany({});
  await prisma.carpoolSearch.deleteMany({});
  await prisma.location.deleteMany({});
  await prisma.carpoolGroup.deleteMany({});
  await prisma.user.deleteMany({});
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
 * Generates favorites between users in our database.
 */
const generateGroups = async (
  userIds: string[],
): Promise<Map<string, string>> => {
  const userToGroupMap = new Map<string, string>();
  const groups: string[][] = [];
  let i = 0;
  for (let j = 0; j < 10; j++) {
    for (let k = 0; k < 4; k++) {
      (groups[j] ??= []).push(userIds[i]);
      i++;
    }
  }
  await prisma.carpoolGroup.createMany({
    data: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((idx) => ({
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
      // A Location belongs to one slot of one CarpoolSearch, so every user
      // gets their own pair of rows (SCRUM-232). This used to reuse an
      // existing row whose address text matched, which silently gave the
      // seeded user the *other* user's coordinates - so local data did not
      // reproduce the geometry the recommendation algorithm is scored on.
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
 * Updates the favorites of the user associated with the given ID.
 *
 * @param userId id for the user we're updating.
 * @param ids the ids to add to the current user
 */
const addFavorites = async (userId: string, ids: string[]) => {
  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      favorites: {
        connect: ids.map((id) => ({ id })),
      },
    },
  });
};

/**
 * Populates our database with fake data.
 */
const main = async () => {
  // First statement in the script. createUserData() wipes every table in
  // SEED_DELETE_ORDER, and it is reached by `yarn seed`, by `yarn build:preview`,
  // and by a database reset during `yarn db:schema`. Refuse anything that is not
  // a local database before doing any work.
  const target = assertSeedTargetIsLocal();

  if (target.reason === "override") {
    console.warn(
      `WARNING: ${SEED_OVERRIDE_ENV} is set. Seeding the NON-LOCAL host "${target.hostname}" and deleting its existing rows.`,
    );
  } else {
    console.log(
      `Seeding "${target.hostname}". Existing rows will be deleted first.`,
    );
  }

  await createUserData(createAddressResolver());
};

// Only run when executed as a script (`prisma db seed` runs `ts-node
// prisma/seed.ts`). Guarding this keeps the module importable, so the helpers
// above can be exercised by tests without seeding anything.
if (require.main === module) {
  main()
    .catch((e) => {
      // A guard refusal is an expected, self-explanatory message rather than a
      // crash, so print it without a stack trace that would bury the reason.
      if (e instanceof SeedGuardError) {
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
