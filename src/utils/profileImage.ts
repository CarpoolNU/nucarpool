/**
 * What a profile picture is allowed to be, defined once so the client and the
 * server agree (SCRUM-243).
 *
 * These live apart from `uploadToS3.ts` on purpose: that module constructs an
 * `S3Client` from `serverEnv` at import time, so anything the browser imports
 * from it would drag server-only configuration into the client bundle. The
 * upload hook needs the same limits the router enforces, so the limits go here
 * and both sides import them.
 *
 * The server's copy of these checks is the one that matters. The client's exists
 * so an unsupported file produces a message on the upload screen rather than a
 * rejected request it cannot explain.
 */

/**
 * Content types a profile picture may be uploaded as.
 *
 * `cropImage.ts` re-encodes every upload to JPEG, so the honest client only ever
 * sends `image/jpeg`; the other two are headroom for a change to that pipeline,
 * not current usage.
 *
 * SVG is deliberately absent. It is an image type, but it can carry script, and
 * these objects are handed back to browsers as signed URLs on an amazonaws.com
 * origin — which is precisely the "bucket hosts attacker-supplied content"
 * outcome this allow-list exists to prevent.
 */
export const PROFILE_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ProfileImageContentType =
  (typeof PROFILE_IMAGE_CONTENT_TYPES)[number];

/**
 * Upper bound on a profile picture upload, in bytes.
 *
 * Generous: a 300x300 JPEG at quality 0.7 is tens of kilobytes, so this is a
 * ceiling on abuse rather than a limit any real upload approaches.
 */
export const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Whether a file is one the upload endpoint will sign for. */
export const isUploadableProfileImage = (file: File) =>
  (PROFILE_IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type) &&
  file.size > 0 &&
  file.size <= MAX_PROFILE_IMAGE_BYTES;
