import { profilePicturePrefix } from "./profileImageLookup";

describe("profilePicturePrefix", () => {
  it("matches the key layout the upload path writes", () => {
    // Shared by `generatePresignedUrl` and `signProfileImageUrl`, so that the
    // place pictures are written and the place they are signed for cannot
    // drift. Drift here would sign every avatar for a key nobody wrote.
    expect(profilePicturePrefix("staging")).toBe("profile-pictures/staging/");
  });

  it("is namespaced per environment, which is why changing it orphans uploads", () => {
    expect(profilePicturePrefix("production")).not.toBe(
      profilePicturePrefix("staging"),
    );
  });
});
