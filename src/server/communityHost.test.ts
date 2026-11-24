import { Permission } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";
import { fakeBlockReader, type BlockRow } from "../testing/blockFake";
import { CURRENT_TERMS_VERSION } from "../utils/termsAcceptance";
import {
  COMMUNITY_DISABLED_MESSAGE,
  NucarpoolHostAdapter,
  communityServicesFor,
  type CommunityHostStore,
} from "./communityHost";
import { appRouter } from "./router";
import type { Context } from "./router/context";

/**
 * `NucarpoolHostAdapter` and the flag gate (SCRUM-742).
 *
 * The adapter delegates every rule to the platform helper that owns it, so
 * these tests pin the *delegation*: that a block in either direction reaches
 * Community, that an audit entry lands with `actorId` set to the moderator,
 * and that terms acceptance means what `ComplianceGate` means by it. The
 * helpers' own behaviour is tested beside them.
 */

type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  permission: Permission;
  isOnboarded: boolean;
  licenseSigned: boolean;
  licenseVersion: string | null;
};

const user = (overrides: Partial<UserRow> & { id: string }): UserRow => ({
  name: `Name ${overrides.id}`,
  email: `${overrides.id}@example.com`,
  permission: Permission.USER,
  isOnboarded: true,
  licenseSigned: true,
  licenseVersion: CURRENT_TERMS_VERSION,
  ...overrides,
});

/** A store with a live `block` fake, a `user` table and a recording audit log. */
const buildStore = ({
  users = [],
  blocks = [],
}: { users?: UserRow[]; blocks?: BlockRow[] } = {}) => {
  const { block } = fakeBlockReader(blocks);
  const store = {
    block,
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.find((candidate) => candidate.id === where.id);
        return row ?? null;
      }),
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) =>
          users.filter((candidate) => where.id.in.includes(candidate.id)),
      ),
    },
    adminAuditLog: { create: jest.fn(async () => ({})) },
  };
  return {
    store,
    adapter: new NucarpoolHostAdapter(store as unknown as CommunityHostStore),
  };
};

describe("getBlockedCounterpartIds", () => {
  it("returns counterparts in both directions, from blockedCounterpartIds", async () => {
    const { adapter } = buildStore({
      blocks: [
        { blockerId: "me", blockedId: "they-were-blocked" },
        { blockerId: "they-blocked-me", blockedId: "me" },
        { blockerId: "someone", blockedId: "else" },
      ],
    });

    const ids = await adapter.getBlockedCounterpartIds("me");

    // The second id is the one a caller is not entitled to learn, and the one
    // a `blockerId = me` check would miss: it is why the port says "never
    // returned to a client".
    expect([...ids].sort()).toEqual(["they-blocked-me", "they-were-blocked"]);
  });

  it("reads the block table once per user per request", async () => {
    const { adapter, store } = buildStore({
      blocks: [{ blockerId: "me", blockedId: "other" }],
    });

    await Promise.all([
      adapter.getBlockedCounterpartIds("me"),
      adapter.getBlockedCounterpartIds("me"),
    ]);
    await adapter.getBlockedCounterpartIds("me");

    expect(store.block.findMany).toHaveBeenCalledTimes(1);
  });

  it("does not share the memo across adapters, which are one per request", async () => {
    const blocks: BlockRow[] = [{ blockerId: "me", blockedId: "other" }];
    const first = buildStore({ blocks });
    expect(await first.adapter.getBlockedCounterpartIds("me")).toEqual([
      "other",
    ]);

    // Unblocking between requests is seen by the next request's adapter.
    const second = buildStore({ blocks: [] });
    expect(await second.adapter.getBlockedCounterpartIds("me")).toEqual([]);
  });
});

