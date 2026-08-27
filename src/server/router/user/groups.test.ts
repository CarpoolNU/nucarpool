import { Permission, Role, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import { MAX_SEATS_AVAILABLE } from "../../../utils/carpoolSeats";
import {
  GROUP_NOTES_MAX_LENGTH,
  GROUP_OPTION_MAX_LENGTH,
} from "../../../utils/textLimits";
import type { Context } from "../context";
import { cloneState, withTransaction } from "../transactionMock";

/**
 * Authorization tests for the carpool groups router (SCRUM-220).
 *
 * Every mutation was `protectedRouter` and nothing more, so group and user ids
 * arrived straight from client input: any signed-in student could dissolve
 * someone else's group, evict its riders, insert users, or rewrite the driver's
 * message. These tests pin the rule set the UI already implied — driver-only
 * delete/evict, riders may leave, joining needs a request.
 *
 * The driver's message is no longer among them: SCRUM-253 replaced the two
 * message mutations with `updatePreferences`, which writes only the caller's own
 * search, so there is no shared row left for a rider to hijack.
 *
 * Same `createCaller` + mocked-Prisma approach as `favorites.test.ts`,
 * `requests.test.ts` and `email.test.ts`. The mock applies writes to in-memory
 * rows so a test can assert that a rejected call *changed nothing*, which is
 * the property that actually matters here.
 */

const DRIVER = "user-driver";
const RIDER_1 = "user-rider-1";
const RIDER_2 = "user-rider-2";
const OUTSIDER = "user-outsider";
const GROUP = "group-1";
const OTHER_GROUP = "group-2";

type SearchRow = {
  id: string;
  userId: string;
  role: Role;
  carpoolId: string | null;
  seatsAvail: number;
  groupMessage: string;
  /** The SCRUM-253 preference columns. Null until a save writes all three. */
  groupNotes?: string | null;
  groupMusicPreference?: string | null;
  groupConversationStyle?: string | null;
};

type GroupRow = { id: string; message: string };

type RequestPair = [string, string];

const defaultSearches = (): SearchRow[] => [
  {
    id: "s-driver",
    userId: DRIVER,
    role: Role.DRIVER,
    carpoolId: GROUP,
    seatsAvail: 2,
    groupMessage: "",
  },
  {
    id: "s-rider-1",
    userId: RIDER_1,
    role: Role.RIDER,
    carpoolId: GROUP,
    seatsAvail: 0,
    groupMessage: "",
  },
  {
    id: "s-rider-2",
    userId: RIDER_2,
    role: Role.RIDER,
    carpoolId: GROUP,
    seatsAvail: 0,
    groupMessage: "",
  },
  {
    id: "s-outsider",
    userId: OUTSIDER,
    role: Role.RIDER,
    carpoolId: null,
    seatsAvail: 0,
    groupMessage: "",
  },
];

const buildGroupsDb = (opts?: {
  searches?: SearchRow[];
  groups?: GroupRow[];
  requests?: RequestPair[];
}) => {
  const searches = (opts?.searches ?? defaultSearches()).map((s) => ({ ...s }));
  const groups = new Map<string, GroupRow>(
    (opts?.groups ?? [{ id: GROUP, message: "original message" }]).map((g) => [
      g.id,
      { ...g },
    ]),
  );
  const requests = opts?.requests ?? [[DRIVER, RIDER_1]];

  // Understands the `seatsAvail: { gt: n }` filter that `reserveSeat` relies on
  // (SCRUM-229). Without it the mock matches on userId alone and the
  // compare-and-swap can never fail, which would make the seat tests vacuous.
  const matches = (row: SearchRow, where: any = {}) => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.carpoolId !== undefined && row.carpoolId !== where.carpoolId)
      return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    // `edit` and `delete` both resolve a group's driver with `{ carpoolId,
    // role: DRIVER }`. Without role matching that lookup returns whichever
    // member happens to be first, which would make the SCRUM-290 tests pass
    // against the unfixed code.
    if (where.role !== undefined && row.role !== where.role) return false;

    const seats = where.seatsAvail;
    if (seats !== undefined) {
      if (typeof seats === "number" && row.seatsAvail !== seats) return false;
      if (seats?.gt !== undefined && !(row.seatsAvail > seats.gt)) return false;
      if (seats?.gte !== undefined && !(row.seatsAvail >= seats.gte))
        return false;
    }

    return true;
  };

  const carpoolSearch = {
    findFirst: jest.fn(async ({ where }: any) => {
      const found = searches.find((r) => matches(r, where));
      return found ? { ...found } : null;
    }),
    findMany: jest.fn(async ({ where }: any) =>
      searches
        .filter((r) => matches(r, where))
        .map((r) => ({ ...r, user: { id: r.userId } })),
    ),
    // `edit` counts a group's members before letting its driver leave
    // (SCRUM-289).
    count: jest.fn(
      async ({ where }: any) =>
        searches.filter((r) => matches(r, where)).length,
    ),
    update: jest.fn(async ({ where, data }: any) => {
      const row = searches.find((r) => r.id === where.id);
      if (!row) throw new Error(`No carpoolSearch ${where.id}`);
      if (data.carpoolId !== undefined) row.carpoolId = data.carpoolId;
      if (typeof data.seatsAvail === "number") row.seatsAvail = data.seatsAvail;
      if (data.seatsAvail?.decrement)
        row.seatsAvail -= data.seatsAvail.decrement;
      if (data.groupMessage !== undefined) row.groupMessage = data.groupMessage;
      // The SCRUM-253 preference columns.
      if (data.groupNotes !== undefined) row.groupNotes = data.groupNotes;
      if (data.groupMusicPreference !== undefined)
        row.groupMusicPreference = data.groupMusicPreference;
      if (data.groupConversationStyle !== undefined)
        row.groupConversationStyle = data.groupConversationStyle;
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const affected = searches.filter((r) => matches(r, where));
      for (const row of affected) {
        if (data.carpoolId !== undefined) row.carpoolId = data.carpoolId;
        if (typeof data.seatsAvail === "number")
          row.seatsAvail = data.seatsAvail;
        if (data.seatsAvail?.decrement)
          row.seatsAvail -= data.seatsAvail.decrement;
        if (data.seatsAvail?.increment)
          row.seatsAvail += data.seatsAvail.increment;
      }
      return { count: affected.length };
    }),
  };

  const carpoolGroup = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `group-created-${groups.size + 1}`,
        message: data.message,
      };
      groups.set(row.id, row);
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const g = groups.get(where.id);
      return g ? { ...g } : null;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const g = groups.get(where.id);
      if (!g) throw new Error(`No group ${where.id}`);
      if (data.message !== undefined) g.message = data.message;
      return { ...g };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const g = groups.get(where.id);
      if (!g) throw new Error(`No group ${where.id}`);
      groups.delete(where.id);
      return { ...g };
    }),
  };

  // Seeded pairs start pending; `markRequestAccepted` moves them (SCRUM-228).
  const requestStatus = new Map<string, RequestStatus>(
    requests.map(([a, b]) => [`${a}|${b}`, RequestStatus.PENDING]),
  );

  const matchesPair = (clauses: any[], a: string, b: string) =>
    clauses.some((c) => c.fromUserId === a && c.toUserId === b);

  const request = {
    findFirst: jest.fn(async ({ where }: any) => {
      const clauses: any[] = where?.OR ?? [where ?? {}];
      const hit = requests.some(([a, b]) => matchesPair(clauses, a, b));
      return hit ? { id: "request-1" } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const clauses: any[] = where?.OR ?? [where ?? {}];
      let count = 0;
      for (const [a, b] of requests) {
        if (matchesPair(clauses, a, b)) {
          requestStatus.set(`${a}|${b}`, data.status);
          count += 1;
        }
      }
      return { count };
    }),
  };

  // The groups mutations wrap their writes in `prisma.$transaction`
  // (SCRUM-233), so the mock rolls back on a throw. Restoring in place matters:
  // the delegates above close over these exact references.
  const prisma = withTransaction(
    { carpoolSearch, carpoolGroup, request },
    () => ({
      searches: cloneState(searches),
      groups: cloneState(groups),
      requests: cloneState(requests),
      requestStatus: cloneState(requestStatus),
    }),
    (before) => {
      searches.length = 0;
      searches.push(...before.searches);
      groups.clear();
      for (const [id, row] of before.groups) groups.set(id, row);
      requests.length = 0;
      requests.push(...before.requests);
      requestStatus.clear();
      for (const [key, value] of before.requestStatus)
        requestStatus.set(key, value);
    },
  );

  return {
    prisma,
    groupIds: () => [...groups.keys()].sort(),
    seatsOf: (userId: string) =>
      searches.find((r) => r.userId === userId)?.seatsAvail,
    seatsOfSearch: (searchId: string) =>
      searches.find((r) => r.id === searchId)?.seatsAvail,
    messageOf: (id: string) => groups.get(id)?.message,
    /** The SCRUM-253 preference columns on a user's own search. */
    preferencesOf: (userId: string) => {
      const row = searches.find((r) => r.userId === userId);
      return row
        ? {
            groupNotes: row.groupNotes ?? null,
            groupMusicPreference: row.groupMusicPreference ?? null,
            groupConversationStyle: row.groupConversationStyle ?? null,
          }
        : undefined;
    },
    carpoolIdOf: (userId: string) =>
      searches.find((r) => r.userId === userId)?.carpoolId,
    /** Status of the seeded request between two users, in the seeded order. */
    requestStatusOf: (from: string, to: string) =>
      requestStatus.get(`${from}|${to}`),
    carpoolGroup,
    carpoolSearch,
    request,
  };
};

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (session: Session | null, db = buildGroupsDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;
  return { caller: appRouter.createCaller(ctx), db };
};

