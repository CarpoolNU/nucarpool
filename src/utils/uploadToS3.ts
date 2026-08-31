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
 * exists at all (SCRUM-243).
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
  const build = browserEnv.NEXT_PUBLIC_ENV;
  const command = new PutObjectCommand({
    Bucket: serverEnv.S3_BUCKET_NAME,
    Key: `profile-pictures/${build}/${fileName}`,
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
 * uploaded a picture, so it is not logged (SCRUM-242) - it used to produce a
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

/**
 * Returns a presigned GET URL for the user's profile picture, or null if they
 * do not have one.
 *
 * Note on cost: getSignedUrl is a local HMAC computation and makes no network
 * call. The HeadObject above is the only AWS API request here, and it exists
 * purely to tell "no picture" apart from "picture exists" so the UI can show
 * its fallback icon instead of a broken image.
 */
export async function getPresignedImageUrl(fileName: string) {
  const build = browserEnv.NEXT_PUBLIC_ENV;
  const key = `profile-pictures/${build}/${fileName}`;
  const expiry = PRESIGNED_DOWNLOAD_EXPIRY_SECONDS;

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

  try {
    // If the object exists, generate a pre-signed URL
    const command = new GetObjectCommand({
      Bucket: serverEnv.S3_BUCKET_NAME,
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: expiry });
  } catch (error) {
    console.error("Error getting image url", error);
    return null;
  }
}
