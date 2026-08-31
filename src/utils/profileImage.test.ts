import {
  MAX_PROFILE_IMAGE_BYTES,
  PROFILE_IMAGE_CONTENT_TYPES,
  isUploadableProfileImage,
} from "./profileImage";

/**
 * The client-side half of the profile picture constraints.
 *
 * The server enforces the same two rules and its answer is the one that counts;
 * this exists so the upload screen can say why a file was refused instead of
 * firing a request that comes back BAD_REQUEST. The value of testing it is that
 * the two halves have to agree — a client that is stricter silently blocks legal
 * uploads, and one that is looser produces an error the user cannot act on.
 */

const fileOf = (type: string, size: number) => ({ type, size }) as File;

describe("isUploadableProfileImage", () => {
  it.each(PROFILE_IMAGE_CONTENT_TYPES)("accepts %s", (type) => {
    expect(isUploadableProfileImage(fileOf(type, 1024))).toBe(true);
  });

  it.each(["text/html", "image/svg+xml", "application/pdf", "image/gif", ""])(
    "refuses %s",
    (type) => {
      expect(isUploadableProfileImage(fileOf(type, 1024))).toBe(false);
    },
  );

  it("accepts a file of exactly the cap", () => {
    expect(
      isUploadableProfileImage(fileOf("image/jpeg", MAX_PROFILE_IMAGE_BYTES)),
    ).toBe(true);
  });

  it("refuses a file one byte over the cap", () => {
    expect(
      isUploadableProfileImage(
        fileOf("image/jpeg", MAX_PROFILE_IMAGE_BYTES + 1),
      ),
    ).toBe(false);
  });

  it("refuses an empty file", () => {
    // The server's schema requires a positive length, so a zero-byte file would
    // be rejected there anyway; catching it here keeps the two in step.
    expect(isUploadableProfileImage(fileOf("image/jpeg", 0))).toBe(false);
  });

  it("does not allow SVG, which is the image type that can carry script", () => {
    expect(PROFILE_IMAGE_CONTENT_TYPES).not.toContain("image/svg+xml");
  });
});
