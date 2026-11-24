import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  createCommunityServices,
  type CommunityServices,
  type CommunityStore,
} from "./community/composition";
import type {
  AccountStanding,
  CommunityHostPort,
  ModeratorAuditEntry,
  PlatformIdentity,
} from "./community/host/CommunityHostPort";
import {
  AdminAuditAction,
  writeAuditLog,
  type AuditLogWriter,
} from "./adminAuditLog";
import { blockedCounterpartIds, type BlockReader } from "./db/blocks";
import { needsTermsAcceptance } from "../utils/termsAcceptance";

/**
 * The bridge between Community and NUCarpool (SCRUM-742).
 *
 * Community declares `CommunityHostPort` and never imports anything of
 * NUCarpool's; this file implements it, and is the only code that knows both
 * sides exist. It invents no policy of its own. Each member delegates to the
 * helper that already owns that rule on the platform side:
 *
 *   - blocks       `blockedCounterpartIds` (`db/blocks.ts`), symmetric
 *   - terms        `needsTermsAcceptance` (`utils/termsAcceptance.ts`), the
 *                  same predicate `ComplianceGate` uses to put up the dialog
 *   - audit        `writeAuditLog` (`adminAuditLog.ts`), the same writer as
 *                  `resolveReport` and `updateUserPermission`
 *
 * so a change to any of those rules reaches Community without an edit here.
 */

/** The Prisma surface the adapter reads and writes, and nothing wider. */
export type CommunityHostStore = BlockReader &
  AuditLogWriter & {
    user: Pick<PrismaClient["user"], "findUnique" | "findMany">;
  };

/** The standing of a user id no row matches. Participation refused on every count. */
const ABSENT: AccountStanding = {
  exists: false,
  isOnboarded: false,
  termsAccepted: false,
  permission: "USER",
};

/**
 * Community's three audit strings, mapped onto `AdminAuditAction`.
 *
 * Typed by `ModeratorAuditEntry["action"]`, so a fourth Community action fails
 * `yarn tsc` here until NUCarpool's list gains it too, rather than writing a
 * row the admin log has no wording for.
 */
const AUDIT_ACTION: Record<ModeratorAuditEntry["action"], AdminAuditAction> = {
  "community.moderation.queue": AdminAuditAction.COMMUNITY_MODERATION_QUEUE,
  "community.moderation.review": AdminAuditAction.COMMUNITY_MODERATION_REVIEW,
  "community.moderation.identify":
    AdminAuditAction.COMMUNITY_MODERATION_IDENTIFY,
};

export class NucarpoolHostAdapter implements CommunityHostPort {
  /**
   * Request-scoped memos (spec §4.4). `createContext` builds one adapter per
   * request, so neither can go stale within a request or leak across one.
   * The promise is cached rather than the value so two concurrent calls for
   * the same user share one query.
   */
  private readonly standing = new Map<string, Promise<AccountStanding>>();
  private readonly counterparts = new Map<string, Promise<readonly string[]>>();

  constructor(private readonly store: CommunityHostStore) {}

  getAccountStanding(userId: string): Promise<AccountStanding> {
    const cached = this.standing.get(userId);
    if (cached) {
      return cached;
    }

    const pending = this.store.user
      .findUnique({
        where: { id: userId },
        select: {
          permission: true,
          isOnboarded: true,
          licenseSigned: true,
          licenseVersion: true,
        },
      })
      .then((row): AccountStanding =>
        row
          ? {
              exists: true,
              isOnboarded: row.isOnboarded,
              termsAccepted: !needsTermsAcceptance(row),
              permission: row.permission,
            }
          : ABSENT,
      );

    this.standing.set(userId, pending);
    return pending;
  }

  /**
   * Both directions, per the doctrine in `db/blocks.ts`, which is why the
   * result must never reach a client: it names people who blocked the caller.
   */
  getBlockedCounterpartIds(userId: string): Promise<readonly string[]> {
    const cached = this.counterparts.get(userId);
    if (cached) {
      return cached;
    }

    const pending = blockedCounterpartIds(this.store, userId);
    this.counterparts.set(userId, pending);
    return pending;
  }

