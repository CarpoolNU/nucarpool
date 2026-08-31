import { Permission } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";

/**
 * Authorization tests for the tRPC middleware contract in `createRouter.ts`.
 *
 * These exercise the real `appRouter` through `createCaller`, with a fabricated
 * session and a mocked Prisma client. The subject is the gate, not the resolvers:
 * every assertion is either "the caller was rejected and the database was never
 * touched" or "the caller got through to the resolver". Nothing here needs a
 * database, and nothing here should be extended into business-logic coverage —
 * that belongs on real-database tests.
 */

/** What a `MIN`/`MAX` aggregate answers for an empty table. */
const NO_DATES = { _min: { dateCreated: null }, _max: { dateCreated: null } };

/** Only the delegate methods the procedures under test actually reach for. */
const buildPrismaMock = () => ({
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
  },
  carpoolSearch: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
  carpoolGroup: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
  },
  conversation: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  message: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  request: {
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue(NO_DATES),
  },
});

type PrismaMock = ReturnType<typeof buildPrismaMock>;

/** Every jest.fn() in the mock, so a test can assert the database was untouched. */
const allPrismaCalls = (prisma: PrismaMock) =>
  Object.values(prisma).flatMap((delegate) => Object.values(delegate));

const buildSession = (
  user: Session["user"] | undefined,
  overrides: Partial<Session> = {},
): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user,
  ...overrides,
});

const sessionFor = (permission: Permission, id = "user-1"): Session =>
  buildSession({
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission,
  });

/**
 * Builds a caller over the real router. `session: null` models an anonymous
 * request, which is what `createContext` produces when there is no cookie.
 */
const callerFor = (session: Session | null, prisma = buildPrismaMock()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), prisma };
};

const expectTrpcError = async (
  invoke: () => Promise<unknown>,
  code: TRPCError["code"],
) => {
  await expect(invoke()).rejects.toMatchObject({ code });
  await expect(invoke()).rejects.toBeInstanceOf(TRPCError);
};

/** Protected procedures that take no input, so the gate can be probed directly. */
const inputlessProtectedProcedures: Array<{
  path: string;
  invoke: (
    caller: ReturnType<typeof appRouter.createCaller>,
  ) => Promise<unknown>;
}> = [
  { path: "user.me", invoke: (c) => c.user.me() },
  { path: "user.completeTutorial", invoke: (c) => c.user.completeTutorial() },
  { path: "user.acceptTerms", invoke: (c) => c.user.acceptTerms() },
  { path: "user.favorites.me", invoke: (c) => c.user.favorites.me() },
  { path: "user.requests.me", invoke: (c) => c.user.requests.me() },
  { path: "user.groups.me", invoke: (c) => c.user.groups.me() },
  {
    path: "user.messages.getUnreadMessageCount",
    invoke: (c) => c.user.messages.getUnreadMessageCount(),
  },
];

/** The admin-gated procedures. */
const adminProcedures: Array<{
  path: string;
  invoke: (
    caller: ReturnType<typeof appRouter.createCaller>,
  ) => Promise<unknown>;
}> = [
  { path: "getAllUsers", invoke: (c) => c.user.admin.getAllUsers() },
  { path: "getDateRange", invoke: (c) => c.user.admin.getDateRange() },
  {
    path: "getDashboardStats",
    invoke: (c) => c.user.admin.getDashboardStats(),
  },
  {
    path: "getDashboardSeries",
    invoke: (c) =>
      c.user.admin.getDashboardSeries({
        start: new Date("2024-01-01"),
        end: new Date("2024-02-01"),
      }),
  },
  {
    path: "updateUserPermission",
    invoke: (c) =>
      c.user.admin.updateUserPermission({
        userId: "someone-else",
        permission: Permission.ADMIN,
      }),
  },
];

