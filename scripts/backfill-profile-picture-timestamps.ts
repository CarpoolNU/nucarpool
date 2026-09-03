/**
 * Set `User.profile_picture_updated_at` for every user who already has a
 * picture in S3.
 *
 * SCRUM-276 added the column so `getPresignedDownloadUrl` can answer "has a
 * picture?" without an S3 `HeadObject`, which was the entire AWS cost of
 * rendering an avatar. Every row written before the column exists is `null`,
 * and `null` cannot mean "no picture" — an object may well be sitting at
 * `profile-pictures/{env}/{userId}` from before. So the read path still falls
 * back to `HeadObject` for a null row, and **this script is what removes those
 * rows** so the fallback can eventually be deleted.
 *
 * Until it has run, nothing is broken and nothing is lost: a null row behaves
 * exactly as it did before SCRUM-276. What is missing is the saving. The
 * fallback and this script are retired together, once it reports nothing to do
 * in every environment — the sequence `group_message` follows in
 * SCRUM-253 / SCRUM-287.
 *
 * **This is the one script here that reads AWS rather than only the database.**
 * It needs `s3:ListBucket` on the configured bucket. It performs no S3 writes,
 * and it never deletes anything.
 *
 * What timestamp gets written: `LastModified` from the S3 listing, not `now()`.
 * The column is meant to say when the picture last changed, and the listing
 * already knows. Writing `now()` would claim every historical picture was
 * uploaded on backfill day, which is worse than useless for a value whose whole
 * point is being a cache-busting key.
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Only ever fills rows where the column is null, so it cannot overwrite a
 *     real upload time recorded since. Re-running is a no-op.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default 500).
 *   - Updates one row at a time by primary key, so a partial run leaves a
 *     consistent database.
 *   - Keys that do not name an existing user are counted and reported, never
 *     written. A stray object in the bucket is not a reason to abort.
 *
 * Usage:
 *   npx ts-node scripts/backfill-profile-picture-timestamps.ts            # report only
 *   npx ts-node scripts/backfill-profile-picture-timestamps.ts --apply    # write
 *   npx ts-node scripts/backfill-profile-picture-timestamps.ts --apply --max 2000
 *
 * Confirm both `DATABASE_URL` and `NEXT_PUBLIC_ENV` point where you intend
 * before using --apply. `NEXT_PUBLIC_ENV` selects the key prefix, so running it
 * against the wrong one lists an empty prefix and reports zero rather than
 * failing. This script prints neither value.
 */

import { PrismaClient } from "@prisma/client";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { serverEnv } from "../src/utils/env/server";
import { browserEnv } from "../src/utils/env/browser";
import {
  profilePicturePrefix,
  userIdFromProfilePictureKey,
} from "../src/utils/profileImageLookup";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 10;

export type Options = { apply: boolean; max: number };

/**
 * Exported so the test can pin the property that matters most here: writing
 * requires `--apply`, and no argument spelling reaches a write by accident.
 */
export const parseArgs = (argv: string[]): Options => {
  const options: Options = { apply: false, max: DEFAULT_MAX };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--max") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--max expects a positive integer, got ${argv[i]}`);
      }
      options.max = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
};

/** One object in the bucket, reduced to what this script needs. */
export type PictureObject = { key: string; lastModified?: Date };

export type BackfillPlan = {
  /** Rows to write, with the timestamp to write. */
  candidates: { userId: string; uploadedAt: Date }[];
  /** Keys that are not `{prefix}{userId}` at all. */
  unparseableKeys: string[];
  /** Keys naming a user that does not exist, or already has the column set. */
  skipped: { userId: string; reason: "no-such-user" | "already-recorded" }[];
};

/**
 * Decides what to write, given the bucket listing and the rows that need
 * filling.
 *
 * Pure, and the whole reason the script is shaped this way: the suite has no
 * network and no database, so the set arithmetic is testable here while the
 * listing and the updates are not.
 *
 * `nullTimestampUserIds` is the set of users whose column is null — the only
 * rows worth writing. Passing it in rather than every user keeps the decision
 * honest: a user already carrying a timestamp is reported as skipped rather
 * than silently overwritten.
 *
 * A missing `LastModified` falls back to the supplied `now`. S3 always returns
 * it for a real object, so this is defence against a truncated response rather
 * than an expected case — and a present-but-approximate timestamp beats
 * skipping a picture that exists.
 */