/**
 * `groups.me` and the states that are not failures (SCRUM-241).
 *
 * This query used to throw for two perfectly ordinary situations - NOT_FOUND
 * with no CarpoolSearch row, BAD_REQUEST with no group - so the client could not
 * tell "you are not in a group" from "the server is broken", and React Query
 * retried each on the way to an error state. It also spread the result of a
 * `findUnique` straight into its return value, so a membership pointing at a
 * deleted group produced an object with members but no id.
 */
describe("user.groups.me — no group is not an error", () => {
  it("returns the group for a member", async () => {
    const { caller } = callerFor(sessionFor(DRIVER));

    const group = await caller.user.groups.me();

    expect(group).not.toBeNull();
    expect(group?.id).toBe(GROUP);
  });

  it("returns null when the user is in no group", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-loner",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(caller.user.groups.me()).resolves.toBeNull();
  });

  it("returns null when the user has no CarpoolSearch row at all", async () => {
    // A VIEWER, or an onboarding that was never finished.
    const db = buildGroupsDb({ searches: [] });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(caller.user.groups.me()).resolves.toBeNull();
  });

  it("returns null, not a group-shaped object, when the group row is gone", async () => {
    // carpoolId still points at GROUP, but no such group exists any more.
    const db = buildGroupsDb({ groups: [] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const group = await caller.user.groups.me();

    expect(group).toBeNull();
    // The bug this replaces: `{ ...null, users: [...] }` is a truthy object with
    // members and no id, so every `group?.id` check downstream passed and then
    // read undefined.
    expect(group).not.toEqual(
      expect.objectContaining({ users: expect.anything() }),
    );
  });

  it("does not look for members when there is no group to look in", async () => {
    const db = buildGroupsDb({ groups: [] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.me();

    expect(db.carpoolSearch.findMany).not.toHaveBeenCalled();
  });

  it("still rejects an anonymous caller", async () => {
    const { caller, db } = callerFor(null);

    await expect(caller.user.groups.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.carpoolSearch.findFirst).not.toHaveBeenCalled();
  });
});

describe("user.groups.delete — the driver dissolves the group", () => {
  it("lets the group's driver delete it", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.delete({ groupId: GROUP });

    expect(db.groupIds()).toEqual([]);
  });

  it("refuses a rider in the group and leaves it standing", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await expect(
      caller.user.groups.delete({ groupId: GROUP }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.carpoolGroup.delete).not.toHaveBeenCalled();
    // The pre-fix resolver cleared every member's carpoolId before deleting.
    expect(db.carpoolIdOf(RIDER_2)).toBe(GROUP);
  });

  it("refuses a stranger to the group", async () => {
    const { caller, db } = callerFor(sessionFor(OUTSIDER));

    await expect(
      caller.user.groups.delete({ groupId: GROUP }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
  });
});

describe("user.groups.updatePreferences — self-scoped, replacing the double write", () => {
  const prefs = {
    notes: "Meet by the side door",
    musicPreference: "Podcasts",
    conversationStyle: "Quiet",
  };

  it("writes all three columns on the caller's own search", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.updatePreferences(prefs);

    expect(db.preferencesOf(DRIVER)).toEqual({
      groupNotes: "Meet by the side door",
      groupMusicPreference: "Podcasts",
      groupConversationStyle: "Quiet",
    });
  });

  /**
   * The reason a blank field is stored as "" rather than left null:
   * `resolveGroupDetails` reads all-null as "never saved" and falls back to the
   * legacy blob, so a partial write would resurrect data the driver cleared.
   */
  it("stores blanks as empty strings, not nulls", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.updatePreferences({
      notes: "",
      musicPreference: "",
      conversationStyle: "",
    });

    expect(db.preferencesOf(DRIVER)).toEqual({
      groupNotes: "",
      groupMusicPreference: "",
      groupConversationStyle: "",
    });
  });

  /**
   * `updateMessage` wrote `group.message`, a row shared with riders, and needed
   * `requireGroupDriver` to stop a rider rewriting it. This writes only the
   * caller's own search, so there is no cross-user write left to police - a
   * rider setting their own preferences simply has no effect on the group,
   * because the group reads the driver's.
   */
  it("never touches the group row", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.updatePreferences(prefs);

    expect(db.messageOf(GROUP)).toBe("original message");
    expect(db.carpoolGroup.update).not.toHaveBeenCalled();
  });

  it("leaves another member's preferences alone when a rider saves", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.updatePreferences(prefs);

    expect(db.preferencesOf(RIDER_1)).toEqual({
      groupNotes: "Meet by the side door",
      groupMusicPreference: "Podcasts",
      groupConversationStyle: "Quiet",
    });
    expect(db.preferencesOf(DRIVER)).toEqual({
      groupNotes: null,
      groupMusicPreference: null,
      groupConversationStyle: null,
    });
  });

  it("rejects a note longer than the column, rather than truncating it", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await expect(
      caller.user.groups.updatePreferences({
        ...prefs,
        notes: "x".repeat(GROUP_NOTES_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.preferencesOf(DRIVER)).toEqual({
      groupNotes: null,
      groupMusicPreference: null,
      groupConversationStyle: null,
    });
  });

  it("rejects an over-length option value", async () => {
    const { caller } = callerFor(sessionFor(DRIVER));

    await expect(
      caller.user.groups.updatePreferences({
        ...prefs,
        musicPreference: "y".repeat(GROUP_OPTION_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts a note exactly at the limit", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));
    const atLimit = "x".repeat(GROUP_NOTES_MAX_LENGTH);

    await caller.user.groups.updatePreferences({ ...prefs, notes: atLimit });

    expect(db.preferencesOf(DRIVER)?.groupNotes).toBe(atLimit);
  });

  it("reports NOT_FOUND for a user with no carpool search", async () => {
    const { caller } = callerFor(
      sessionFor(OUTSIDER),
      buildGroupsDb({ searches: [] }),
    );

    await expect(
      caller.user.groups.updatePreferences(prefs),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("user.groups.edit — removing a member", () => {
  const remove = (riderId: string) => ({
    driverId: DRIVER,
    riderId,
    groupId: GROUP,
    add: false,
  });

  it("lets the driver remove a rider", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.edit(remove(RIDER_1));

    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
  });

  it("lets a rider leave the group themselves", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit(remove(RIDER_1));

    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
    expect(db.carpoolIdOf(RIDER_2)).toBe(GROUP);
  });

  it("refuses one rider evicting another", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await expect(
      caller.user.groups.edit(remove(RIDER_2)),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(db.carpoolIdOf(RIDER_2)).toBe(GROUP);
  });

  it("refuses a stranger evicting a member", async () => {
    const { caller, db } = callerFor(sessionFor(OUTSIDER));

    await expect(
      caller.user.groups.edit(remove(RIDER_1)),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
  });

  it("reports NOT_FOUND when the target is not in the group", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await expect(
      caller.user.groups.edit(remove(OUTSIDER)),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });
});

describe("user.groups.edit — adding a member needs an invitation", () => {
  const join = (riderId: string) => ({
    driverId: DRIVER,
    riderId,
    groupId: GROUP,
    add: true,
  });

  it("lets the driver add a rider they have a request with", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit(join(OUTSIDER));

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
  });

  it("lets a rider join a driver's group themselves", async () => {
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await caller.user.groups.edit(join(OUTSIDER));

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
  });

  it("refuses a self-join with no request — the hole that let anyone into any group", async () => {
    const db = buildGroupsDb({ requests: [] });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(caller.user.groups.edit(join(OUTSIDER))).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("refuses a rider dragging a third party into the group", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await expect(caller.user.groups.edit(join(OUTSIDER))).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("refuses when the named group is not that driver's group", async () => {
    const db = buildGroupsDb({
      requests: [[DRIVER, OUTSIDER]],
      groups: [
        { id: GROUP, message: "m" },
        { id: OTHER_GROUP, message: "m" },
      ],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: OTHER_GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });
});

describe("user.groups.create — only the two people involved", () => {
  const freshPair = () =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: [],
      requests: [[DRIVER, RIDER_1]],
    });

  it("lets the driver create the group", async () => {
    const db = freshPair();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.groupIds()).toHaveLength(1);
  });

  it("lets the rider create the group", async () => {
    const db = freshPair();
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.groupIds()).toHaveLength(1);
  });

  it("refuses a third party pairing two other people up", async () => {
    const db = freshPair();
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    expect(db.carpoolGroup.create).not.toHaveBeenCalled();
  });

  it("refuses a pair with no request between them", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: [],
      requests: [],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
  });
});

/**
 * Accepting a request resolves it (SCRUM-228).
 *
 * Building the group used to leave the `Request` untouched, so it stayed pending
 * in both users' Requests tab forever and the duplicate guard in
 * `requests.create` blocked the pair from ever requesting each other again. The
 * resolution happens inside the same transaction as the membership write, which
 * is the only way group state and request state cannot disagree.
 */
describe("accepting a request resolves it", () => {
  it("marks the request accepted when a group is created", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: [],
      requests: [[DRIVER, RIDER_1]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    expect(db.requestStatusOf(DRIVER, RIDER_1)).toBe(RequestStatus.PENDING);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.requestStatusOf(DRIVER, RIDER_1)).toBe(RequestStatus.ACCEPTED);
  });

  it("marks the request accepted when a rider joins an existing group", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.requestStatusOf(DRIVER, OUTSIDER)).toBe(RequestStatus.ACCEPTED);
  });

  it("resolves a request sent in either direction", async () => {
    // The rider asked the driver; accepting still resolves that row.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.ACCEPTED);
  });

  it("leaves the request pending when the join fails", async () => {
    // A driver with no seats. The membership does not happen, so neither does
    // the acceptance — that is the point of doing both in one transaction.
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      requests: [[DRIVER, OUTSIDER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.requestStatusOf(DRIVER, OUTSIDER)).toBe(RequestStatus.PENDING);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("leaves the request pending when removing a member, not accepting one", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, RIDER_1]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.requestStatusOf(DRIVER, RIDER_1)).toBe(RequestStatus.PENDING);
  });
});

describe("user.groups — authentication gate", () => {
  it("rejects anonymous callers on every mutation without touching the data", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.groups.delete({ groupId: GROUP }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.user.groups.updatePreferences({
        notes: "x",
        musicPreference: "",
        conversationStyle: "",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.messageOf(GROUP)).toBe("original message");
    expect(db.carpoolGroup.delete).not.toHaveBeenCalled();
  });
});

describe("seat accounting — deleting restores seats to the driver (SCRUM-229)", () => {
  it("credits the driver for every rider the group held", async () => {
    // Two riders were occupying two seats; the driver gets both back.
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.delete({ groupId: GROUP });

    expect(db.seatsOf(DRIVER)).toBe(4); // started at 2
  });

  it("credits nobody but the driver", async () => {
    // The defect: this read and wrote the *session user's* row, so whoever
    // pressed the button took the seats. Riders must be untouched.
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.delete({ groupId: GROUP });

    expect(db.seatsOf(RIDER_1)).toBe(0);
    expect(db.seatsOf(RIDER_2)).toBe(0);
  });

  it("credits the driver's row for *this* group, not just their first row", async () => {
    // The schema permits several CarpoolSearch rows per user (CLAUDE.md notes
    // the code assumes one). The old lookup was
    // `findFirst({ where: { userId } })` with no group scoping, so with an
    // unrelated row ordered first the seats landed on the wrong row entirely —
    // reachable today, unlike the "rider deletes the group" case, which
    // SCRUM-220 now prevents.
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver-unrelated",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: null,
          seatsAvail: 1,
          groupMessage: "",
        },
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 2,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.delete({ groupId: GROUP });

    expect(db.seatsOfSearch("s-driver")).toBe(3); // 2 + the one rider
    expect(db.seatsOfSearch("s-driver-unrelated")).toBe(1); // untouched
  });

  it("never credits past the maximum", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 5,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
        {
          id: "s-rider-2",
          userId: RIDER_2,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.delete({ groupId: GROUP });

    // 5 + 2 would be 7; the shared maximum is 6.
    expect(db.seatsOf(DRIVER)).toBe(MAX_SEATS_AVAILABLE);
  });
});

describe("seat accounting — a full driver cannot take another rider", () => {
  const fullDriver = (carpoolId: string | null) =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId,
          seatsAvail: 0,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: carpoolId ? [{ id: GROUP, message: "m" }] : [],
      requests: [[DRIVER, OUTSIDER]],
    });

  it("rejects create and leaves seats at zero rather than -1", async () => {
    // The defect: create had no availability check at all and decremented
    // unconditionally, so the first rider took a full driver to -1.
    const db = fullDriver(null);
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.seatsOf(DRIVER)).toBe(0);
    expect(db.groupIds()).toEqual([]);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("rejects edit-add and does not link the rider", async () => {
    const db = fullDriver(GROUP);
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.seatsOf(DRIVER)).toBe(0);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });
});

describe("seat accounting — normal joins and leaves", () => {
  it("takes a seat when a group is created", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: [],
      requests: [[DRIVER, RIDER_1]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("takes a seat when a rider is added to an existing group", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.seatsOf(DRIVER)).toBe(1); // started at 2
  });

  it("gives a seat back when a rider is removed", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(3); // started at 2
  });

  it("gives a seat back when a rider leaves of their own accord", async () => {
    // The credit still goes to the driver, not the departing rider.
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.seatsOf(RIDER_1)).toBe(0);
  });

  it("never returns a seat past the maximum", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: MAX_SEATS_AVAILABLE,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
        {
          id: "s-rider-2",
          userId: RIDER_2,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(MAX_SEATS_AVAILABLE);
  });

  it("keeps seats within range across a sequence of joins and leaves", async () => {
    // The property the ticket actually asks for, over a realistic sequence.
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const edit = (riderId: string, add: boolean) =>
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId,
        groupId: GROUP,
        add,
      });

    await edit(OUTSIDER, true);
    await edit(OUTSIDER, false);
    await edit(OUTSIDER, true);
    await edit(RIDER_1, false);

    const seats = db.seatsOf(DRIVER)!;
    expect(seats).toBeGreaterThanOrEqual(0);
    expect(seats).toBeLessThanOrEqual(MAX_SEATS_AVAILABLE);
  });
});