describe("protectedRouter", () => {
  it.each(inputlessProtectedProcedures)(
    "rejects an anonymous caller of $path",
    async ({ invoke }) => {
      const { caller } = callerFor(null);

      await expectTrpcError(() => invoke(caller), "UNAUTHORIZED");
    },
  );

  it("rejects an anonymous caller before the resolver reaches the database", async () => {
    const { caller, prisma } = callerFor(null);

    await expect(caller.user.me()).rejects.toThrow();

    for (const call of allPrismaCalls(prisma)) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("rejects an anonymous caller of a procedure with input, before validating it", async () => {
    const { caller } = callerFor(null);

    await expectTrpcError(
      () =>
        // Deliberately invalid input: an empty `value` fails the schema, so
        // this asserts the auth middleware rejects first.
        caller.mapbox.search({ value: "", types: "address" }),
      "UNAUTHORIZED",
    );
  });

  it("lets an ordinary authenticated user through to the resolver", async () => {
    const { caller, prisma } = callerFor(sessionFor(Permission.USER));
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      name: "Test User",
      email: "test@northeastern.edu",
      carpoolSearches: [],
    });

    const me = await caller.user.me();

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(me.id).toBe("user-1");
  });

  it("lets an ordinary authenticated user run a protected mutation", async () => {
    const { caller, prisma } = callerFor(sessionFor(Permission.USER));
    prisma.user.update.mockResolvedValue({
      id: "user-1",
      tutorialCompleted: true,
    });

    await caller.user.completeTutorial();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { tutorialCompleted: true },
    });
  });

  it("passes a session that carries no user, leaving the resolver to reject it", async () => {
    // isProtected only checks that a session exists; each resolver is responsible
    // for the missing-user case, and answers UNAUTHORIZED itself.
    const { caller, prisma } = callerFor(buildSession(undefined));

    await expectTrpcError(() => caller.user.me(), "UNAUTHORIZED");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("adminRouter", () => {
  it.each(adminProcedures)(
    "rejects an anonymous caller of admin.$path",
    async ({ invoke }) => {
      const { caller } = callerFor(null);

      await expectTrpcError(() => invoke(caller), "UNAUTHORIZED");
    },
  );

  it.each(adminProcedures)(
    "rejects a USER-permission caller of admin.$path",
    async ({ invoke }) => {
      const { caller, prisma } = callerFor(sessionFor(Permission.USER));

      await expectTrpcError(() => invoke(caller), "UNAUTHORIZED");

      for (const call of allPrismaCalls(prisma)) {
        expect(call).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a session with no user even though a session exists", async () => {
    const { caller, prisma } = callerFor(buildSession(undefined));

    await expectTrpcError(
      () => caller.user.admin.getAllUsers(),
      "UNAUTHORIZED",
    );
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it.each([Permission.ADMIN, Permission.MANAGER])(
    "lets a %s read the admin dashboard queries",
    async (permission) => {
      const { caller, prisma } = callerFor(sessionFor(permission));

      await expect(caller.user.admin.getAllUsers()).resolves.toEqual([]);
      await expect(caller.user.admin.getDateRange()).resolves.toEqual({
        minDate: null,
        maxDate: null,
      });
      await expect(
        caller.user.admin.getDashboardStats(),
      ).resolves.toMatchObject({ groups: { groupCount: 0 } });
      await expect(
        caller.user.admin.getDashboardSeries({
          start: new Date("2024-01-01"),
          end: new Date("2024-01-08"),
        }),
      ).resolves.toMatchObject({ activeUserCount: [0, null] });
      expect(prisma.user.findMany).toHaveBeenCalled();
    },
  );
});

describe("admin.updateUserPermission manager gate", () => {
  it("lets a MANAGER change another user's permission", async () => {
    const { caller, prisma } = callerFor(sessionFor(Permission.MANAGER));
    prisma.user.update.mockResolvedValue({
      id: "someone-else",
      permission: Permission.ADMIN,
    });

    await caller.user.admin.updateUserPermission({
      userId: "someone-else",
      permission: Permission.ADMIN,
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "someone-else" },
      data: { permission: Permission.ADMIN },
    });
  });

  it("stops an ADMIN who cleared the admin gate from changing permissions", async () => {
    const { caller, prisma } = callerFor(sessionFor(Permission.ADMIN));

    await expectTrpcError(
      () =>
        caller.user.admin.updateUserPermission({
          userId: "someone-else",
          permission: Permission.MANAGER,
        }),
      "FORBIDDEN",
    );
    await expect(
      caller.user.admin.updateUserPermission({
        userId: "someone-else",
        permission: Permission.MANAGER,
      }),
    ).rejects.toThrow("Unauthorized access.");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("stops a MANAGER from changing their own permission", async () => {
    const { caller, prisma } = callerFor(
      sessionFor(Permission.MANAGER, "manager-1"),
    );

    await expectTrpcError(
      () =>
        caller.user.admin.updateUserPermission({
          userId: "manager-1",
          permission: Permission.USER,
        }),
      "FORBIDDEN",
    );
    await expect(
      caller.user.admin.updateUserPermission({
        userId: "manager-1",
        permission: Permission.USER,
      }),
    ).rejects.toThrow("Cannot change own permission.");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("validates its input, so a permission outside the enum is rejected", async () => {
    const { caller, prisma } = callerFor(sessionFor(Permission.MANAGER));

    await expectTrpcError(
      () =>
        caller.user.admin.updateUserPermission({
          userId: "someone-else",
          permission: "SUPERUSER" as Permission,
        }),
      "BAD_REQUEST",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
