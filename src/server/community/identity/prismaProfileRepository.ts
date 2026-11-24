import {
  UniqueViolation,
  type ProfileRepository,
  type StoredProfile,
} from "./ports";

/**
 * The Prisma surface this repository touches.
 *
 * **Narrow on purpose**, following `BlockReader` in `src/server/db/blocks.ts`
 * and `EmailBudgetStore` in `emailBudget.ts`. Two reasons: a test fake only has
 * to supply these three methods, and both the base client and a transaction
 * client satisfy it structurally — so this code works inside a `$transaction`
 * unchanged.
 *
 * It is declared structurally rather than as `PrismaClient["communityProfile"]`
 * so the module typechecks before `prisma generate` has ever seen
 * `community.prisma`.
 */
export type ProfileStore = {
  communityProfile: {
    findUnique(args: {
      where: { userId: string } | { handleNormalized: string };
    }): Promise<StoredProfile | null>;
    findMany(args: {
      where: { userId: { in: string[] } };
    }): Promise<StoredProfile[]>;
    create(args: {
      data: {
        userId: string;
        handle: string;
        handleNormalized: string;
        dateCreated: Date;
      };
    }): Promise<StoredProfile>;
  };
};

/**
 * Prisma's unique-constraint error.
 *
 * `meta.target` names the index that refused. On MySQL it arrives as the
 * column list or the index name, so this matches on substrings of the mapped
 * column names rather than on Prisma's field names.
 */
const uniqueViolationField = (
  error: unknown,
): "handleNormalized" | "userId" | null => {
  const code = (error as { code?: unknown })?.code;
  if (code !== "P2002") {
    return null;
  }

  const target = (error as { meta?: { target?: unknown } })?.meta?.target;
  const described = Array.isArray(target)
    ? target.join(",")
    : String(target ?? "");

  if (
    described.includes("handle_normalized") ||
    described.includes("handleNormalized")
  ) {
    return "handleNormalized";
  }
  if (described.includes("user_id") || described.includes("userId")) {
    return "userId";
  }

  // P2002 with an unrecognised target. Defaulting to the handle is the safer
  // guess — it produces a refusal the user can act on — but the caller is
  // still told it was a uniqueness failure rather than an unexplained fault.
  return "handleNormalized";
};

export class PrismaProfileRepository implements ProfileRepository {
  constructor(private readonly store: ProfileStore) {}

  async findByUserId(userId: string): Promise<StoredProfile | null> {
    return this.store.communityProfile.findUnique({ where: { userId } });
  }

  /**
   * One profile by its normalized handle.
   *
   * `findUnique`, because `handle_normalized` carries a unique index — the
   * same index that decides a concurrent claim. Looking up on the display
   * column instead would lean on MySQL's case-insensitive collation, which is
   * the implicit guarantee `domain/handle.ts` exists to replace.
   */
  async findByHandleNormalized(
    normalized: string,
  ): Promise<StoredProfile | null> {
    return this.store.communityProfile.findUnique({
      where: { handleNormalized: normalized },
    });
  }

  async findManyByUserIds(
    userIds: readonly string[],
  ): Promise<StoredProfile[]> {
    if (userIds.length === 0) {
      return [];
    }
    return this.store.communityProfile.findMany({
      where: { userId: { in: [...userIds] } },
    });
  }

  /**
   * Inserts without reading first.
   *
   * **There is deliberately no "is this handle free?" check.** Reading then
   * inserting leaves a window in which two sessions both read free and both
   * insert, and the loser gets an unhandled database fault rather than a
   * refusal it can render. The unique index is the only arbiter either session
   * consults, so going straight at it is correct under any concurrency.
   */
  async insert(input: {
    userId: string;
    handle: string;
    handleNormalized: string;
    dateCreated: Date;
  }): Promise<StoredProfile> {
    try {
      return await this.store.communityProfile.create({ data: input });
    } catch (error) {
      const field = uniqueViolationField(error);
      if (field) {
        throw new UniqueViolation(field);
      }
      throw error;
    }
  }
}