export const planBackfill = (
  objects: readonly PictureObject[],
  env: string,
  nullTimestampUserIds: ReadonlySet<string>,
  knownUserIds: ReadonlySet<string>,
  now: Date,
): BackfillPlan => {
  const plan: BackfillPlan = {
    candidates: [],
    unparseableKeys: [],
    skipped: [],
  };

  for (const object of objects) {
    const userId = userIdFromProfilePictureKey(object.key, env);

    if (!userId) {
      plan.unparseableKeys.push(object.key);
      continue;
    }

    if (!knownUserIds.has(userId)) {
      plan.skipped.push({ userId, reason: "no-such-user" });
      continue;
    }

    if (!nullTimestampUserIds.has(userId)) {
      plan.skipped.push({ userId, reason: "already-recorded" });
      continue;
    }

    plan.candidates.push({
      userId,
      uploadedAt: object.lastModified ?? now,
    });
  }

  return plan;
};

/** Every object under the environment's prefix, following continuation tokens. */
const listAllPictures = async (
  s3: S3Client,
  bucket: string,
  prefix: string,
): Promise<PictureObject[]> => {
  const objects: PictureObject[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of page.Contents ?? []) {
      if (object.Key) {
        objects.push({ key: object.Key, lastModified: object.LastModified });
      }
    }

    // `IsTruncated` rather than the token alone: a final page carries no token,
    // and treating a missing token as "keep going" would loop forever.
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
};

const main = async () => {
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const s3 = new S3Client({
    region: serverEnv.S3_REGION,
    credentials: {
      accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
      secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    const env = browserEnv.NEXT_PUBLIC_ENV;
    const prefix = profilePicturePrefix(env);

    const [objects, users] = await Promise.all([
      listAllPictures(s3, serverEnv.S3_BUCKET_NAME, prefix),
      prisma.user.findMany({
        select: { id: true, profilePictureUpdatedAt: true },
      }),
    ]);

    const knownUserIds = new Set(users.map((user) => user.id));
    const nullTimestampUserIds = new Set(
      users
        .filter((user) => user.profilePictureUpdatedAt === null)
        .map((user) => user.id),
    );

    const plan = planBackfill(
      objects,
      env,
      nullTimestampUserIds,
      knownUserIds,
      new Date(),
    );

    console.log(`${objects.length} object(s) under the picture prefix`);
    console.log(`${users.length} user row(s)`);
    console.log(`${plan.candidates.length} row(s) to record`);
    console.log(
      `${plan.skipped.filter((s) => s.reason === "already-recorded").length} already recorded`,
    );
    console.log(
      `${plan.skipped.filter((s) => s.reason === "no-such-user").length} picture(s) for a user that no longer exists`,
    );
    console.log(
      `${plan.unparseableKeys.length} key(s) not matching the prefix`,
    );

    if (plan.candidates.length === 0) {
      console.log("\n✓ nothing to record.");
      return;
    }

    for (const candidate of plan.candidates.slice(0, SAMPLE_SIZE)) {
      console.log(
        `    ${candidate.userId}  ${candidate.uploadedAt.toISOString()}`,
      );
    }
    if (plan.candidates.length > SAMPLE_SIZE) {
      console.log(`    ... and ${plan.candidates.length - SAMPLE_SIZE} more`);
    }

    if (plan.candidates.length > max) {
      console.error(
        `\n✖ ${plan.candidates.length} candidates exceeds --max ${max}. ` +
          `Refusing to run. Confirm this is expected, then re-run with a ` +
          `higher --max.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log("\nDry run — nothing written. Re-run with --apply.");
      return;
    }

    let written = 0;
    let skipped = 0;

    for (const candidate of plan.candidates) {
      // Re-read before writing, like every other script here: a user who
      // uploaded a new picture between the listing and now has a real
      // timestamp, and overwriting it with the old object's LastModified would
      // move their picture backwards in time.
      const current = await prisma.user.findUnique({
        where: { id: candidate.userId },
        select: { profilePictureUpdatedAt: true },
      });

      if (!current || current.profilePictureUpdatedAt !== null) {
        skipped++;
        continue;
      }

      console.log(
        `  ${candidate.userId}: recording ${candidate.uploadedAt.toISOString()}`,
      );
      await prisma.user.update({
        where: { id: candidate.userId },
        data: { profilePictureUpdatedAt: candidate.uploadedAt },
      });
      written++;
    }

    console.log(`\n✓ recorded ${written} picture timestamp(s)`);
    if (skipped > 0) {
      console.log(
        `  ${skipped} row(s) had gained a timestamp by the time they were ` +
          `reached and were left alone`,
      );
    }
  } finally {
    await prisma.$disconnect();
    s3.destroy();
  }
};

// Guarded so the test can import the pure halves without opening a database
// connection, talking to S3, or writing anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
