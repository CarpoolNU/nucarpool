/**
 * Where a user's profile picture lives in S3.
 *
 * Whether a user *has* one is not an S3 question: `User.profilePictureUpdatedAt`
 * records it, `getPresignedDownloadUrl` signs only when it is set, and a null
 * column means "no picture". This module is only the key layout.
 */

/**
 * The S3 key prefix every profile picture lives under, for one environment.
 *
 * `NEXT_PUBLIC_ENV` namespaces the keys, which is why changing it orphans
 * existing uploads.
 */
export const profilePicturePrefix = (env: string): string =>
  `profile-pictures/${env}/`;