describe("getAccountStanding", () => {
  it("reports a user who has no row as absent on every count", async () => {
    const { adapter } = buildStore();

    await expect(adapter.getAccountStanding("ghost")).resolves.toEqual({
      exists: false,
      isOnboarded: false,
      termsAccepted: false,
      permission: "USER",
    });
  });

  it("carries onboarding and permission through from the user row", async () => {
    const { adapter } = buildStore({
      users: [
        user({ id: "admin", permission: Permission.ADMIN, isOnboarded: false }),
      ],
    });

    await expect(adapter.getAccountStanding("admin")).resolves.toEqual({
      exists: true,
      isOnboarded: false,
      termsAccepted: true,
      permission: "ADMIN",
    });
  });

  it.each([
    ["has signed the current version", true, CURRENT_TERMS_VERSION, true],
    // The legacy cohort: signed before versions were recorded. Accepted,
    // because `needsTermsAcceptance` accepts them while re-consent is off.
    ["signed before versions were recorded", true, null, true],
    ["has never signed", false, null, false],
  ])(
    "treats a user who %s as termsAccepted=%s, as ComplianceGate does",
    async (_label, licenseSigned, licenseVersion, termsAccepted) => {
      const { adapter } = buildStore({
        users: [user({ id: "u", licenseSigned, licenseVersion })],
      });

      const standing = await adapter.getAccountStanding("u");

      expect(standing.termsAccepted).toBe(termsAccepted);
    },
  );

  it("reads the user row once per user per request", async () => {
    const { adapter, store } = buildStore({ users: [user({ id: "u" })] });

    await adapter.getAccountStanding("u");
    await adapter.getAccountStanding("u");

    expect(store.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("recordModeratorAction", () => {
  it("writes an AdminAuditLog row with actorId set to the moderator", async () => {
    const { adapter, store } = buildStore();

    await adapter.recordModeratorAction({
      moderatorId: "moderator-1",
      action: "community.moderation.review",
      targetId: "community-report-1",
      metadata: { decision: "DISMISS" },
    });

    expect(store.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(store.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "moderator-1",
        action: "community.moderation.review",
        targetId: "community-report-1",
        metadata: JSON.stringify({ decision: "DISMISS" }),
      },
    });
  });

  it("stores null metadata when the entry carries none, as every other row does", async () => {
    const { adapter, store } = buildStore();

    await adapter.recordModeratorAction({
      moderatorId: "moderator-1",
      action: "community.moderation.queue",
      targetId: "OPEN",
    });

    expect(store.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: "moderator-1", metadata: null }),
    });
  });

  it("propagates a failed write rather than swallowing it", async () => {
    const { adapter, store } = buildStore();
    store.adminAuditLog.create.mockRejectedValueOnce(new Error("db down"));

    await expect(
      adapter.recordModeratorAction({
        moderatorId: "moderator-1",
        action: "community.moderation.queue",
        targetId: "OPEN",
      }),
    ).rejects.toThrow("db down");
  });
});

describe("resolvePlatformIdentities", () => {
  it("audits once, naming the moderator, with the ids in metadata", async () => {
    const { adapter, store } = buildStore({
      users: [user({ id: "a" }), user({ id: "b" })],
    });

    await adapter.resolvePlatformIdentities("moderator-1", ["a", "b"]);

    expect(store.adminAuditLog.create).toHaveBeenCalledTimes(1);
    expect(store.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: "moderator-1",
        action: "community.moderation.identify",
        // The bounded value. A joined id list overflows the indexed column.
        targetId: "moderator-1",
        metadata: JSON.stringify({ userIds: ["a", "b"] }),
      },
    });
  });

  it("returns name and email for the ids that exist, and omits the rest", async () => {
    const { adapter } = buildStore({
      users: [user({ id: "a", name: "Ada", email: "ada@example.com" })],
    });

    const resolved = await adapter.resolvePlatformIdentities("moderator-1", [
      "a",
      "missing",
    ]);

    expect([...resolved.entries()]).toEqual([
      ["a", { userId: "a", name: "Ada", email: "ada@example.com" }],
    ]);
  });

  it("reads no identity when the audit write fails", async () => {
    const { adapter, store } = buildStore({ users: [user({ id: "a" })] });
    store.adminAuditLog.create.mockRejectedValueOnce(new Error("db down"));

    await expect(
      adapter.resolvePlatformIdentities("moderator-1", ["a"]),
    ).rejects.toThrow("db down");
    expect(store.user.findMany).not.toHaveBeenCalled();
  });
});

