/**
 * The persistence contract for community profiles.
 *
 * Services depend on these interfaces, never on Prisma. That inversion is what
 * lets every business rule be tested against an in-memory fake with no
 * database, and what lets the same service run unchanged in the standalone
 * build and in NUCarpool.
 */

export type StoredProfile = {
  id: string;
  userId: string;
  handle: string;
  handleNormalized: string;
  dateCreated: Date;
};

export type UniqueField = "handleNormalized" | "userId";

/**
 * A uniqueness constraint refused a write.
 *
 * Infrastructure, not domain: it names a database index, so it stops at the
 * service layer, which translates it into whichever domain error fits the
 * operation. It exists because **nothing in this module does check-then-insert**
 * — the index is the arbiter of a concurrent claim, and this is how its verdict
 * gets back to the caller.
 */
export class UniqueViolation extends Error {
  constructor(readonly field: UniqueField) {
    super(`Unique constraint violated: ${field}`);
    this.name = "UniqueViolation";
  }
}

export interface ProfileRepository {
  findByUserId(userId: string): Promise<StoredProfile | null>;

  /** See {@link ProfileReader.findByHandleNormalized}. */
  findByHandleNormalized(normalized: string): Promise<StoredProfile | null>;

  /** Throws {@link UniqueViolation} rather than reading first. */
  insert(input: {
    userId: string;
    handle: string;
    handleNormalized: string;
    dateCreated: Date;
  }): Promise<StoredProfile>;
}

/**
 * The read-only view `identity` publishes to other modules.
 *
 * `content` needs to render handles, so it takes this — not
 * `ProfileRepository`, and not the Prisma client. The dependency runs one
 * direction: `identity` knows nothing about posts.
 */
export interface ProfileReader {
  findManyByUserIds(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredProfile>>;

  /**
   * One profile by its normalized handle, or `null`.
   *
   * **Takes the normalized form, not the raw one**, so the caller has already
   * run `parseHandle` and this cannot be reached with a string the claim path
   * would have refused. The lookup is on the column that carries uniqueness —
   * see `domain/handle.ts` for why that is not `handle`.
   *
   * **This is the one direction `content` is allowed to ask about identity.**
   * The profile post list needs a handle turned into an author id, and doing
   * it here rather than exposing the id to the client is what keeps spec
   * §13.4's "no procedure maps handle → userId" true.
   */
  findByHandleNormalized(normalized: string): Promise<StoredProfile | null>;
}
