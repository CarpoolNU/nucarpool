import { useCallback } from "react";
import { trpc } from "./trpc";
import useIsHydrated from "./useIsHydrated";

/**
 * How long a presigned download URL may be served from the React Query cache
 * before it is refetched.
 *
 * getPresignedImageUrl signs for 3600s, so a 15 minute staleTime guarantees
 * every URL handed to <Image> has at least 45 minutes of validity left, even
 * for the last consumer to read it out of the cache. gcTime - what react-query
 * v4 called cacheTime - is longer, so a URL survives a brief period with no
 * avatar mounted: navigating away from the explore page and back should not
 * re-request 50 URLs.
 */
export const PRESIGNED_URL_STALE_TIME_MS = 15 * 60 * 1000;
export const PRESIGNED_URL_CACHE_TIME_MS = 30 * 60 * 1000;

/**
 * Resolves the profile picture URL for a user, or for the signed-in user when
 * `userId` is omitted.
 *
 * One request per user per staleTime window, shared by every avatar on the
 * page: the query key is derived from `userId`, so the same person appearing
 * in a card, a modal and a chat header costs one request, not three, and
 * revisiting a view costs none at all.
 *
 * This deliberately has no forced refetch. It used to fire a second request on
 * a 600ms timer after every mount, which doubled the load and still could not
 * refresh a picture uploaded later in the session. Invalidation is now
 * explicit and happens at the point of upload - see useInvalidateProfileImage.
 */
const useProfileImage = (userId?: string) => {
  /*
   * Holds the request back on a render that hydration may discard.
   *
   * `Header` branches on `useIsMobile`, and React reads `getServerSnapshot`
   * during hydration as well as on the server - so a `Header` present in the
   * server HTML renders its *desktop* branch once on a phone, mounting
   * `DropDownMenu`, before correcting to the bottom navigation. React Query
   * subscribes in a passive effect, which runs before React's corrective
   * re-render, so that discarded mount really did fire an authenticated
   * presigned-URL request for an avatar no mobile visitor ever sees - once per
   * mobile load of `/admin`, the one page that renders `Header` straight from
   * `getServerSideProps` props.
   *
   * `useIsHydrated` is `true` on the first render of a fresh client mount, so
   * this costs the common case nothing: the explore page's avatars still start
   * their requests on their first render. It is `false` only on the pass that
   * could be hydration, which is the only pass that can be thrown away.
   */
  const isHydrated = useIsHydrated();

  const { data, error, isLoading, isPending } =
    trpc.user.getPresignedDownloadUrl.useQuery(
      { userId },
      {
        staleTime: PRESIGNED_URL_STALE_TIME_MS,
        gcTime: PRESIGNED_URL_CACHE_TIME_MS,
        enabled: isHydrated,
      },
    );

  return {
    profileImageUrl: data?.url ?? null,
    /**
     * True only while the URL is still being resolved. Callers should render a
     * neutral placeholder rather than the "no picture" icon while this is set,
     * otherwise every avatar visibly flashes the fallback before its image
     * appears.
     *
     * The second clause is what keeps that promise across the deferral above.
     * A disabled React Query observer is `pending` with a `fetchStatus` of
     * `idle`, and `isLoading` is defined as pending *and* fetching - so it
     * reads `false` while the query is merely held back, which would report
     * "resolved, no picture" and flash the fallback icon for exactly the
     * render this hook is trying to make cheap. `isPending` narrows it to the
     * case with no cached URL to serve: an avatar already in the cache is not
     * loading, deferred or not.
     */
    isLoading: isLoading || (!isHydrated && isPending),
    /** True only when the request itself failed. */
    imageLoadError: !!error,
  };
};

/**
 * Invalidates the signed-in user's cached profile picture URL.
 *
 * The key must match the one useProfileImage builds when it is called with no
 * argument, which is why this lives next to the hook: DropDownMenu and
 * ProfilePicture both call useProfileImage(), so the cached entry for "me" is
 * keyed on `{ userId: undefined }`. Invalidating the whole procedure instead
 * would refetch every other user's avatar mounted at the time.
 */
export const useInvalidateProfileImage = () => {
  const utils = trpc.useUtils();
  return useCallback(
    () => utils.user.getPresignedDownloadUrl.invalidate({ userId: undefined }),
    [utils],
  );
};

export default useProfileImage;
