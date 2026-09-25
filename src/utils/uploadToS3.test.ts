/**
 * Tests for `signProfileImageUrl`, the whole server-side cost of rendering an
 * avatar.
 *
 * The acceptance criterion SCRUM-366 turns on is "zero S3 API calls", and this
 * is where it is assertable: the S3 client's `send` is the only way this module
 * could reach AWS, so an avatar signed without calling it made no request.
 * Signing a URL is a local HMAC. It used to be preceded by a `HeadObject`
 * asking S3 whether the object existed; `User.profilePictureUpdatedAt` answers
 * that now, and `getPresignedDownloadUrl` calls this only when it is set.
 *
 * The AWS SDK is mocked; nothing here touches S3 or consumes quota.
 */

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
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

/**
 * `NEXT_PUBLIC_ENV` is now validated against an allow-list at import time,
 * so this suite mocks the env module rather than assigning to
 * `process.env` mid-run: envsafe reads the variable once, when the module first
 * loads, and a later assignment would not be seen. It also means the value has
 * to be a real one — the previous `"test-env"` is not a deployment.
 */
const DEPLOY_ENV = "staging";

// Read through a getter, not a plain property: `jest.mock` is hoisted above the
// `const` above, so the factory cannot capture it eagerly — but the getter body
// does not run until `uploadToS3` reads the value, long after both are defined.
jest.mock("./env/browser", () => ({
  browserEnv: {
    get NEXT_PUBLIC_ENV() {
      return DEPLOY_ENV;
    },
  },
}));

import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
  signProfileImageUrl,
} from "./uploadToS3";
import {
  PRESIGNED_URL_CACHE_TIME_MS,
  PRESIGNED_URL_STALE_TIME_MS,
} from "./useProfileImage";
import { serverEnv } from "./env/server";

/**
 * The bucket is configuration now, not a literal, and
 * `jest.setup.env.js` supplies a placeholder for it like any other required
 * variable. Asserting against the configured value rather than "carpoolnubucket"
 * is also the stronger assertion: it pins that the commands are built from
 * configuration, which a hardcoded string could not tell you.
 */
const BUCKET = serverEnv.S3_BUCKET_NAME;

const USER_ID = "user-with-a-picture";
const SIGNED = "https://carpoolnubucket.s3.us-east-2.amazonaws.com/x?sig=abc";

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("signProfileImageUrl", () => {
  it("signs a GET for the user's key without any S3 request", async () => {
    mockGetSignedUrl.mockResolvedValueOnce(SIGNED);

    await expect(signProfileImageUrl(USER_ID)).resolves.toBe(SIGNED);

    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: BUCKET,
      Key: `profile-pictures/${DEPLOY_ENV}/${USER_ID}`,
    });
    // The acceptance criterion, stated as an absence.
    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("signs for the declared expiry", async () => {
    mockGetSignedUrl.mockResolvedValueOnce(SIGNED);

    await signProfileImageUrl(USER_ID);

    const [, , options] = mockGetSignedUrl.mock.calls[0];
    expect(options.expiresIn).toBe(PRESIGNED_DOWNLOAD_EXPIRY_SECONDS);
  });

  it("returns null and logs when signing itself fails", async () => {
    // Misconfigured credentials, not a missing picture. The UI shows the same
    // fallback icon either way, which is why the log line is the only signal.
    mockGetSignedUrl.mockRejectedValueOnce(new Error("signing blew up"));

    await expect(signProfileImageUrl(USER_ID)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
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
    // gcTime only governs how long an *unused* entry is retained, but an
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
