import { Permission, Role } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";

/**
 * Authorization tests for the carpool groups router (SCRUM-220).
 *
 * Every mutation was `protectedRouter` and nothing more, so group and user ids
 * arrived straight from client input: any signed-in student could dissolve
 * someone else's group, evict its riders, insert users, or rewrite the driver's
 * message. These tests pin the rule set the UI already implied — driver-only
 * delete/evict/message, riders may leave, joining needs a request.
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

  const matches = (row: SearchRow, where: any = {}) =>
    (where.userId === undefined || row.userId === where.userId) &&
    (where.carpoolId === undefined || row.carpoolId === where.carpoolId) &&
    (where.id === undefined || row.id === where.id);

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
    update: jest.fn(async ({ where, data }: any) => {
      const row = searches.find((r) => r.id === where.id);
      if (!row) throw new Error(`No carpoolSearch ${where.id}`);
      if (data.carpoolId !== undefined) row.carpoolId = data.carpoolId;
      if (typeof data.seatsAvail === "number") row.seatsAvail = data.seatsAvail;
      if (data.seatsAvail?.decrement)
        row.seatsAvail -= data.seatsAvail.decrement;
      if (data.groupMessage !== undefined) row.groupMessage = data.groupMessage;
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const affected = searches.filter((r) => matches(r, where));
      for (const row of affected) {
        if (data.carpoolId !== undefined) row.carpoolId = data.carpoolId;
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

  const request = {
    findFirst: jest.fn(async ({ where }: any) => {
      const clauses: any[] = where?.OR ?? [where ?? {}];
      const hit = requests.some(([a, b]) =>
        clauses.some((c) => c.fromUserId === a && c.toUserId === b),
      );
      return hit ? { id: "request-1" } : null;
    }),
  };

  return {
    prisma: { carpoolSearch, carpoolGroup, request },
    groupIds: () => [...groups.keys()].sort(),
    messageOf: (id: string) => groups.get(id)?.message,
    carpoolIdOf: (userId: string) =>
      searches.find((r) => r.userId === userId)?.carpoolId,
    carpoolGroup,
    carpoolSearch,
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

describe("user.groups.updateMessage — the message belongs to the driver", () => {
  it("lets the driver rewrite it", async () => {
    const { caller, db } = callerFor(sessionFor(DRIVER));

    await caller.user.groups.updateMessage({ groupId: GROUP, message: "new" });

    expect(db.messageOf(GROUP)).toBe("new");
  });

  it("refuses a rider and leaves the message untouched", async () => {
    const { caller, db } = callerFor(sessionFor(RIDER_1));

    await expect(
      caller.user.groups.updateMessage({ groupId: GROUP, message: "hijacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.messageOf(GROUP)).toBe("original message");
  });

  it("refuses a stranger", async () => {
    const { caller, db } = callerFor(sessionFor(OUTSIDER));

    await expect(
      caller.user.groups.updateMessage({ groupId: GROUP, message: "hijacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.messageOf(GROUP)).toBe("original message");
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

describe("user.groups — authentication gate", () => {
  it("rejects anonymous callers on every mutation without touching the data", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.groups.delete({ groupId: GROUP }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.user.groups.updateMessage({ groupId: GROUP, message: "x" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.user.groups.create({ driverId: DRIVER, riderId: RIDER_1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(db.groupIds()).toEqual([GROUP]);
    expect(db.messageOf(GROUP)).toBe("original message");
    expect(db.carpoolGroup.delete).not.toHaveBeenCalled();
  });
});
