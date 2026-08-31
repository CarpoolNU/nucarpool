/**
 * What the upload signature actually covers.
 *
 * This is the one test in the suite that runs the *real* AWS signer rather than
 * a mock. That is deliberate: the security property here is not "the router
 * validates its input" — it is "S3 will refuse anything that disagrees with what
 * we signed", and that depends entirely on which headers end up in
 * `X-Amz-SignedHeaders`. A mocked SDK can only tell you the arguments were
 * passed; it cannot tell you they had any effect.
 *
 * Signing is a local HMAC over placeholder credentials. Nothing here reaches
 * AWS, makes a network call, or consumes quota.
 *
 * The uncomfortable finding this pins: passing `ContentType` to
 * `PutObjectCommand` does **not** constrain the upload, because
 * `S3RequestPresigner.prepareRequest` unconditionally adds `content-type` to its
 * unsignable set. Before this change the URL was signed over `host` alone, so it
 * would accept a PUT of any content type at the user's key. An allow-list on the
 * tRPC input, on its own, would have left that completely intact.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { generatePresignedUrl } from "./uploadToS3";
import { serverEnv } from "./env/server";

const USER_ID = "clx0000000000000000000000";

/** The headers S3 will verify against the signature, in canonical order. */
const signedHeaders = (url: string): string[] =>
  (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");

describe("the presigned upload URL", () => {
  it("binds the content type, so the type cannot be changed at upload time", async () => {
    const url = await generatePresignedUrl(USER_ID, "image/jpeg", 1024);

    expect(signedHeaders(url)).toContain("content-type");
  });

  it("binds the content length, so the size cannot be exceeded at upload time", async () => {
    const url = await generatePresignedUrl(USER_ID, "image/jpeg", 1024);

    expect(signedHeaders(url)).toContain("content-length");
  });

  it("signs a URL that differs for two different content types", async () => {
    // If the type were not part of the canonical request, these two would be
    // byte-identical and one URL would serve for both.
    const [jpeg, png] = await Promise.all([
      generatePresignedUrl(USER_ID, "image/jpeg", 1024),
      generatePresignedUrl(USER_ID, "image/png", 1024),
    ]);

    const signature = (url: string) =>
      new URL(url).searchParams.get("X-Amz-Signature");

    expect(signature(jpeg)).not.toBe(signature(png));
  });

  it("signs a URL that differs for two different lengths", async () => {
    const [small, large] = await Promise.all([
      generatePresignedUrl(USER_ID, "image/jpeg", 1024),
      generatePresignedUrl(USER_ID, "image/jpeg", 2048),
    ]);

    const signature = (url: string) =>
      new URL(url).searchParams.get("X-Amz-Signature");

    expect(signature(small)).not.toBe(signature(large));
  });

  it("targets the caller's own key under the profile-pictures prefix", async () => {
    const url = await generatePresignedUrl(USER_ID, "image/jpeg", 1024);

    expect(new URL(url).pathname).toContain(`profile-pictures/`);
    expect(new URL(url).pathname).toContain(USER_ID);
  });
});

/**
 * A pinned assumption about somebody else's library, not about our code.
 *
 * If a future AWS SDK starts signing `content-type` by default this fails, and
 * whoever sees it can delete the `signableHeaders` override with confidence
 * instead of guessing whether it was ever doing anything.
 */
describe("the SDK default this override exists to correct", () => {
  const client = new S3Client({
    region: serverEnv.S3_REGION,
    credentials: {
      accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
      secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
    },
  });

  const command = () =>
    new PutObjectCommand({
      Bucket: serverEnv.S3_BUCKET_NAME,
      Key: `profile-pictures/test/${USER_ID}`,
      ContentType: "image/jpeg",
      ContentLength: 1024,
    });

  it("leaves content-type out of the signature unless it is overridden", async () => {
    const url = await getSignedUrl(client, command(), { expiresIn: 3600 });

    expect(signedHeaders(url)).not.toContain("content-type");
  });

  it("includes content-length without any override", async () => {
    // Only content-type needs the override; asserting both keeps the override
    // honest about what it is actually for.
    const url = await getSignedUrl(client, command(), { expiresIn: 3600 });

    expect(signedHeaders(url)).toContain("content-length");
  });

  it("includes content-type once the override is supplied", async () => {
    const url = await getSignedUrl(client, command(), {
      expiresIn: 3600,
      signableHeaders: new Set(["content-type", "content-length"]),
    });

    expect(signedHeaders(url)).toContain("content-type");
  });
});
