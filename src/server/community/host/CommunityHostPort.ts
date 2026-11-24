/**
 * The one interface through which Community reaches NUCarpool.
 *
 * **Dependency inversion at the module boundary.** Community needs platform
 * facts it does not own — whether an account may participate, who has blocked
 * whom — but importing `src/server/db/blocks.ts` directly would couple the
 * module to NUCarpool's internals and make the standalone build impossible.
 * So Community declares the interface it needs and NUCarpool implements it.
 *
 * Three implementations exist:
 *
 *   - `NucarpoolHostAdapter`  production; lives OUTSIDE this module, at
 *                             `src/server/communityHost.ts`, and is the only
 *                             code that bridges the two sides.
 *   - `StandaloneHostAdapter` the standalone build. Scaffold; discarded at merge.
 *   - `FakeCommunityHost`     every service test. See `fakeHost.ts`.
 *
 * The port carries five members: standing, blocks and the clock, which every
 * read path uses, and the two moderation members, `resolvePlatformIdentities`
 * and `recordModeratorAction`; see the spec, §4.2.
 */

/** What the platform knows about an account, as Community needs it. */
export type AccountStanding = {
  exists: boolean;
  isOnboarded: boolean;
  termsAccepted: boolean;
  permission: "USER" | "ADMIN" | "MANAGER";
};

/**
 * Platform identity. Moderator-only, and every call that produces one is
 * audited. This is the one place Community's pseudonymous handles are allowed
 * to meet a real name and email, which is why it exists as its own type rather
 * than as fields on a profile.
 */
export type PlatformIdentity = {
  userId: string;
  name: string | null;
  email: string | null;
};

/**
 * One row for the platform's admin audit log.
 *
 * **These field names are NUCarpool's `AdminAuditLogInput`, so the production
 * adapter is a delegation rather than a translation.** Community therefore
 * does not invent a second audit vocabulary that the adapter would have to
 * map: it hands over what `buildAuditLogEntry` already accepts, and the entry
 * lands in the same `AdminAuditLog` table as `resolveReport` and
 * `updateUserPermission`. The one deliberate difference is `moderatorId`,
 * which `AdminAuditLogInput` calls `actorId`; Community names the role it
 * knows. NUCarpool's `AdminAuditAction` must also gain the three strings below
 * at merge.
 *
 * `targetId` is a plain string for the same reason `AdminAuditLog.targetId` is
 * an indexed plain string rather than a relation: the audit trail must outlive
 * the rows it describes. That is also what lets it hold the status filter on a
 * page view. A queue page names no single report, and the filter that produced
 * it (`OPEN`, say) is the fact worth finding by index.
 */
export type ModeratorAuditEntry = {
  moderatorId: string;
  /** Named by the tRPC procedure path, following `AdminAuditAction`. */
  action:
    | "community.moderation.queue"
    | "community.moderation.review"
    | "community.moderation.identify";
  /** The report acted on; for a page view, the status filter that produced it. */
  targetId: string;
  metadata?: Record<string, unknown>;
};

export interface CommunityHostPort {
  getAccountStanding(userId: string): Promise<AccountStanding>;

  /**
   * Every user with a block against `userId` in EITHER direction.
   *
   * **Symmetric, and never returned to a client.** NUCarpool's block doctrine
   * (`src/server/db/blocks.ts`) is that a block is one row but a symmetric
   * effect: a check matching only `blockerId = me` would let the blocked user
   * keep reaching the blocker, which is the case blocking exists for. The
   * result therefore includes people who blocked *the caller*, which the
   * caller is not entitled to learn — so this list filters queries and is
   * never serialized into a response.
   *
   * Implementations should memoize per request: nearly every read path calls it.
   */
  getBlockedCounterpartIds(userId: string): Promise<readonly string[]>;

  /**
   * Moderator-only identity resolution. **Implementations MUST audit.**
   *
   * The acting moderator is a required argument, rather than something the
   * adapter reads from a session, precisely so the audit record cannot be
   * omitted: the call cannot be made without naming who made it (spec §13.3).
   * Unmasking is a logged event. The audit write belongs to the implementation
   * and happens on every resolution, which is why `FakeCommunityHost` records
   * one too: a test double that skipped it would let a service pass its tests
   * while depending on an audit the real host might not write.
   *
   * Ids with no platform account are simply absent from the result.
   *
   * **The audit entry is one per call, and the resolved ids go in `metadata`,
   * never in `targetId`.** `AdminAuditLog.targetId` is an indexed VARCHAR(191),
   * and a joined list of cuids overflows it at about seven ids, so the id list
   * lives in `metadata` (`{ userIds }`), which is `@db.Text` and exists for
   * exactly this. `targetId` is the acting moderator's id: it is a bounded
   * value, and the entry's subject really is "this moderator resolved
   * identities". Implementations must not move the list back into `targetId`.
   */
  resolvePlatformIdentities(
    actingModeratorId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, PlatformIdentity>>;

  /**
   * Appends to the platform's existing admin audit log.
   *
   * For the moderator actions that are not an identity resolution, which
   * audits itself: viewing the queue and reviewing a report.
   */
  recordModeratorAction(entry: ModeratorAuditEntry): Promise<void>;

  /**
   * The clock, injected.
   *
   * Rate-limit window flooring and retention arithmetic are pure functions of
   * a `Date`. Taking the clock from the port means they are tested with
   * ordinary values instead of fake timers.
   */
  now(): Date;
}