describe("communityServicesFor", () => {
  /** A client every property read of which fails the test, and says which. */
  const refusingPrisma = () => {
    const touched: string[] = [];
    const prisma = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          throw new Error(`reached ctx.prisma.${String(property)}`);
        },
      },
    ) as unknown as PrismaClient;
    return { prisma, touched };
  };

  const session = (permission: Permission): Session => ({
    expires: "2099-01-01T00:00:00.000Z",
    user: {
      id: "user-1",
      isOnboarded: true,
      tutorialCompleted: true,
      permission,
    },
  });

  /** Every `community.*` path, read off the router rather than listed. */
  const communityPaths = Object.keys(
    (
      appRouter as unknown as {
        _def: { procedures: Record<string, unknown> };
      }
    )._def.procedures,
  ).filter((path) => path.startsWith("community."));

  const invoke = (permission: Permission, path: string) => {
    const { prisma, touched } = refusingPrisma();
    const caller = appRouter.createCaller({
      req: undefined,
      res: undefined,
      session: session(permission),
      prisma,
      sesClient: { send: jest.fn() },
      community: communityServicesFor(prisma, false),
    } as unknown as Context);

    const procedure = path
      .split(".")
      .reduce<Record<string, unknown>>(
        (node, key) => node[key] as Record<string, unknown>,
        caller as unknown as Record<string, unknown>,
      ) as unknown as (input?: unknown) => Promise<unknown>;

    return { call: () => procedure(undefined), touched };
  };

  it("finds the community procedures to sweep", () => {
    // A vacuous sweep is the failure this guards: 23 procedures today.
    expect(communityPaths.length).toBeGreaterThanOrEqual(20);
  });

  describe.each([Permission.USER, Permission.MANAGER])(
    "with the flag off, a signed-in %s",
    (permission) => {
      it.each(communityPaths)("is refused by %s", async (path) => {
        const { call, touched } = invoke(permission, path);

        // NOT_FOUND, not BAD_REQUEST: the gate answered before input
        // validation, so no input could get a caller past it.
        await expect(call()).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: COMMUNITY_DISABLED_MESSAGE,
        });
        expect(touched).toEqual([]);
      });
    },
  );

  it("builds the real services, reading nothing, when the flag is on", () => {
    const { prisma, touched } = refusingPrisma();

    const services = communityServicesFor(prisma, true);

    expect(Object.keys(services).sort()).toEqual(
      [
        "budgets",
        "comments",
        "moderation",
        "posts",
        "profiles",
        "reports",
        "saved",
        "votes",
      ].sort(),
    );
    // Composition is wiring only; no query runs until a procedure calls one.
    expect(touched).toEqual([]);
  });
});

describe("NEXT_PUBLIC_COMMUNITY_ENABLED", () => {
  /** Re-imports `browserEnv` with the flag set to `value` and NODE_ENV production. */
  const flagWith = (value: string | undefined): boolean => {
    jest.resetModules();
    const env = process.env as Record<string, string | undefined>;
    const previous = {
      flag: env.NEXT_PUBLIC_COMMUNITY_ENABLED,
      node: env.NODE_ENV,
    };

    env.NODE_ENV = "production";
    if (value === undefined) {
      delete env.NEXT_PUBLIC_COMMUNITY_ENABLED;
    } else {
      env.NEXT_PUBLIC_COMMUNITY_ENABLED = value;
    }

    try {
      return require("../utils/env/browser").browserEnv
        .NEXT_PUBLIC_COMMUNITY_ENABLED as boolean;
    } finally {
      env.NODE_ENV = previous.node;
      if (previous.flag === undefined) {
        delete env.NEXT_PUBLIC_COMMUNITY_ENABLED;
      } else {
        env.NEXT_PUBLIC_COMMUNITY_ENABLED = previous.flag;
      }
    }
  };

  it("is off in production when a deployment never sets it", () => {
    expect(flagWith(undefined)).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("reads %s as %s", (value, expected) => {
    expect(flagWith(value)).toBe(expected);
  });
});
