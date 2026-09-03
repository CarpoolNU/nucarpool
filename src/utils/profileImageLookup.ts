/**
 * How to answer "does this user have a profile picture?" for one user.
 *
 * `getPresignedImageUrl` used to do two things: a `HeadObjectCommand` — a real
 * network round trip to S3 — and `getSignedUrl`, which is a local HMAC
 * computation and calls nothing. So the `HeadObject` was the **entire** AWS
 * cost of rendering an avatar, and it existed only to tell "no picture" apart
 * from "picture exists" so the UI could show its fallback icon rather than a
 * broken image. On a cold cache an explore view paid up to 50 of them, and
 * `geoJsonUserList` can return 150 users.
 *
 * `User.profilePictureUpdatedAt` records the answer instead (SCRUM-276), so a
 * user whose state is known costs a primary-key lookup on a warm connection
 * rather than an S3 API call.
 *
 * **This is the expand half, and the fallback is the whole point of it.**
 * Every row that predates the column is `null` while its object may well
 * exist — 'never uploaded' and 'uploaded before the column existed' are the
 * same value. Treating `null` as "no picture" would therefore delete the avatar
 * of every user who already had one, which is the failure the ticket called out
 * and the reason it demanded a backfill first. So `null` means **ask S3**, and
 * the old behaviour is what a `null` row still gets.
 *
 * The consequence worth being honest about: the saving is progressive rather
 * than immediate. Anyone who uploads after this deploys is free from then on;
 * everyone else stays exactly as expensive as before until
 * `scripts/backfill-profile-picture-timestamps.ts` has run. Removing the
 * fallback is a separate contract step, once that script reports nothing to do
 * in every environment — the same sequence `group_message` follows in
 * SCRUM-253 / SCRUM-287.
 *
 * Kept as a pure function, away from the S3 client, for the reason every other
 * decision like it in this repository is: the suite runs on mocks with no
 * network, so a predicate is testable where a call site is not.
 */

/** What the download procedure should do about one user's picture. */
export type ImageLookup =
  /** The column is set: sign a URL and make no S3 request at all. */
  | "sign"
  /** The column is null: fall back to `HeadObject`, exactly as before. */
  | "check-s3";

/**
 * Reads the recorded upload time and says which path to take.
 *
 * Takes the timestamp rather than the whole user so it cannot be handed a row
 * that happens to carry a similarly named field, and so the caller has to
 * select the column deliberately.
 */
export const resolveImageLookup = (
  profilePictureUpdatedAt: Date | null | undefined,
): ImageLookup => (profilePictureUpdatedAt ? "sign" : "check-s3");

/**
 * The S3 key prefix every profile picture lives under, for one environment.
 *
 * `NEXT_PUBLIC_ENV` namespaces the keys, which is why changing it orphans
 * existing uploads. Shared with the backfill script so the listing prefix and
 * the upload key cannot drift apart — that would make the backfill silently
 * find nothing rather than fail.
 */
export const profilePicturePrefix = (env: string): string =>
  `profile-pictures/${env}/`;

/**
 * The user id an S3 key belongs to, or null when the key is not a picture in
 * this environment's prefix.
 *
 * Returns null rather than throwing for anything unexpected: a stray object in
 * the bucket is not a reason for the backfill to abort part-way, and a `null`
 * is counted and reported instead. Nested keys are rejected too — a key with a
 * further `/` is not `{prefix}{userId}`, and treating its first segment as a
 * user id would write a timestamp onto the wrong row.
 */
export const userIdFromProfilePictureKey = (
  key: string,
  env: string,
): string | null => {
  const prefix = profilePicturePrefix(env);

  if (!key.startsWith(prefix)) {
    return null;
  }

  const remainder = key.slice(prefix.length);

  // The upload path writes `profile-pictures/{env}/{userId}` and nothing else,
  // so anything with a slash left in it, or nothing left at all, is not ours.
  if (remainder === "" || remainder.includes("/")) {
    return null;
  }

  return remainder;
};
