/**
 * The one behaviour in `profileImageStub` that is not a constant: a partial
 * override is merged over a *complete* default.
 *
 * This is the whole reason the stub is worth sharing rather than merely
 * shorter. Six of the fourteen files it replaces returned
 * `{ profileImageUrl, isLoading }` and omitted `imageLoadError`, so a
 * component branching on it read `undefined` - falsy, and therefore silently
 * the "no error" path - in every one of those suites. The test below is what
 * makes that gap unreachable rather than merely fixed once.
 *
 * The rest of the module is a literal surface, and per this ticket's testing
 * requirements a test asserting a one-line stub returns its own constant is
 * noise.
 */

import { renderHook } from "@testing-library/react";
import useProfileImage from "../utils/useProfileImage";
import { buildProfileImageMock, profileImageSpies } from "./profileImageStub";

jest.mock("../utils/useProfileImage", () =>
  require("./profileImageStub").buildProfileImageMock({ isLoading: true }),
);

/** Exactly what the real hook returns - the contract the stub must not narrow. */
const REAL_KEYS = ["profileImageUrl", "isLoading", "imageLoadError"];

describe("buildProfileImageMock", () => {
  it("serves the override a consumer's jest.mock asked for", () => {
    const { result } = renderHook(() => useProfileImage());

    expect(result.current.isLoading).toBe(true);
  });

  it("keeps every key of the real result when only one is overridden", () => {
    // The regression guard. `isLoading` was named above; the other two must
    // still be present, and present is the claim - not merely falsy, which
    // `undefined` also satisfies.
    const { result } = renderHook(() => useProfileImage());

    expect(Object.keys(result.current).sort()).toEqual([...REAL_KEYS].sort());
    expect(result.current.imageLoadError).toBe(false);
    expect(result.current.profileImageUrl).toBeNull();
  });

  it("defaults to a settled, pictureless, error-free result", () => {
    expect(buildProfileImageMock().default()).toEqual({
      profileImageUrl: null,
      isLoading: false,
      imageLoadError: false,
    });
  });

  it("exposes useInvalidateProfileImage, which every hand-rolled mock dropped", () => {
    // `useUploadFile` calls it. A mock replacing the module with `default`
    // alone left it `undefined`, which would throw from inside a hook the
    // first time a suite reached an upload.
    const mock = buildProfileImageMock();

    expect(mock.useInvalidateProfileImage()).toBe(
      profileImageSpies().invalidateProfileImage,
    );
  });

  it("re-exports the real timing constants rather than restating them", () => {
    // A fake value here would be a second source of truth for a bound
    // `uploadToS3.test.ts` already asserts against.
    const real = jest.requireActual("../utils/useProfileImage");
    const mock = buildProfileImageMock();

    expect(mock.PRESIGNED_URL_STALE_TIME_MS).toBe(
      real.PRESIGNED_URL_STALE_TIME_MS,
    );
    expect(mock.PRESIGNED_URL_CACHE_TIME_MS).toBe(
      real.PRESIGNED_URL_CACHE_TIME_MS,
    );
  });
});
