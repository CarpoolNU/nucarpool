/**
 * Tests for `getPresignedImageUrl` (SCRUM-242).
 *
 * This helper is the entire server-side cost of rendering an avatar. Signing a
 * URL is a local HMAC and makes no network call, so the `HeadObject` it issues
 * first is the only AWS request involved — and a 404 from it is the *normal*
 * result for every user who has never uploaded a picture.
 *
 * Two things are pinned here:
 *
 *   1. A missing object resolves to `null` and is not logged as an error. It
 *      used to emit a `console.error` per avatar per page view.
 *   2. A genuine S3 failure still resolves to `null` — so the UI keeps showing
 *      its fallback icon rather than breaking — but *is* logged, because that
 *      one is worth seeing.
 *
 * The AWS SDK is mocked; nothing here touches S3 or consumes quota.
 */

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  HeadObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ command: "HeadObject", input })),
  GetObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ command: "GetObject", input })),
  PutObjectCommand: jest
    .fn()
    .mockImplementation((input) => ({ command: "PutObject", input })),
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
  getPresignedImageUrl,
} from "./uploadToS3";
import {
  PRESIGNED_URL_CACHE_TIME_MS,
  PRESIGNED_URL_STALE_TIME_MS,
} from "./useProfileImage";

const USER_ID = "user-with-a-picture";
const SIGNED = "https://carpoolnubucket.s3.us-east-2.amazonaws.com/x?sig=abc";

/** How the AWS SDK v3 reports a HeadObject against a key that is not there. */
const notFound = () =>
  Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_ENV = "test-env";
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("getPresignedImageUrl", () => {
  it("returns a signed URL when the object exists", async () => {
    mockSend.mockResolvedValueOnce({});
    mockGetSignedUrl.mockResolvedValueOnce(SIGNED);

    await expect(getPresignedImageUrl(USER_ID)).resolves.toBe(SIGNED);

    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: "carpoolnubucket",
      Key: `profile-pictures/test-env/${USER_ID}`,
    });
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: "carpoolnubucket",
      Key: `profile-pictures/test-env/${USER_ID}`,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("signs for the declared expiry", async () => {
    mockSend.mockResolvedValueOnce({});
    mockGetSignedUrl.mockResolvedValueOnce(SIGNED);

    await getPresignedImageUrl(USER_ID);

    const [, , options] = mockGetSignedUrl.mock.calls[0];
    expect(options.expiresIn).toBe(PRESIGNED_DOWNLOAD_EXPIRY_SECONDS);
  });

  it("returns null without logging when the user has no picture", async () => {
    mockSend.mockRejectedValueOnce(notFound());

    await expect(
      getPresignedImageUrl("user-with-no-picture"),
    ).resolves.toBeNull();

    // The common case. Logging it turned every avatar into console noise.
    expect(errorSpy).not.toHaveBeenCalled();
    // No point signing a URL for an object that is not there.
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null and logs when S3 fails for any other reason", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await expect(getPresignedImageUrl(USER_ID)).resolves.toBeNull();

    // Broken credentials look like this, and silently showing everyone the
    // fallback icon is exactly the failure mode worth a log line.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs when signing itself fails", async () => {
    mockSend.mockResolvedValueOnce({});
    mockGetSignedUrl.mockRejectedValueOnce(new Error("signing blew up"));

    await expect(getPresignedImageUrl(USER_ID)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * A cross-module invariant with no single owner, and the one way this change
 * could fail silently in production: useProfileImage hands out URLs from its
 * cache without re-checking them, so if the cache outlives the signature,
 * avatars start 403ing for reasons no local test would ever surface.
 */
describe("client cache window vs. signature lifetime", () => {
  const expiryMs = PRESIGNED_DOWNLOAD_EXPIRY_SECONDS * 1000;

  it("serves a cached URL for well under its signed lifetime", () => {
    // The last consumer to read a URL out of the cache reads it at
    // staleTime, so that is the worst case, and it wants real headroom
    // rather than a hair's breadth.
    expect(PRESIGNED_URL_STALE_TIME_MS).toBeLessThan(expiryMs / 2);
  });

  it("never keeps a URL past the point where it could expire", () => {
    // cacheTime only governs how long an *unused* entry is retained, but an
    // entry can be revived by a remount, so it must not exceed the signature
    // either.
    expect(PRESIGNED_URL_CACHE_TIME_MS).toBeLessThan(expiryMs);
  });

  it("retains a URL for at least as long as it is considered fresh", () => {
    expect(PRESIGNED_URL_CACHE_TIME_MS).toBeGreaterThanOrEqual(
      PRESIGNED_URL_STALE_TIME_MS,
    );
  });
});