/**
 * Atomicity of the group mutations (SCRUM-233).
 *
 * Each of these writes to two or three tables. They used to be independent
 * awaits, so a failure part-way through committed the earlier writes and
 * abandoned the rest — and because `relationMode = "prisma"` enforces no
 * foreign keys, nothing rejected the result and no job ever reconciled it.
 *
 * Every test here forces one write in the middle of a sequence to fail and then
 * asserts the database looks exactly as it did beforehand. The mock's
 * `$transaction` rolls back on a throw, so a procedure that stopped using it
 * would fail these rather than quietly leaking again.
 */
describe("group mutations are atomic", () => {
  const twoUnlinkedUsers = () => [
    {
      id: "s-driver",
      userId: DRIVER,
      role: Role.DRIVER,
      carpoolId: null,
      seatsAvail: 3,
      groupMessage: "",
    },
    {
      id: "s-rider-1",
      userId: RIDER_1,
      role: Role.RIDER,
      carpoolId: null,
      seatsAvail: 0,
      groupMessage: "",
    },
  ];

  /**
   * Fails the nth call to a mocked delegate, letting the earlier ones through.
   *
   * `mockImplementationOnce` is not enough here: `reserveSeat` is itself a
   * `carpoolSearch.updateMany`, so failing the *first* call stops at the
   * reservation and the test proves nothing — the seat was never spent and no
   * group was ever built. The interesting failures are the later writes, once
   * there is partial state to leave behind.
   */
  const failOnCall = (mock: jest.Mock, callNumber: number) => {
    const real = mock.getMockImplementation()!;
    let calls = 0;
    mock.mockImplementation(async (args: any) => {
      calls += 1;
      if (calls === callNumber) throw new Error("connection lost");
      return real(args);
    });
  };

  it("create leaves no group and no spent seat when linking the rider fails", async () => {
    const db = buildGroupsDb({
      searches: twoUnlinkedUsers(),
      groups: [],
      requests: [[DRIVER, RIDER_1]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    // updateMany #1 reserves the seat and #2 links the driver, so failing #3
    // means the seat is already spent, the group already exists and the driver
    // is already linked. That is the state that used to survive.
    failOnCall(db.carpoolSearch.updateMany, 3);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toThrow("connection lost");

    expect(db.groupIds()).toEqual([]);
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.carpoolIdOf(DRIVER)).toBeNull();
    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
  });

  it("delete leaves the group intact rather than orphaning it", async () => {
    const db = buildGroupsDb();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    // Members are detached before the group row is removed. Failing on the
    // removal is what used to leave a group nobody pointed at — and one the
    // driver could no longer delete, because the membership check would no
    // longer find them in it.
    db.carpoolGroup.delete.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(caller.user.groups.delete({ groupId: GROUP })).rejects.toThrow(
      "connection lost",
    );

    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
    expect(db.carpoolIdOf(RIDER_2)).toBe(GROUP);

    // The driver is still the driver of a group they can still dissolve, which
    // is the property the un-transactioned version destroyed.
    await expect(
      caller.user.groups.delete({ groupId: GROUP }),
    ).resolves.toBeTruthy();
    expect(db.groupIds()).toEqual([]);
  });

  it("edit-add returns the seat when linking the rider fails", async () => {
    // Joining needs a request between the two (SCRUM-220), so the outsider
    // being added has one here.
    const db = buildGroupsDb({
      requests: [
        [DRIVER, RIDER_1],
        [DRIVER, OUTSIDER],
      ],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);
    const seatsBefore = db.seatsOf(DRIVER)!;

    // #1 is the reservation, #2 links the rider — so fail #2, with the seat
    // already taken.
    failOnCall(db.carpoolSearch.updateMany, 2);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toThrow("connection lost");

    expect(db.seatsOf(DRIVER)).toBe(seatsBefore);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("edit-remove keeps the rider in the group when crediting the seat fails", async () => {
    const db = buildGroupsDb();
    const { caller } = callerFor(sessionFor(DRIVER), db);
    const seatsBefore = db.seatsOf(DRIVER)!;

    // Release is the last write, after the rider has already been detached.
    db.carpoolSearch.update.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: false,
      }),
    ).rejects.toThrow("connection lost");

    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
    expect(db.seatsOf(DRIVER)).toBe(seatsBefore);
  });
});

/**
 * Dissolving a group is a success, not an error (SCRUM-281).
 *
 * `edit` removes the group once a single member would be left, and then used to
 * fall through to a read of that same group — finding nothing, because it had
 * just deleted it, and throwing BAD_REQUEST "Group does not exist". Every caller
 * turns a rejection into "Something went wrong", so leaving a two-person carpool
 * reported failure after succeeding, and the `onSuccess` handlers never ran.
 */
describe("edit — dissolving the group when one member is left", () => {
  const twoPersonGroup = () =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 2,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      requests: [[DRIVER, RIDER_1]],
    });

  it("resolves rather than throwing when the rider leaves", async () => {
    const db = twoPersonGroup();
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: false,
      }),
    ).resolves.toBeNull();

    expect(db.groupIds()).toEqual([]);
  });

  it("resolves rather than throwing when the driver removes the last rider", async () => {
    const db = twoPersonGroup();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: false,
      }),
    ).resolves.toBeNull();
  });

  it("leaves nobody pointing at the group it deleted", async () => {
    // A membership referencing a deleted group is precisely what `me` has to
    // guard against, so dissolving detaches the last member explicitly rather
    // than leaving it to an emulated referential action.
    const db = twoPersonGroup();
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
    expect(db.carpoolIdOf(DRIVER)).toBeNull();
  });

  it("still credits the driver's seat", async () => {
    // The seat accounting of SCRUM-229 must survive the early return.
    const db = twoPersonGroup();
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("keeps the group and returns it when two members remain", async () => {
    // The default group has three members, so removing one leaves two: no
    // dissolution, and the caller still gets the group back.
    const db = buildGroupsDb();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const result = await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ id: GROUP });
    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
  });

  it("still rejects a groupId that never existed", async () => {
    // Rejected by the membership check, not by the BAD_REQUEST below it — which
    // is why removing that error's only *reachable* trigger (this procedure
    // deleting the group itself) costs no real validation.
    const db = buildGroupsDb();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: "no-such-group",
        add: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/**
 * A driver cannot walk out of a group and leave it unmanageable (SCRUM-289).
 *
 * `edit`'s dissolution rule only fires at one remaining member, so a driver
 * leaving a group of three or more leaves the group alive with no DRIVER in it.
 * From there `requireGroupDriver` throws FORBIDDEN for every remaining member:
 * nobody can remove anybody, and nobody can dissolve it. The riders can still
 * leave one at a time, so it is not a trap forever - but only if a rider
 * happens to act, and the driver who caused it cannot fix it.
 *
 * Two members is the boundary and stays allowed: the group dissolves on the way
 * out, so nobody is stranded.
 */
describe("user.groups.edit — a driver cannot strand the group (SCRUM-289)", () => {
  it("refuses to let the driver leave a group of three", async () => {
    // Default fixture: DRIVER + RIDER_1 + RIDER_2 all in GROUP.
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: DRIVER,
        groupId: GROUP,
        add: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Everyone is still in the group, and it still has its driver.
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
    expect(db.carpoolIdOf(RIDER_2)).toBe(GROUP);
  });

  it("lets the driver leave a group of two, which dissolves it", async () => {
    const { caller, db } = callerFor(
      sessionFor(DRIVER),
      buildGroupsDb({
        searches: [
          {
            id: "s-driver",
            userId: DRIVER,
            role: Role.DRIVER,
            carpoolId: GROUP,
            seatsAvail: 1,
            groupMessage: "",
          },
          {
            id: "s-rider-1",
            userId: RIDER_1,
            role: Role.RIDER,
            carpoolId: GROUP,
            seatsAvail: 0,
            groupMessage: "",
          },
        ],
      }),
    );

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: DRIVER,
      groupId: GROUP,
      add: false,
    });

    // Nobody is stranded: the group is gone and both memberships are clear.
    expect(db.carpoolIdOf(DRIVER)).toBeNull();
    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
    expect(db.groupIds()).toEqual([]);
  });

  it("still lets the driver remove a rider from a group of three", async () => {
    // The guard is about the driver leaving, not about the driver managing.
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_2,
      groupId: GROUP,
      add: false,
    });

    expect(db.carpoolIdOf(RIDER_2)).toBeNull();
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
  });

  it("still lets a rider leave a group of three", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
    expect(db.carpoolIdOf(DRIVER)).toBe(GROUP);
  });
});

