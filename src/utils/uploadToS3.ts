import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { serverEnv } from "./env/server";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { browserEnv } from "./env/browser";
import { ProfileImageContentType } from "./profileImage";
import { profilePicturePrefix } from "./profileImageLookup";

// Create an S3 client instance
const s3Client = new S3Client({
  region: serverEnv.S3_REGION,
  credentials: {
    accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
  },
});

/** How long a presigned *upload* URL stays valid. */
export const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 3600;

/**
 * The headers the upload signature has to cover, and the reason this argument
 * exists at all.
 *
 * `S3RequestPresigner.prepareRequest` unconditionally runs
 * `unsignableHeaders.add("content-type")`, so passing `ContentType` to
 * `PutObjectCommand` does *not* bind it: the URL this used to return was signed
 * over `host` alone, and would accept a PUT of any content type — `text/html`
 * included — at the user's key. Validating the input without this set would have
 * looked like a fix and changed nothing.
 *
 * `signableHeaders` overrides `unsignableHeaders` in `getCanonicalHeaders`,
 * which is what puts both headers into `X-Amz-SignedHeaders`. That is pinned
 * against the real signer in `uploadToS3.signature.test.ts`, because it is a
 * property of the AWS SDK's behaviour rather than of this file.
 */
const UPLOAD_SIGNED_HEADERS = new Set(["content-type", "content-length"]);

/**
 * Signs a URL that will accept exactly one object: the given type, at the given
 * length, at the caller's own key.
 *
 * Both bounds are enforced twice over. The server refuses to sign for anything
 * outside the allow-list or over the cap (see `user.getPresignedUrl`), and S3
 * then refuses any request whose `Content-Type` or `Content-Length` differs from
 * what was signed. A client cannot widen either one after the fact.
 */
export async function generatePresignedUrl(
  fileName: string,
  contentType: ProfileImageContentType,
  contentLength: number,
) {
  const command = new PutObjectCommand({
    Bucket: serverEnv.S3_BUCKET_NAME,
    Key: `${profilePicturePrefix(browserEnv.NEXT_PUBLIC_ENV)}${fileName}`,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  try {
    return await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_UPLOAD_EXPIRY_SECONDS,
      signableHeaders: UPLOAD_SIGNED_HEADERS,
    });
  } catch (error) {
    console.error("Error generating pre-signed URL for putting", error);
    throw new Error("Could not generate pre-signed URL");
  }
}

/**
 * How long a presigned *download* URL stays valid.
 *
 * Exported because useProfileImage serves these URLs from a client-side cache
 * and the cache window has to fit inside this one — see the invariant pinned
 * in uploadToS3.test.ts.
 */
export const PRESIGNED_DOWNLOAD_EXPIRY_SECONDS = 3600;

/**
 * A 404 from HeadObject is the normal answer for every user who has never
 * uploaded a picture, so it is not logged - it used to produce a
 * console.error per avatar per page view.
 *
 * Deliberately narrow: a 403 can also mean "key absent" when the caller lacks
 * s3:ListBucket, but it equally means broken credentials, which is worth
 * seeing in the logs. Both still return null, so the UI behaviour is the same
 * either way; only the logging differs.
 */
function isObjectNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return status === 404 || (error as { name?: string })?.name === "NotFound";
}

/** The object key a user's profile picture lives at, in this environment. */
function profileImageKey(fileName: string): string {
  return `${profilePicturePrefix(browserEnv.NEXT_PUBLIC_ENV)}${fileName}`;
}

/**
 * Signs a GET URL without asking S3 whether the object is there.
 *
 * **This makes no network call.** `getSignedUrl` is a local HMAC computation,
 * which is the fact SCRUM-276 turns on: once
 * `User.profilePictureUpdatedAt` says a picture exists, the `HeadObject` below
 * is pure cost and this is all that is needed.
 *
 * Returns null only if signing itself fails, which means misconfigured
 * credentials rather than a missing picture. The caller cannot tell those apart
 * from the return value, and does not need to - both render the fallback icon -
 * but the log line distinguishes them.
 */
export async function signProfileImageUrl(fileName: string) {
  try {
    const command = new GetObjectCommand({
      Bucket: serverEnv.S3_BUCKET_NAME,
      Key: profileImageKey(fileName),
    });
    return await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
    });
  } catch (error) {
    console.error("Error signing image url", error);
    return null;
  }
}

/**
 * Returns a presigned GET URL for the user's profile picture, or null if they
 * do not have one, asking S3 which it is.
 *
 * Note on cost: the HeadObject here is the only AWS API request, and it exists
 * purely to tell "no picture" apart from "picture exists" so the UI can show
 * its fallback icon instead of a broken image.
 *
 * **Now the fallback rather than the default path.**
 * `getPresignedDownloadUrl` calls `signProfileImageUrl` instead whenever
 * `User.profilePictureUpdatedAt` is set, and only reaches this when the column
 * is null - a row that predates it, whose object may or may not exist. Once
 * `scripts/backfill-profile-picture-timestamps.ts` has run everywhere there are
 * no such rows and this function can go; see `resolveImageLookup`.
 */
export async function getPresignedImageUrl(fileName: string) {
  const key = profileImageKey(fileName);

  try {
    // Check if the object exists
    await s3Client.send(
      new HeadObjectCommand({ Bucket: serverEnv.S3_BUCKET_NAME, Key: key }),
    );
  } catch (error) {
    if (!isObjectNotFound(error)) {
      console.error("Error getting image url", error);
    }
    return null;
  }

  return signProfileImageUrl(fileName);
}
