import {
  profilePicturePrefix,
  resolveImageLookup,
  userIdFromProfilePictureKey,
} from "./profileImageLookup";

/**
 * The decision SCRUM-276 turns on, and the one place it is checkable.
 *
 * The failure this guards against is not subtle in effect but is invisible in
 * review: reading a `null` column as "no picture" looks like the obvious
 * implementation and would remove the avatar of every user who uploaded one
 * before the column existed. There are no component or integration tests here,
 * so a predicate is the only place that can be pinned.
 */
describe("resolveImageLookup", () => {
  it("signs without touching S3 once an upload has been recorded", () => {
    // The entire point of the ticket: a recorded timestamp means the object is
    // there, so the HeadObject is pure cost.
    expect(resolveImageLookup(new Date("2026-09-03T12:00:00Z"))).toBe("sign");
  });

  it("still asks S3 when nothing has been recorded", () => {
    // Not "no picture". A row predating the column is null whether or not an
    // object exists, so this is the case the fallback exists for.
    expect(resolveImageLookup(null)).toBe("check-s3");
  });

  it("treats undefined like null, for a user row that is absent entirely", () => {
    // `findUnique` returns null for a missing user, and the caller reads
    // `owner?.profilePictureUpdatedAt` — so undefined reaches here and must not
    // be mistaken for a recorded upload.
    expect(resolveImageLookup(undefined)).toBe("check-s3");
  });

  it("never signs on the strength of a falsy timestamp", () => {
    // Stated as an invariant rather than a case list: the only value that may
    // produce "sign" is a real Date. Anything else has to fall back, because
    // signing for an object that is not there shows a broken image.
    for (const value of [null, undefined]) {
      expect(resolveImageLookup(value)).toBe("check-s3");
    }
  });
});

describe("profilePicturePrefix", () => {
  it("matches the key layout the upload path writes", () => {
    // Shared by `generatePresignedUrl` and the backfill's listing, so that the
    // place pictures are written and the place they are looked for cannot
    // drift. Drift here would make the backfill report zero rather than fail,
    // which is the worst possible failure mode for it.
    expect(profilePicturePrefix("staging")).toBe("profile-pictures/staging/");
  });

  it("is namespaced per environment, which is why changing it orphans uploads", () => {
    expect(profilePicturePrefix("production")).not.toBe(
      profilePicturePrefix("staging"),
    );
  });
});

describe("userIdFromProfilePictureKey", () => {
  const env = "staging";

  it("extracts the user id from a key the upload path wrote", () => {
    expect(
      userIdFromProfilePictureKey("profile-pictures/staging/clx123abc", env),
    ).toBe("clx123abc");
  });

  it("ignores a key from another environment's prefix", () => {
    // The backfill lists one prefix, but being explicit costs nothing and
    // stops a production picture being credited to a staging row if the
    // listing is ever widened.
    expect(
      userIdFromProfilePictureKey("profile-pictures/production/clx123abc", env),
    ).toBeNull();
  });

  it("ignores a key outside the picture prefix altogether", () => {
    expect(userIdFromProfilePictureKey("other/thing.png", env)).toBeNull();
  });

  it("ignores the prefix itself, which S3 can return as an object", () => {
    // A directory-style key with nothing after it names no user.
    expect(
      userIdFromProfilePictureKey("profile-pictures/staging/", env),
    ).toBeNull();
  });

  it("rejects a nested key rather than reading its first segment", () => {
    // This is the one that would corrupt data rather than merely miss it:
    // treating `.../clx123abc/thumb.png` as user `clx123abc` would record a
    // picture at a key the download path never signs.
    expect(
      userIdFromProfilePictureKey(
        "profile-pictures/staging/clx123abc/thumb.png",
        env,
      ),
    ).toBeNull();
  });

  it("round-trips every id the upload path could produce", () => {
    // cuids are the only ids here, but the property is what matters: whatever
    // key the prefix helper builds, this has to take apart again.
    for (const userId of ["clx123abc", "a", "0123456789_-Az"]) {
      const key = `${profilePicturePrefix(env)}${userId}`;
      expect(userIdFromProfilePictureKey(key, env)).toBe(userId);
    }
  });
});