  /**
   * Writes its audit row FIRST. If that write fails the call rejects before
   * any identity is read, so unmasking cannot happen unlogged.
   *
   * One entry per call, with the ids in `metadata` and the moderator as
   * `targetId`; `CommunityHostPort` explains why the list must not move into
   * the indexed `targetId` column.
   */
  async resolvePlatformIdentities(
    actingModeratorId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlatformIdentity>> {
    await this.recordModeratorAction({
      moderatorId: actingModeratorId,
      action: "community.moderation.identify",
      targetId: actingModeratorId,
      metadata: { userIds: [...userIds] },
    });

    const rows = await this.store.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, name: true, email: true },
    });
    return new Map(
      rows.map((row): [string, PlatformIdentity] => [
        row.id,
        { userId: row.id, name: row.name, email: row.email },
      ]),
    );
  }

  /** A delegation with one rename: Community's `moderatorId` is `actorId`. */
  async recordModeratorAction(entry: ModeratorAuditEntry): Promise<void> {
    await writeAuditLog(this.store, {
      actorId: entry.moderatorId,
      action: AUDIT_ACTION[entry.action],
      targetId: entry.targetId,
      metadata: entry.metadata,
    });
  }

  now(): Date {
    return new Date();
  }
}

/** What a caller is told while `NEXT_PUBLIC_COMMUNITY_ENABLED` is off. */
export const COMMUNITY_DISABLED_MESSAGE = "Community isn't available.";

const refuse = (): never => {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: COMMUNITY_DISABLED_MESSAGE,
  });
};

/**
 * `ctx.community` while the flag is off: every service refuses on first touch.
 *
 * **This is the whole flag-off gate, and it holds because every community
 * procedure reaches a service before it does anything else.** All of them are
 * built on the tiers in `router/community/procedures.ts`, whose first step
 * after the session check reads `ctx.community.profiles`. So a signed-in caller
 * gets NOT_FOUND before any input is parsed or any row read, and an anonymous
 * one still gets the platform's UNAUTHORIZED first, which is what
 * `procedureAuthorization.test.ts` sweeps for. `communityHost.test.ts` sweeps
 * every `community.*` procedure to prove the first half, so a procedure that
 * stopped going through a tier would fail there.
 *
 * Gating here rather than in `procedures.ts` keeps the copied Community tree
 * byte-identical to its source repository.
 *
 * Typed as the full `CommunityServices`, so a new service fails `yarn tsc`
 * until it refuses too.
 */
const disabledCommunityServices: CommunityServices = {
  get profiles() {
    return refuse();
  },
  get posts() {
    return refuse();
  },
  get comments() {
    return refuse();
  },
  get votes() {
    return refuse();
  },
  get saved() {
    return refuse();
  },
  get reports() {
    return refuse();
  },
  get moderation() {
    return refuse();
  },
  get budgets() {
    return refuse();
  },
};

/**
 * The value of `ctx.community` for one request.
 *
 * Takes the flag as an argument, rather than reading `browserEnv` itself, so
 * the tests can drive both states without reloading modules.
 *
 * **The `CommunityStore` cast is a narrowing, not a widening**, the same one
 * the standalone build makes. Community's repositories declare their delegate
 * signatures loosely (`args: Record<string, unknown>`), which Prisma's
 * generic `SelectSubset` parameters are not assignable to, although every call
 * the repositories make is one the client accepts. `CommunityStore` is a
 * strict subset of the client's surface, so each repository still sees only
 * the delegates it declares.
 */
export const communityServicesFor = (
  prisma: PrismaClient,
  enabled: boolean,
): CommunityServices =>
  enabled
    ? createCommunityServices(
        prisma as unknown as CommunityStore,
        new NucarpoolHostAdapter(prisma),
      )
    : disabledCommunityServices;
