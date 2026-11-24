import type { CommunityHostPort } from "../host/CommunityHostPort";
import type { CommunityActor, Member, ProfileRef } from "../actor";
import { isMember } from "../actor";
import {
  HandleTakenError,
  NotEligibleError,
  ProfileExistsError,
} from "../shared/errors";
import { parseHandle } from "./domain/handle";
import { requireVisibleProfile } from "./visibleProfile";
import { toPublicProfile, type PublicProfile } from "./public";
import {
  UniqueViolation,
  type ProfileReader,
  type ProfileRepository,
  type StoredProfile,
} from "./ports";

/**
 * Claiming and reading community handles.
 *
 * Knows nothing about tRPC, HTTP, sessions or Prisma. It takes an actor, a
 * repository and a host port, which is why its tests need none of those either.
 */
export class ProfileService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly host: CommunityHostPort,
  ) {}

  /**
   * The actor's handle, for `resolveActor`.
   *
   * Returns a `ProfileRef` rather than the stored row so the transport layer
   * never handles a storage type — it has no business knowing that
   * `handleNormalized` exists.
   */
  async profileRef(userId: string): Promise<ProfileRef | null> {
    const stored = await this.profiles.findByUserId(userId);
    return stored ? { id: stored.id, handle: stored.handle } : null;
  }

  async me(actor: CommunityActor): Promise<PublicProfile | null> {
    const stored = await this.profiles.findByUserId(actor.userId);
    return stored ? toPublicProfile(stored) : null;
  }

  /**
   * Somebody else's profile, by handle.
   *
   * **`Member`, not `CommunityActor`, and that is the tier made into a type.**
   * Every other read in this module is open to a signed-in student, because
   * browsing a feed is what you do before deciding to take part. Gathering one
   * person's whole output is a different capability: requiring the viewer to
   * have claimed a handle means the person doing the looking is exactly as
   * identifiable inside this community as the person being looked at. The
   * symmetry is the justification, so the signature carries it.
   *
   * **Returns the profile and nothing derived from it.** No post count, no
   * votes received, nothing from the NUCarpool `User` — see `public.ts` for
   * why `PublicProfile` having no field for them is the mechanism rather than
   * the convention.
   */
  async byHandle(actor: Member, handle: string): Promise<PublicProfile> {
    const { profile } = await requireVisibleProfile(
      this.profiles,
      this.host,
      actor.userId,
      handle,
    );
    return toPublicProfile(profile);
  }

  /**
   * Claims a handle for an actor who does not yet have one.
   *
   * **There is no check-then-insert.** Reading "is this handle free?" and then
   * inserting leaves a window in which two sessions both read free and both
   * insert; the loser would get an unhandled database error rather than a
   * refusal it can show. Instead the insert goes straight in and the unique
   * index decides, which is correct under any amount of concurrency because the
   * index is the only arbiter either session consults.
   */
  async create(
    actor: CommunityActor,
    rawHandle: string,
  ): Promise<PublicProfile> {
    // The actor type already carries this fact: `member` means "has a profile".
    if (isMember(actor)) {
      throw new ProfileExistsError();
    }

    // Validation first, before any I/O. It is pure and it is the failure a
    // caller hits most often, so spending a round trip to the host to tell
    // someone their handle has a space in it would be wasteful. Handle rules
    // are public anyway — nothing is disclosed by checking them early.
    const { display, normalized } = parseHandle(rawHandle);

    const standing = await this.host.getAccountStanding(actor.userId);
    if (!standing.exists) {
      throw new NotEligibleError("Account not found.");
    }
    if (!standing.isOnboarded) {
      throw new NotEligibleError("Finish setting up your profile first.");
    }
    if (!standing.termsAccepted) {
      throw new NotEligibleError("Accept the terms of use first.");
    }

    try {
      const stored = await this.profiles.insert({
        userId: actor.userId,
        handle: display,
        handleNormalized: normalized,
        dateCreated: this.host.now(),
      });
      return toPublicProfile(stored);
    } catch (error) {
      if (error instanceof UniqueViolation) {
        // Which index refused decides which refusal the caller sees. Both are
        // reachable concurrently: two sessions racing for one handle, or one
        // user double-submitting the claim form.
        throw error.field === "userId"
          ? new ProfileExistsError()
          : new HandleTakenError();
      }
      throw error;
    }
  }
}

/**
 * Adapts a `ProfileRepository` into the `ProfileReader` other modules consume.
 *
 * Keeping these separate is what stops `content` reaching `insert`. The source
 * is named structurally rather than as `ProfileRepository` so a caller cannot
 * pass the write side in and have it survive the cast.
 */
export const asProfileReader = (source: {
  findManyByUserIds(
    userIds: readonly string[],
  ): Promise<readonly StoredProfile[]>;
  findByHandleNormalized(normalized: string): Promise<StoredProfile | null>;
}): ProfileReader => ({
  findManyByUserIds: async (userIds) => {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await source.findManyByUserIds(userIds);
    return new Map(rows.map((row) => [row.userId, row]));
  },

  // Passed straight through: a single handle lookup has no batch to short
  // circuit and no shape to change.
  findByHandleNormalized: (normalized) =>
    source.findByHandleNormalized(normalized),
});
