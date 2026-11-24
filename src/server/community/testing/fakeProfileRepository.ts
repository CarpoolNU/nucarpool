import {
  UniqueViolation,
  type ProfileRepository,
  type StoredProfile,
} from "../identity/ports";

/**
 * In-memory `ProfileRepository`.
 *
 * **It enforces both unique indexes.** A fake that accepted every insert would
 * let the service's whole concurrency story — "the index is the arbiter" — go
 * untested, and the tests would pass while production raced. These are the two
 * `@unique` declarations in `community.prisma`, reproduced.
 */
export class FakeProfileRepository implements ProfileRepository {
  private rows: StoredProfile[] = [];
  private nextId = 1;

  async findByUserId(userId: string): Promise<StoredProfile | null> {
    return this.rows.find((row) => row.userId === userId) ?? null;
  }

  async findByHandleNormalized(
    normalized: string,
  ): Promise<StoredProfile | null> {
    return this.rows.find((row) => row.handleNormalized === normalized) ?? null;
  }

  async findManyByUserIds(
    userIds: readonly string[],
  ): Promise<readonly StoredProfile[]> {
    return this.rows.filter((row) => userIds.includes(row.userId));
  }

  async insert(input: {
    userId: string;
    handle: string;
    handleNormalized: string;
    dateCreated: Date;
  }): Promise<StoredProfile> {
    if (this.rows.some((row) => row.userId === input.userId)) {
      throw new UniqueViolation("userId");
    }
    if (
      this.rows.some((row) => row.handleNormalized === input.handleNormalized)
    ) {
      throw new UniqueViolation("handleNormalized");
    }

    const stored: StoredProfile = { id: `profile-${this.nextId++}`, ...input };
    this.rows.push(stored);
    return stored;
  }
}
