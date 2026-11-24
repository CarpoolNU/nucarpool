import type {
  AccountStanding,
  CommunityHostPort,
  ModeratorAuditEntry,
  PlatformIdentity,
} from "./CommunityHostPort";

/**
 * The host used by every service test.
 *
 * Its existence is the point of the port: a service can be exercised with no
 * NUCarpool, no Prisma, no session and no clock drift.
 */
export class FakeCommunityHost implements CommunityHostPort {
  private standings = new Map<string, AccountStanding>();
  private blocks = new Map<string, readonly string[]>();
  private identities = new Map<string, PlatformIdentity>();
  public blockLookups = 0;
  /**
   * Every audit write, in order. Public so a test can assert that a moderator
   * action was recorded, which is the property the port requires of every
   * implementation.
   */
  public auditEntries: ModeratorAuditEntry[] = [];

  constructor(private clock: Date = new Date("2026-10-09T12:00:00.000Z")) {}

  /** An account in good standing, which is the uninteresting default. */
  static eligible(): AccountStanding {
    return {
      exists: true,
      isOnboarded: true,
      termsAccepted: true,
      permission: "USER",
    };
  }

  withAccount(userId: string, standing: Partial<AccountStanding> = {}): this {
    this.standings.set(userId, {
      ...FakeCommunityHost.eligible(),
      ...standing,
    });
    return this;
  }

  withBlocksFor(userId: string, counterpartIds: readonly string[]): this {
    this.blocks.set(userId, counterpartIds);
    return this;
  }

  withIdentity(userId: string, identity: Partial<PlatformIdentity> = {}): this {
    this.identities.set(userId, {
      userId,
      name: null,
      email: null,
      ...identity,
    });
    return this;
  }

  setNow(clock: Date): this {
    this.clock = clock;
    return this;
  }

  async getAccountStanding(userId: string): Promise<AccountStanding> {
    return (
      this.standings.get(userId) ?? {
        exists: false,
        isOnboarded: false,
        termsAccepted: false,
        permission: "USER",
      }
    );
  }

  async getBlockedCounterpartIds(userId: string): Promise<readonly string[]> {
    this.blockLookups += 1;
    return this.blocks.get(userId) ?? [];
  }

  async resolvePlatformIdentities(
    actingModeratorId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlatformIdentity>> {
    // Audits before returning, as the port requires of every implementation.
    await this.recordModeratorAction({
      moderatorId: actingModeratorId,
      action: "community.moderation.identify",
      targetId: actingModeratorId,
      metadata: { userIds: [...userIds] },
    });
    const resolved = new Map<string, PlatformIdentity>();
    for (const id of userIds) {
      const identity = this.identities.get(id);
      if (identity) {
        resolved.set(id, identity);
      }
    }
    return resolved;
  }

  async recordModeratorAction(entry: ModeratorAuditEntry): Promise<void> {
    this.auditEntries.push(entry);
  }

  now(): Date {
    return this.clock;
  }
}
