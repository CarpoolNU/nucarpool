import { Permission, Role, RequestStatus, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import {
  MAX_SEATS_AVAILABLE,
  hasSeatAvailable,
} from "../../../utils/carpoolSeats";
import { calculateScore } from "../../../utils/recommendation";
import { buildCandidateWhere } from "../../db/candidateSearch";
import type { CurrentSearch } from "../../db/candidateSearch";
import {
  anyFilters,
  buildSearch,
} from "../../../utils/recommendation.fixtures";
import {
  GROUP_NOTES_MAX_LENGTH,
  GROUP_OPTION_MAX_LENGTH,
} from "../../../utils/textLimits";
import type { Context } from "../context";
import { cloneState, withTransaction } from "../transactionMock";

/**
 * Authorization tests for the carpool groups router.
 *
 * Every mutation was `protectedRouter` and nothing more, so group and user ids
 * arrived straight from client input: any signed-in student could dissolve
 * someone else's group, evict its riders, insert users, or rewrite the driver's
 * message. These tests pin the rule set the UI already implied — driver-only
 * delete/evict, riders may leave, joining needs a request.
 *
 * The driver's message is no longer among them: the two message
 * mutations were replaced by `updatePreferences`, which writes only the caller's own
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
  /**
   * Optional, and absent from most fixtures on purpose: a row that never sets
   * it must behave exactly as an ACTIVE one, so the SCRUM-369 guards cannot
   * quietly start refusing the hundred cases in this file that say nothing
   * about status.
   */
  status?: Status;
  carpoolId: string | null;
  seatsAvail: number;
  groupMessage: string;
  /** The preference columns. Null until a save writes all three. */
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

  // Understands the `seatsAvail: { gt: n }` filter that `reserveSeat` relies
  // on. Without it the mock matches on userId alone and the compare-and-swap
  // can never fail, which would make the seat tests vacuous.
  const matches = (row: SearchRow, where: any = {}) => {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.carpoolId !== undefined && row.carpoolId !== where.carpoolId)
      return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    // `edit` and `delete` both resolve a group's driver with `{ carpoolId,
    // role: DRIVER }`. Without role matching that lookup returns whichever
    // member happens to be first, which would make the seat-credit tests pass
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
    // `edit` counts a group's members before letting its driver leave.
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
      // The preference columns.
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

  // Seeded pairs start pending; `markRequestAccepted` moves them.
  const requestStatus = new Map<string, RequestStatus>(
    requests.map(([a, b]) => [`${a}|${b}`, RequestStatus.PENDING]),
  );

  const matchesPair = (clauses: any[], a: string, b: string) =>
    clauses.some((c) => c.fromUserId === a && c.toUserId === b);

  const request = {
    // Returns the direction and the live status, not just a hit.
    // `requireAcceptableRequest` reads `toUserId` to decide whether the caller
    // is the person the request was addressed to (SCRUM-347) and `status` to
    // decide whether the invitation is still unused (SCRUM-353). A mock that
    // answered with a bare id could not tell a legitimate accept from either a
    // self-accept or a replay of a spent request.
    //
    // `status` is read from `requestStatus` rather than captured at seed time,
    // so a row `markRequestAccepted` resolved earlier in the same test is seen
    // as resolved by a later call. That is what makes the double-accept and
    // re-add sequences below testable at all.
    findFirst: jest.fn(async ({ where }: any) => {
      const clauses: any[] = where?.OR ?? [where ?? {}];
      const hit = requests.find(([a, b]) => matchesPair(clauses, a, b));
      if (!hit) return null;
      const [fromUserId, toUserId] = hit;
      return {
        id: `request-${fromUserId}-${toUserId}`,
        fromUserId,
        toUserId,
        status:
          requestStatus.get(`${fromUserId}|${toUserId}`) ??
          RequestStatus.PENDING,
      };
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

  // The groups mutations wrap their writes in `prisma.$transaction`,
  // so the mock rolls back on a throw. Restoring in place matters:
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
    /** The preference columns on a user's own search. */
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
 * `groups.me` and the states that are not failures.
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

  it("lets the driver add a rider who asked to join", async () => {
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit(join(OUTSIDER));

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
  });

  it("lets a rider join a driver's group when the driver invited them", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
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
      requests: [[OUTSIDER, DRIVER]],
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
  /**
   * `invitation` is `[asker, asked]`. It defaults to the rider asking the
   * driver, because `requireAcceptableRequest` only lets the person a request
   * was *sent to* accept it — so which way the request points decides which of
   * the two may create the group. Before SCRUM-347 the direction was
   * irrelevant and every test here seeded the same one.
   */
  const freshPair = (invitation: RequestPair = [RIDER_1, DRIVER]) =>
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
      requests: [invitation],
    });

  it("lets the driver create the group, accepting the rider's request", async () => {
    const db = freshPair([RIDER_1, DRIVER]);
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.groupIds()).toHaveLength(1);
  });

  it("lets the rider create the group, accepting the driver's request", async () => {
    // The mirror image, and the reason the either-direction lookup stays: a
    // driver may also do the asking, and then the rider is the one who accepts.
    const db = freshPair([DRIVER, RIDER_1]);
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
 * Accepting a request resolves it.
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
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    expect(db.requestStatusOf(RIDER_1, DRIVER)).toBe(RequestStatus.PENDING);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.requestStatusOf(RIDER_1, DRIVER)).toBe(RequestStatus.ACCEPTED);
  });

  it("marks the request accepted when a rider joins an existing group", async () => {
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.ACCEPTED);
  });

  it("resolves a request the driver sent, when the rider accepts it", async () => {
    // The other direction: the driver did the asking, so the rider is the one
    // who may accept, and the row still resolves.
    //
    // This case used to be written with the *sender* accepting — an OUTSIDER
    // who had asked the driver, calling `edit` themselves — and asserted that
    // it succeeded. That was SCRUM-347: it pinned the self-accept as correct
    // behaviour, which is how the hole survived three rounds of group
    // authorization hardening. The refusal is now pinned below.
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.requestStatusOf(DRIVER, OUTSIDER)).toBe(RequestStatus.ACCEPTED);
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
      requests: [[OUTSIDER, DRIVER]],
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

    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
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

/**
 * SCRUM-347: you cannot accept a request you sent yourself.
 *
 * `requireAcceptableRequest` — `requireRequestBetween` as it was then — checked
 * only that *some* request existed between the pair, in either direction, with
 * no condition on the caller at all. Any signed-in
 * user can create a request to anyone through `user.requests.create`, so the
 * caller could manufacture the proof and then act on it: send a request, then
 * accept it on the other person's behalf.
 *
 * What that bought an attacker is the reason this is not merely untidy. The
 * join spends one of the driver's seats, and membership is what `groups.me`
 * reads through `convertCarpoolSearchToPublicWithExactHome` — so it hands over
 * the other person's **full-precision home coordinates and email address**,
 * defeating the neighbourhood-level coarsening every bulk payload applies. The
 * group id needed for the `edit` variant is not secret either: `PublicUser`
 * carries `carpoolId`, so the map hands it to every signed-in viewer.
 *
 * Both directions are covered below, because both are unilateral: a rider
 * walking into a driver's group, and a driver dragging a rider into theirs.
 *
 * Every case asserts that *nothing moved* — no group, no seat, no membership,
 * and the request left as it was. A refusal that still spent a seat would be a
 * denial-of-service on the driver.
 */
describe("user.groups — only the person a request was sent to may accept it", () => {
  const ungroupedPair = () => [
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
  ];

  it("refuses create when the rider accepts their own request to the driver", async () => {
    // The exploit as filed: the outsider sends the request, then calls
    // `create` naming themselves as the rider. Every other check passes.
    const db = buildGroupsDb({
      searches: ungroupedPair(),
      groups: [],
      requests: [[OUTSIDER, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    expect(db.carpoolGroup.create).not.toHaveBeenCalled();
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses create when the driver accepts their own request to the rider", async () => {
    // The mirror image, and equally unilateral: the driver asks, then pulls the
    // rider in without the rider ever agreeing. This direction was the one the
    // old tests seeded by default, which is why nothing caught it.
    const db = buildGroupsDb({
      searches: ungroupedPair(),
      groups: [],
      requests: [[DRIVER, OUTSIDER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(DRIVER, OUTSIDER)).toBe(RequestStatus.PENDING);
  });

  it("refuses edit-add when the rider joins the driver's group on their own request", async () => {
    // The variant that needs no group of its own: the driver already has one,
    // and its id reaches the client in every map payload as `carpoolId`.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const seatsBefore = db.seatsOf(DRIVER)!;
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(seatsBefore);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses edit-add when the driver adds a rider on the driver's own request", async () => {
    const db = buildGroupsDb({ requests: [[DRIVER, OUTSIDER]] });
    const seatsBefore = db.seatsOf(DRIVER)!;
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(seatsBefore);
    expect(db.requestStatusOf(DRIVER, OUTSIDER)).toBe(RequestStatus.PENDING);
  });

  it("still refuses a caller who is party to no request at all", async () => {
    // The original guard, unchanged: a third party is refused before the
    // request is even looked up, so it keeps its own message.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(RIDER_2), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.request.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * SCRUM-353: an invitation is spent once it is used.
 *
 * SCRUM-347 settled *who* may accept a request. This is *how long* the
 * acceptance stays valid. `markRequestAccepted` resolves the row rather than
 * deleting it — deliberately, because `sendAcceptanceNotification` reads it and
 * the conversation hangs off its id — so an ACCEPTED request outlives the group
 * it created. Without a status check it went on satisfying every other
 * condition indefinitely: a driver whose rider left could put them straight
 * back, as often as they liked, and nothing would tell the rider, because group
 * mutations send no email and fire no Pusher event.
 *
 * These drive the real lifecycle — join, leave, try again — rather than seeding
 * a resolved row directly, so they exercise the same `markRequestAccepted`
 * transition production does. That is also why the mock reads `status` live
 * from `requestStatus` instead of capturing it at seed time.
 *
 * The way back is asserted too, and matters as much as the refusal: requiring
 * PENDING must not strand a pair who genuinely want to carpool again.
 */
describe("user.groups — a used invitation cannot be replayed", () => {
  const soloDriverAndRider = () => [
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
   * What `requests.create`'s reopen branch does, reproduced at the data layer.
   * That branch lives in another router, so this suite cannot call it — but it
   * sets `status: PENDING` on exactly this row, which is the state the join
   * needs to see.
   */
  const reopen = (db: ReturnType<typeof buildGroupsDb>, pair: RequestPair) =>
    db.request.updateMany({
      where: { OR: [{ fromUserId: pair[0], toUserId: pair[1] }] },
      data: { status: RequestStatus.PENDING },
    });

  it("refuses to re-add a rider who left, on the invitation they already used", async () => {
    // The ticket's scenario, start to finish.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);
    const join = { driverId: DRIVER, riderId: OUTSIDER, groupId: GROUP };

    // The outsider asks, the driver accepts. This is the legitimate join.
    await caller.user.groups.edit({ ...join, add: true });
    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.ACCEPTED);
    const seatsWhileRiding = db.seatsOf(DRIVER)!;

    // The rider leaves. Their seat comes back; the request row does not change.
    await caller.user.groups.edit({ ...join, add: false });
    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.ACCEPTED);
    const seatsAfterLeaving = db.seatsOf(DRIVER)!;
    expect(seatsAfterLeaving).toBe(seatsWhileRiding + 1);

    // The driver tries to put them back. This used to succeed.
    await expect(
      caller.user.groups.edit({ ...join, add: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("already been used"),
    });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(seatsAfterLeaving);
  });

  it("admits them again once a fresh request reopens the row", async () => {
    // The other half: refusing a replay must not mean the pair can never
    // carpool again. Asking again is what makes it legal.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const { caller } = callerFor(sessionFor(DRIVER), db);
    const join = { driverId: DRIVER, riderId: OUTSIDER, groupId: GROUP };

    await caller.user.groups.edit({ ...join, add: true });
    await caller.user.groups.edit({ ...join, add: false });
    await expect(
      caller.user.groups.edit({ ...join, add: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await reopen(db, [OUTSIDER, DRIVER]);

    await caller.user.groups.edit({ ...join, add: true });

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.ACCEPTED);
  });

  it("refuses to rebuild a dissolved group on the same invitation", async () => {
    // The `create` path. Dissolving returns everyone's membership and the
    // driver's seats, but leaves the request resolved, so `create` must refuse
    // for the same reason `edit` does.
    const db = buildGroupsDb({
      searches: soloDriverAndRider(),
      groups: [],
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const group = await caller.user.groups.create({
      driverId: DRIVER,
      riderId: RIDER_1,
    });
    expect(db.seatsOf(DRIVER)).toBe(2);

    await caller.user.groups.delete({ groupId: group.id });
    expect(db.groupIds()).toEqual([]);
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(RIDER_1, DRIVER)).toBe(RequestStatus.ACCEPTED);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("already been used"),
    });

    expect(db.groupIds()).toEqual([]);
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.carpoolIdOf(RIDER_1)).toBeNull();
  });

  it("says the invitation is spent, not that there is no relationship", async () => {
    // The two refusals ask different things of the user — send a new request
    // versus you have no request with this person — so they must not collapse
    // into one message. This is the criterion that ruled out putting `status`
    // in the `where` clause, where a spent row would have been indistinguishable
    // from a missing one.
    const spent = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const spentCaller = callerFor(sessionFor(DRIVER), spent).caller;
    const join = { driverId: DRIVER, riderId: OUTSIDER, groupId: GROUP };

    await spentCaller.user.groups.edit({ ...join, add: true });
    await spentCaller.user.groups.edit({ ...join, add: false });

    await expect(
      spentCaller.user.groups.edit({ ...join, add: true }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("already been used"),
    });

    const none = buildGroupsDb({ requests: [] });
    const noneCaller = callerFor(sessionFor(DRIVER), none).caller;

    await expect(
      noneCaller.user.groups.edit({ ...join, add: true }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("is required before they can share"),
    });
  });

  it("reports the wrong-caller refusal ahead of the spent-invitation one", async () => {
    // Both would refuse, and the order decides which the user is told. Someone
    // who was never entitled to accept should hear that, not be invited to send
    // a new request they also could not accept.
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
    const driver = callerFor(sessionFor(DRIVER), db).caller;
    const join = { driverId: DRIVER, riderId: OUTSIDER, groupId: GROUP };

    await driver.user.groups.edit({ ...join, add: true });
    await driver.user.groups.edit({ ...join, add: false });

    // The outsider sent the request, so they may not accept it — and it is also
    // spent. The direction refusal is the one that should surface.
    const outsider = callerFor(sessionFor(OUTSIDER), db).caller;

    await expect(
      outsider.user.groups.edit({ ...join, add: true }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("was sent to can accept it"),
    });
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

describe("seat accounting — deleting restores seats to the driver", () => {
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
    // the authorization rules now prevent.
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
      requests: [[OUTSIDER, DRIVER]],
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
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 });

    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("takes a seat when a rider is added to an existing group", async () => {
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
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
    const db = buildGroupsDb({ requests: [[OUTSIDER, DRIVER]] });
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

    // Rejoining needs a fresh invitation now (SCRUM-353) — the one they used
    // on the way in is spent. This is what `requests.create`'s reopen branch
    // writes, and including it keeps the sequence a realistic one rather than
    // one the product would refuse.
    await db.request.updateMany({
      where: { OR: [{ fromUserId: OUTSIDER, toUserId: DRIVER }] },
      data: { status: RequestStatus.PENDING },
    });

    await edit(OUTSIDER, true);
    await edit(RIDER_1, false);

    const seats = db.seatsOf(DRIVER)!;
    expect(seats).toBeGreaterThanOrEqual(0);
    expect(seats).toBeLessThanOrEqual(MAX_SEATS_AVAILABLE);
  });
});

/**
 * Atomicity of the group mutations.
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
      requests: [[RIDER_1, DRIVER]],
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
    // Joining needs a request the caller may accept, so the outsider being
    // added has asked the driver here.
    const db = buildGroupsDb({
      requests: [
        [DRIVER, RIDER_1],
        [OUTSIDER, DRIVER],
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
 * Dissolving a group is a success, not an error.
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
    // The seat accounting must survive the early return.
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
 * A driver cannot walk out of a group and leave it unmanageable.
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
describe("user.groups.edit — a driver cannot strand the group", () => {
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
 * `groups.me` says whether the group has a driver.
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
        // The driverless shape: the driver switched to RIDER and stayed in.
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
 * The seat credit on the remove path follows the group, not the client.
 *
 * `driverId` arrives from input and the remove path never checked it against
 * anything: the authorization block constrains `callerId` and `riderId` only.
 * So a rider leaving their own group could name any user at all and the seat
 * credit landed on that stranger's `carpool_search` row, while the group's real
 * driver was never credited and stayed under-counted for the rest of the
 * group's life. That is the cross-tenant write shape the authorization work
 * removed elsewhere, surviving in this one branch.
 *
 * Every pre-existing remove-path test passed the real `DRIVER`, which is why
 * earlier work touched this function without catching it. These pass a foreign
 * id on purpose.
 */
describe("user.groups.edit — the seat credit follows the group", () => {
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
    // A group already in the driverless state has nobody to credit. Leaving one
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

/**
 * One group per user, and a group's driver is a DRIVER.
 *
 * Both were enforced only by `validateRequestAcceptance` in the client, against
 * `requests.me` data that can be stale. The authorization table established
 * *who* may call these mutations, never which states are legal, so the
 * server accepted all three of these:
 *
 *   - a rider already in another group being joined to a second one, which left
 *     the first holding one member that nothing dissolves;
 *   - the same rider being added twice, which ran `reserveSeat` twice while the
 *     membership write did nothing, so the driver paid two seats for one rider;
 *   - two riders naming one of themselves as driver, producing a group with no
 *     DRIVER - the driverless state.
 *
 * The checks live inside the seat-reservation transaction, so a refusal cannot
 * leave a seat spent, and two concurrent accepts cannot both read "not in a
 * group" before either writes.
 */
describe("user.groups.edit(add) — one group per rider", () => {
  it("refuses a rider who is already in another group, spending no seat", async () => {
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 2,
          groupMessage: "",
        },
        // Already carpooling with somebody else. Under the bug this join moved
        // them, and OTHER_GROUP was left holding its driver alone.
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: OTHER_GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: [
        { id: GROUP, message: "" },
        { id: OTHER_GROUP, message: "" },
      ],
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.carpoolIdOf(RIDER_1)).toBe(OTHER_GROUP);
    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("refuses a second add of the same rider, spending no second seat", async () => {
    // `markRequestAccepted` resolves the request rather than deleting it,
    // so `requireAcceptableRequest` keeps passing and this call used
    // to succeed as a no-op that still cost a seat.
    const db = buildGroupsDb({
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
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.seatsOf(DRIVER)).toBe(2);
    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
  });

  it("still admits an ungrouped rider", async () => {
    const db = buildGroupsDb({
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
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: true,
    });

    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
    expect(db.seatsOf(DRIVER)).toBe(1);
  });
});

describe("user.groups.create — legal states only", () => {
  /** Two users with a request between them and no group yet. */
  const pair = (opts: {
    driverRole?: Role;
    driverCarpoolId?: string | null;
    riderCarpoolId?: string | null;
    driverSeats?: number;
  }) =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: opts.driverRole ?? Role.DRIVER,
          carpoolId: opts.driverCarpoolId ?? null,
          seatsAvail: opts.driverSeats ?? 3,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          carpoolId: opts.riderCarpoolId ?? null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups:
        opts.driverCarpoolId || opts.riderCarpoolId
          ? [{ id: OTHER_GROUP, message: "" }]
          : [],
      // The rider asked, so the driver is the one who may accept — every test
      // in this block calls as the driver.
      requests: [[RIDER_1, DRIVER]],
    });

  it("refuses a named driver whose role is RIDER", async () => {
    // Two riders with a request between them could otherwise build a group with
    // no DRIVER in it. `reserveSeat` was no obstacle: `user.edit` accepts
    // seatAvail for any role, so a rider can carry seats.
    const db = pair({ driverRole: Role.RIDER, driverSeats: 2 });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    // The refusal must not cost the named driver a seat.
    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("refuses a named driver whose role is VIEWER", async () => {
    const db = pair({ driverRole: Role.VIEWER, driverSeats: 2 });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
  });

  it("refuses a driver who is already in a group", async () => {
    const db = pair({ driverCarpoolId: OTHER_GROUP });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.groupIds()).toEqual([OTHER_GROUP]);
    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("refuses a rider who is already in a group", async () => {
    // Failure scenario A, from the create side: the rider's old group would
    // have been left holding its driver alone.
    const db = pair({ riderCarpoolId: OTHER_GROUP });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.carpoolIdOf(RIDER_1)).toBe(OTHER_GROUP);
    expect(db.groupIds()).toEqual([OTHER_GROUP]);
    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("still creates a group for two ungrouped users with a real driver", async () => {
    const db = pair({});
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const group = await caller.user.groups.create({
      driverId: DRIVER,
      riderId: RIDER_1,
    });

    expect(db.carpoolIdOf(DRIVER)).toBe(group.id);
    expect(db.carpoolIdOf(RIDER_1)).toBe(group.id);
    expect(db.seatsOf(DRIVER)).toBe(2);
  });
});

/**
 * The double-click, replayed against the server.
 *
 * The Accept button had no in-flight guard, so two clicks fired two independent
 * mutations. The second one used to succeed: it built a second group,
 * took a second seat for the same rider, and left the first group as an orphan
 * nothing could reach.
 *
 * The button is disabled while the first call is running, which cannot be
 * asserted here - there are no component tests in this suite. What *can* be
 * asserted, and is the half that matters if a click still slips through, is that
 * the second call is now a clean rejection: no second group, no second seat, no
 * membership moved. These replay the exact sequence rather than setting the
 * states up directly.
 *
 * **Which guard refuses moved in SCRUM-353, and the code with it.** The first
 * accept resolves the request to ACCEPTED, so the second call is now stopped by
 * `requireAcceptableRequest` — the invitation is spent — before it ever reaches
 * the membership checks that used to answer CONFLICT. The state asserted below
 * is unchanged, which is the property these tests exist for; the message is
 * asserted too, so a future change that moves the refusal again is visible
 * here rather than silently passing for a different reason.
 *
 * The membership guards those CONFLICTs came from are still covered, by
 * "refuses a second add of the same rider" and "refuses a rider who is already
 * in another group" — both of which use a genuinely pending request.
 */
describe("a double-clicked Accept is refused the second time", () => {
  it("creates one group and takes one seat, not two", async () => {
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
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    // Click one.
    const group = await caller.user.groups.create({
      driverId: DRIVER,
      riderId: RIDER_1,
    });

    // Click two, before the first response has been rendered. Refused because
    // click one already spent the invitation, not because the driver is now in
    // a group — see the note on this describe block.
    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("already been used"),
    });

    expect(db.groupIds()).toEqual([group.id]);
    expect(db.seatsOf(DRIVER)).toBe(2);
    expect(db.carpoolIdOf(RIDER_1)).toBe(group.id);
  });

  it("admits the rider once when the driver already has a group", async () => {
    // The other branch of `initiateGroup`: a driver with a group adds to it
    // rather than creating one.
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
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
      requests: [[RIDER_1, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: true,
    });

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: RIDER_1,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("already been used"),
    });

    expect(db.seatsOf(DRIVER)).toBe(2);
    expect(db.carpoolIdOf(RIDER_1)).toBe(GROUP);
  });
});

/**
 * The rider slot has to hold a RIDER.
 *
 * The checks above closed the driver slot: two riders with a request between them
 * could name one of themselves and build a group with no DRIVER in it. The
 * mirror image stayed open - two DRIVERs, whichever accepts, name the other as
 * the rider - and it is worse than it looks, because it passes every remaining
 * check: a seat is spent on somebody who is not riding, and the group ends up
 * with two members who both believe they are driving.
 *
 * It became reachable from the UI when `user.requests.me` stopped hiding a
 * request whose two parties had changed role, which is what put an Accept button
 * in front of a pair who cannot carpool. The client refuses first, with a
 * message that can name whose role moved; these pin the half that a stale cache
 * or a direct call cannot get around.
 */
describe("the rider slot holds a rider", () => {
  /**
   * Two ungrouped users with a request between them, roles configurable.
   * `driverInGroup` puts the driver in `GROUP` already, which is the branch an
   * accept takes through `edit` rather than `create`.
   */
  const facing = (opts: {
    driverRole?: Role;
    riderRole?: Role;
    driverInGroup?: boolean;
    invitation?: RequestPair;
  }) =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: opts.driverRole ?? Role.DRIVER,
          carpoolId: opts.driverInGroup ? GROUP : null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: opts.riderRole ?? Role.RIDER,
          carpoolId: null,
          seatsAvail: opts.riderRole === Role.DRIVER ? 3 : 0,
          groupMessage: "",
        },
      ],
      groups: opts.driverInGroup ? [{ id: GROUP, message: "" }] : [],
      // `[asker, asked]`, defaulting to the outsider asking the driver so the
      // driver is the one entitled to accept. The one test below that calls as
      // the outsider passes the opposite direction.
      requests: [opts.invitation ?? [OUTSIDER, DRIVER]],
    });

  it("refuses create when the named rider is a DRIVER", async () => {
    const db = facing({ riderRole: Role.DRIVER });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    // The refusal must not cost the driver a seat, nor resolve the request -
    // the pair are still free to clear it themselves.
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses create when the named rider is a VIEWER", async () => {
    const db = facing({ riderRole: Role.VIEWER });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("refuses create when the rider is the caller, not just when the driver is", async () => {
    // Either party may call `create` — whichever of them the request was sent
    // to — so the rider-slot guard cannot depend on who did. Here the driver
    // asked, which makes the outsider the legitimate accepter, and the call is
    // still refused because the outsider is not a RIDER.
    const db = facing({
      riderRole: Role.DRIVER,
      invitation: [DRIVER, OUTSIDER],
    });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
  });

  it("refuses edit when the named rider is a DRIVER", async () => {
    // The second join path: a driver who already has a group adds to it, so
    // guarding `create` alone would close the first accept and not the rest.
    const db = facing({ riderRole: Role.DRIVER, driverInGroup: true });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses edit when the named rider is a VIEWER", async () => {
    const db = facing({ riderRole: Role.VIEWER, driverInGroup: true });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("still lets a real rider join a new group", async () => {
    const db = facing({});
    const { caller } = callerFor(sessionFor(DRIVER), db);

    const group = await caller.user.groups.create({
      driverId: DRIVER,
      riderId: OUTSIDER,
    });

    expect(db.carpoolIdOf(OUTSIDER)).toBe(group.id);
    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("still lets a real rider join an existing group", async () => {
    const db = facing({ driverInGroup: true });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
    expect(db.seatsOf(DRIVER)).toBe(2);
  });

  it("does not apply the check to the remove path", async () => {
    // Removing reads `riderId` as "the member leaving", and a member whose role
    // has since changed still has to be able to get out - that is the
    // dead end again, one layer down.
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
          // A rider who has switched to DRIVER while in the group.
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      requests: [[DRIVER, RIDER_2]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_2,
      groupId: GROUP,
      add: false,
    });

    expect(db.carpoolIdOf(RIDER_2)).toBeNull();
  });
});

/**
 * SCRUM-348: the two halves of one inconsistency, asserted together.
 *
 * A driver at `seats_avail = -1` was a live, ACTIVE row in production-derived
 * data — the residue of the accounting SCRUM-229 fixed without repairing what
 * it had already written. The write path refused it and the read path
 * advertised it, so the row was recommended to riders and then rejected every
 * one of them with a message naming the driver as having no space.
 *
 * These are in one block on purpose. Either assertion alone passed before the
 * fix: the join has always been refused, and the offer was always made. It is
 * their *disagreement* that was the bug, so the test that guards it has to be
 * able to see both.
 */
describe("a driver at a negative seat count", () => {
  const negativeSeatDriver = () =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          carpoolId: GROUP,
          seatsAvail: -1,
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
      requests: [[OUTSIDER, DRIVER]],
    });

  it("cannot accept a rider — the write path refuses the reservation", async () => {
    const db = negativeSeatDriver();
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.carpoolIdOf(OUTSIDER)).toBeNull();
    // And the count is not driven further down by the failed attempt.
    expect(db.seatsOf(DRIVER)).toBe(-1);
  });

  it("is not offered to a rider — the read path agrees with that refusal", () => {
    const rider = buildSearch({ id: "current", role: Role.RIDER });
    const driver = buildSearch({
      id: "candidate",
      role: Role.DRIVER,
      seatsAvail: -1,
    });

    // The scorer drops it.
    expect(calculateScore(rider, anyFilters(), "any")(driver)).toBeUndefined();

    // And so does the SQL that runs before the scorer, so the row is not even
    // read. `{ gt: 0 }` is the same object `reserveSeat` decrements under.
    const clause = buildCandidateWhere({
      currentSearch: rider as unknown as CurrentSearch,
      filters: { ...anyFilters(), favorites: false },
      excludedUserIds: ["current"],
      favoriteUserIds: [],
    }).seatsAvail as { gt: number };

    expect(-1 > clause.gt).toBe(false);
    expect(hasSeatAvailable(-1)).toBe(false);
  });

  it("is offered and joinable again once the count is repaired to a real seat", async () => {
    // What the repair plus a driver re-entering their capacity produces. The
    // repair itself writes 0, which is still "no space" — truthfully so.
    const driver = buildSearch({
      id: "candidate",
      role: Role.DRIVER,
      seatsAvail: 1,
    });

    expect(
      calculateScore(
        buildSearch({ id: "current", role: Role.RIDER }),
        anyFilters(),
        "any",
      )(driver),
    ).not.toBeUndefined();

    const db = buildGroupsDb({
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
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      requests: [[OUTSIDER, DRIVER]],
    });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: OUTSIDER,
      groupId: GROUP,
      add: true,
    });

    expect(db.carpoolIdOf(OUTSIDER)).toBe(GROUP);
    expect(db.seatsOf(DRIVER)).toBe(0);
  });
});

/**
 * A paused search stops a group being built, on both slots.
 *
 * The status half of the two role checks above, and it arrived the same way.
 * SCRUM-369 stopped `user.requests.me` hiding a request whose counterpart had
 * paused their search — the dead end being that the request was invisible in
 * both Requests tabs while `requests.create`'s duplicate guard went on refusing
 * every retry with CONFLICT, so neither party could withdraw it — which put an
 * Accept button in front of those pairs for the first time.
 *
 * Nothing here read `CarpoolSearch.status` before. That matters because such a
 * pair is usually *role*-compatible: a paused RIDER and an active DRIVER pass
 * every check this file already had, so a role-only guard waves through exactly
 * the case the visibility change introduced.
 *
 * `validateRequestAcceptance` refuses it first, with a message that can name
 * the person; these pin the half a stale cache or a direct call cannot get
 * around.
 */
describe("a paused search cannot be built into a group", () => {
  /** Two ungrouped users with a request between them, statuses configurable. */
  const paused = (opts: {
    driverStatus?: Status;
    riderStatus?: Status;
    driverInGroup?: boolean;
  }) =>
    buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          status: opts.driverStatus ?? Status.ACTIVE,
          carpoolId: opts.driverInGroup ? GROUP : null,
          seatsAvail: 3,
          groupMessage: "",
        },
        {
          id: "s-outsider",
          userId: OUTSIDER,
          role: Role.RIDER,
          status: opts.riderStatus ?? Status.ACTIVE,
          carpoolId: null,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
      groups: opts.driverInGroup ? [{ id: GROUP, message: "" }] : [],
      // The outsider asks, so the driver is the one entitled to accept.
      requests: [[OUTSIDER, DRIVER]],
    });

  it("creates the group when both are active", async () => {
    // The control. Without it every assertion below could pass because the
    // fixture is broken rather than because the guard fired.
    const db = paused({});
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER });

    expect(db.groupIds()).toHaveLength(1);
  });

  it("refuses create when the rider has paused", async () => {
    const db = paused({ riderStatus: Status.INACTIVE });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    // The refusal must not cost the driver a seat, nor resolve the request —
    // the pair are still free to clear it themselves, which is the whole point
    // of making it visible again.
    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses create when the driver has paused", async () => {
    // Both slots, not just the counterpart's: whichever side paused, the group
    // is one of the two people is not looking for.
    const db = paused({ driverStatus: Status.INACTIVE });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: OUTSIDER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.groupIds()).toEqual([]);
    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("refuses edit when the rider has paused", async () => {
    // `edit` is the branch an accept takes when the driver already has a
    // group, so leaving it out would close the first join and not the second.
    const db = paused({ riderStatus: Status.INACTIVE, driverInGroup: true });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.seatsOf(DRIVER)).toBe(3);
    expect(db.requestStatusOf(OUTSIDER, DRIVER)).toBe(RequestStatus.PENDING);
  });

  it("refuses edit when the driver has paused", async () => {
    // The path a *rider* takes when accepting the request of a driver who
    // already has a group. Checking only the rider would let a paused driver
    // keep gaining riders.
    const db = paused({ driverStatus: Status.INACTIVE, driverInGroup: true });
    const { caller } = callerFor(sessionFor(DRIVER), db);

    await expect(
      caller.user.groups.edit({
        driverId: DRIVER,
        riderId: OUTSIDER,
        groupId: GROUP,
        add: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.seatsOf(DRIVER)).toBe(3);
  });

  it("still lets a paused member leave the group they are already in", async () => {
    // The remove path is untouched, and must stay so. Pausing is how someone
    // steps back from carpooling; it cannot also be what traps them in a
    // group — that would be the dead end this ticket closed, in a new place.
    const db = buildGroupsDb({
      searches: [
        {
          id: "s-driver",
          userId: DRIVER,
          role: Role.DRIVER,
          status: Status.ACTIVE,
          carpoolId: GROUP,
          seatsAvail: 1,
          groupMessage: "",
        },
        {
          id: "s-rider-1",
          userId: RIDER_1,
          role: Role.RIDER,
          status: Status.INACTIVE,
          carpoolId: GROUP,
          seatsAvail: 0,
          groupMessage: "",
        },
      ],
    });
    const { caller } = callerFor(sessionFor(RIDER_1), db);

    await caller.user.groups.edit({
      driverId: DRIVER,
      riderId: RIDER_1,
      groupId: GROUP,
      add: false,
    });

    expect(db.seatsOf(DRIVER)).toBe(2);
  });
});
