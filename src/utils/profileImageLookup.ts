/**
 * Where a user's profile picture lives in S3.
 *
 * Whether a user *has* one is no longer an S3 question. `User.profilePictureUpdatedAt`
 * records it, `getPresignedDownloadUrl` signs only when it is set, and a null
 * column means "no picture". That became true once a one-off backfill had
 * recorded every picture uploaded before the column existed — until then a
 * null row still asked S3 with a `HeadObject`, and this module held the
 * predicate that told the two apart (SCRUM-276, contracted in SCRUM-366).
 */

/**
 * The S3 key prefix every profile picture lives under, for one environment.
 *
 * `NEXT_PUBLIC_ENV` namespaces the keys, which is why changing it orphans
 * existing uploads.
 */
export const profilePicturePrefix = (env: string): string =>
  `profile-pictures/${env}/`;
