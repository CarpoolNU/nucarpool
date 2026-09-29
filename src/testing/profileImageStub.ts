/**
 * The shared fake of `src/utils/useProfileImage`.
 *
 * Fourteen test files mock this module, and they had already drifted into two
 * shapes: eight return all three fields the hook really returns, and six
 * return only `profileImageUrl` and `isLoading`.
 *
 * That second shape is the reason this is worth sharing rather than merely
 * shorter. The hook returns exactly `{ profileImageUrl, isLoading,
 * imageLoadError }`, so a component branching on `imageLoadError` reads
 * `undefined` in those six suites - falsy, so it silently takes the "no
 * error" path and the test passes whatever the component does with a real
 * error. Building the result from a complete default and merging the caller's
 * overrides over it makes that class of gap unreachable by construction.
 *
 * ---
 *
 * **`require` inside the factory is the only call form that works** - see
 * `trpcHarness.ts` for why. A default export needs the `__esModule` marker,
 * which this sets, so the interop helper hands `default` to the importer:
 *
 *     jest.mock("../../utils/useProfileImage", () =>
 *       require("../../testing/profileImageStub").buildProfileImageMock(),
 *     );
 *
 * The overrides object is evaluated while the hoisted factory runs, so it
 * must not read a `const` declared later in the test file. A suite that needs
 * the result to change between tests uses
 * `profileImageSpies().useProfileImage.mockReturnValue(...)`.
 *
 * ---
 *
 * **Why the surface is wider than the cohort needs.** The real module also
 * exports `useInvalidateProfileImage` and the two presigned-URL timing
 * constants. Every hand-rolled mock replaced the module with `default` alone,
 * so anything reaching `useInvalidateProfileImage` - `useUploadFile` does -
 * would have found `undefined` and thrown from inside a hook. No test in the
 * cohort reaches it today, which is exactly the condition under which the
 * omission goes unnoticed until someone adds one. `mixpanelBrowserStub.js`
 * records the same reasoning.
 *
 * The constants are taken from the real module rather than restated, because
 * a fake value for a timing bound would be a second source of truth for
 * something `uploadToS3.test.ts` already asserts against.
 *
 * They are read with `jest.requireActual`, inside the builder, and both
 * halves of that are load-bearing. A top-level
 * `import { … } from "../utils/useProfileImage"` is a **require cycle**: the
 * consumer's hoisted factory requires this file, this file imports the very
 * module that factory is mocking, and the factory re-enters while it is still
 * initialising - leaving `buildProfileImageMock` undefined at the call that
 * started it. `requireActual` reaches past the mock and so closes the loop,
 * and doing it lazily keeps it out of module scope. `trpcHarness.ts` requires
 * React Query the same way and for the same reason.
 */

/** Exactly what `useProfileImage` returns. */
export type ProfileImageResult = {
  profileImageUrl: string | null;
  isLoading: boolean;
  imageLoadError: boolean;
};

/**
 * The state all fourteen files wanted: no picture, settled, no error. Six of
 * them expressed it with two of the three keys.
 */
const DEFAULT_RESULT: ProfileImageResult = {
  profileImageUrl: null,
  isLoading: false,
  imageLoadError: false,
};

export type ProfileImageSpies = {
  /** The hook itself, so a suite can vary the result between tests. */
  useProfileImage: jest.Mock;
  /** The `useInvalidateProfileImage()` hook. */
  useInvalidateProfileImage: jest.Mock;
  /** The callback that hook returns - what a component actually calls. */
  invalidateProfileImage: jest.Mock;
};

/** Populated by `buildProfileImageMock`; see `trpcHarness.ts` on why this is safe. */
let spies: ProfileImageSpies | null = null;

/** The spies this module owns. Throws when `buildProfileImageMock` has not run. */
export const profileImageSpies = (): ProfileImageSpies => {
  if (!spies) {
    throw new Error(
      "profileImageSpies: buildProfileImageMock has not run. Add " +
        'jest.mock("<path>/utils/useProfileImage", () => ' +
        'require("<path>/testing/profileImageStub").buildProfileImageMock()) ' +
        "to this file.",
    );
  }
  return spies;
};

/** Clears call records on every spy, leaving implementations. For `beforeEach`. */
export const resetProfileImageSpies = (): void => {
  if (!spies) return;
  for (const spy of Object.values(spies)) spy.mockClear();
};

/**
 * Builds the module object `jest.mock("…/utils/useProfileImage")` must return.
 *
 * @param result merged over the complete default, so naming one field cannot
 *   drop the other two.
 */
export const buildProfileImageMock = (
  result: Partial<ProfileImageResult> = {},
) => {
  // Past the mock the caller is installing, and lazily - see the note above
  // on the require cycle a top-level import creates here.
  const real = jest.requireActual("../utils/useProfileImage");

  const invalidateProfileImage = jest.fn(async () => undefined);
  const useProfileImage = jest.fn(() => ({ ...DEFAULT_RESULT, ...result }));
  const useInvalidateProfileImage = jest.fn(() => invalidateProfileImage);

  spies = {
    useProfileImage,
    useInvalidateProfileImage,
    invalidateProfileImage,
  };

  return {
    __esModule: true,
    default: useProfileImage,
    useInvalidateProfileImage,
    PRESIGNED_URL_STALE_TIME_MS: real.PRESIGNED_URL_STALE_TIME_MS,
    PRESIGNED_URL_CACHE_TIME_MS: real.PRESIGNED_URL_CACHE_TIME_MS,
  };
};
