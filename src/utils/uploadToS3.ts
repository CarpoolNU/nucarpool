import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { serverEnv } from "./env/server";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { browserEnv } from "./env/browser";

// Create an S3 client instance
const s3Client = new S3Client({
  region: "us-east-2",
  credentials: {
    accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
  },
});

export async function generatePresignedUrl(
  fileName: string,
  contentType: string,
) {
  const build = browserEnv.NEXT_PUBLIC_ENV;
  const command = new PutObjectCommand({
    Bucket: "carpoolnubucket",
    Key: `profile-pictures/${build}/${fileName}`,
    ContentType: contentType,
  });

  const expiry = 3600;

  try {
    return await getSignedUrl(s3Client, command, { expiresIn: expiry });
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
      new HeadObjectCommand({ Bucket: "carpoolnubucket", Key: key }),
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
      Bucket: "carpoolnubucket",
      Key: key,
    });
    return await getSignedUrl(s3Client, command, { expiresIn: expiry });
  } catch (error) {
    console.error("Error getting image url", error);
    return null;
  }
}