/**
 * `groups.me` says whether the group has a driver (SCRUM-289).
 *
 * Preferences are read through the driver's own search, so a driverless group
 * produced four nulls - exactly what a driver who had saved nothing produces.
 * The two need telling apart: one is an ordinary empty state, the other is a
 * group nobody can manage.
 */
describe("user.groups.me — a driverless group is reported, not silently blank", () => {
  const driverlessDb = () =>
    buildGroupsDb({
      searches: [
        // The SCRUM-289 shape: the driver switched to RIDER and stayed in.
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
          groupNotes: "Meet at the garage",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });

  it("reports hasDriver false when no member is a DRIVER", async () => {
    const { caller } = callerFor(sessionFor(RIDER_1), driverlessDb());

    const group = await caller.user.groups.me();

    expect(group?.hasDriver).toBe(false);
  });

  it("reports hasDriver true for a healthy group", async () => {
    const { caller } = callerFor(sessionFor(RIDER_1));

    const group = await caller.user.groups.me();

    expect(group?.hasDriver).toBe(true);
  });

  it("still returns the group and its members when there is no driver", async () => {
    // Reporting the problem must not hide the group: the riders still need to
    // see each other so they can leave.
    const { caller } = callerFor(sessionFor(RIDER_1), driverlessDb());

    const group = await caller.user.groups.me();

    expect(group?.id).toBe(GROUP);
    expect(group?.users).toHaveLength(2);
    // Preferences stay null - there is no driver to read them from. The flag
    // above is what makes that legible rather than ambiguous.
    expect(group?.preferences.groupNotes).toBeNull();
  });
});

/**
 * The seat credit on the remove path follows the group, not the client
 * (SCRUM-290).
 *
 * `driverId` arrives from input and the remove path never checked it against
 * anything: the authorization block constrains `callerId` and `riderId` only.
 * So a rider leaving their own group could name any user at all and the seat
 * credit landed on that stranger's `carpool_search` row, while the group's real
 * driver was never credited and stayed under-counted for the rest of the
 * group's life. That is the cross-tenant write shape SCRUM-220 and SCRUM-223
 * were filed to remove, surviving in this one branch.
 *
 * Every pre-existing remove-path test passed the real `DRIVER`, which is why
 * SCRUM-220 and SCRUM-229 both touched this function without catching it. These
 * pass a foreign id on purpose.
 */
describe("user.groups.edit — the seat credit follows the group (SCRUM-290)", () => {
  it("does not touch a foreign user's row when a rider names them", async () => {
    // OUTSIDER is in no group and has no seats. Under the bug they gained one.
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit({
      driverId: OUTSIDER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(OUTSIDER)).toBe(0);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
  });

  it("credits the group's real driver regardless of the id supplied", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit({
      driverId: OUTSIDER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    // The fixture driver starts at 2 seats and gets one back.
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
  });

  it("credits the real driver exactly once, not the named user as well", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await caller.user.groups.edit({
      driverId: RIDER_2,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(3);
    // A fellow member is just as wrong a target as an outsider.
    expect(db.seatsOf(RIDER_2)).toBe(0);
  });

  it("still credits the driver when they remove a rider themselves", async () => {
    // The honest call, unchanged: the driver names themselves and is credited.
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("credits the driver when the removal dissolves the group", async () => {
    // The driver is derived before the membership writes, so dissolution -
    // which clears every carpoolId - must not cost them the seat.
    const { caller, db } = callerFor(
      sessionFor(RIDER_1),
      buildGroupsDb({
        searches: [
          {
            id: "s-driver",
            userId: DRIVER,
            role: Role.DRIVER,
            carpoolId: GROUP,
            seatsAvail: 1,
            groupMessage: "",
          },
          {
            id: "s-rider-1",
            userId: RIDER_1,
            role: Role.RIDER,
            carpoolId: GROUP,
            seatsAvail: 0,
            groupMessage: "",
          },
          // The stranger named on the call, so the assertion below reads a real
          // row rather than an absent one.
          {
            id: "s-outsider",
            userId: OUTSIDER,
            role: Role.RIDER,
            carpoolId: null,
            seatsAvail: 0,
            groupMessage: "",
          },
        ],
      }),
    );

    const result = await caller.user.groups.edit({
      driverId: OUTSIDER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(result).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(2);
    expect(db.seatsOf(OUTSIDER)).toBe(0);
    expect(db.groupIds()).toEqual([]);
  });

  it("lets a rider leave a driverless group instead of trapping them", async () => {
    // A group already in the SCRUM-289 state has nobody to credit. Leaving one
    // at a time is the only way out for its riders, so the missing driver must
    // skip the credit rather than fail the removal.
    const { caller, db } = callerFor(
      sessionFor(RIDER_1),
      buildGroupsDb({
        searches: [
          {
            id: "s-driver",
            userId: DRIVER,
            role: Role.RIDER,
            carpoolId: GROUP,
            seatsAvail: 0,
            groupMessage: "",
          },
          {
            id: "s-rider-1",
            userId: RIDER_1,
            role: Role.RIDER,
            carpoolId: GROUP,
            seatsAvail: 0,
            groupMessage: "",
          },
          {
            id: "s-rider-2",
            userId: RIDER_2,
            role: Role.RIDER,
            carpoolId: GROUP,
            seatsAvail: 0,
            groupMessage: "",
          },
        ],
      }),
    );

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
    // Nobody was credited, because there was no driver to credit.
    expect(db.seatsOf(DRIVER)).toBe(0);
    expect(db.seatsOf(RIDER_2)).toBe(0);
  });
});
