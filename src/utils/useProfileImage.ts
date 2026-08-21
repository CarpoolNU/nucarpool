import { useCallback } from "react";
import { trpc } from "./trpc";

/**
 * How long a presigned download URL may be served from the React Query cache
 * before it is refetched.
 *
 * getPresignedImageUrl signs for 3600s, so a 15 minute staleTime guarantees
 * every URL handed to <Image> has at least 45 minutes of validity left, even
 * for the last consumer to read it out of the cache. cacheTime is longer so a
 * URL survives a brief period with no avatar mounted - navigating away from
 * the explore page and back should not re-request 50 URLs.
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
 * revisiting a view costs none at all (SCRUM-242).
 *
 * This deliberately has no forced refetch. It used to fire a second request on
 * a 600ms timer after every mount, which doubled the load and still could not
 * refresh a picture uploaded later in the session. Invalidation is now
 * explicit and happens at the point of upload - see useInvalidateProfileImage.
 */
const useProfileImage = (userId?: string) => {
  const { data, error, isLoading } = trpc.user.getPresignedDownloadUrl.useQuery(
    { userId },
    {
      staleTime: PRESIGNED_URL_STALE_TIME_MS,
      cacheTime: PRESIGNED_URL_CACHE_TIME_MS,
    },
  );

  return {
    profileImageUrl: data?.url ?? null,
    /**
     * True only while the URL is still being resolved. Callers should render a
     * neutral placeholder rather than the "no picture" icon while this is set,
     * otherwise every avatar visibly flashes the fallback before its image
     * appears.
     */
    isLoading,
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
  const utils = trpc.useContext();
  return useCallback(
    () => utils.user.getPresignedDownloadUrl.invalidate({ userId: undefined }),
    [utils],
  );
};

export default useProfileImage;
