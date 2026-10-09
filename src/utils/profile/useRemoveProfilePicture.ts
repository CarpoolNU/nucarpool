import { trpc } from "../trpc";
import { useInvalidateProfileImage } from "../useProfileImage";

/**
 * Deletes the signed-in user's stored profile picture.
 *
 * The mirror of `useUploadFile`, and it follows the same two-step shape for the
 * same reasons: the mutation first, then the cache invalidation, awaited in
 * that order. Invalidating first would race the write and could refetch a URL
 * for a picture the server is still about to forget.
 *
 * Unlike the upload, there is nothing to send to S3 from here — the deletion
 * happens server-side inside `user.removeProfilePicture`, because that is where
 * the ordering against `User.profilePictureUpdatedAt` has to be decided. This
 * hook exists to pair the mutation with the invalidation so no caller can do
 * one without the other.
 *
 * Throws on failure rather than reporting it in a return value. The save
 * handlers need to tell a completed removal from a refused one so they can keep
 * the pending state and let the user retry, exactly as they do for an upload.
 */
export const useRemoveProfilePicture = () => {
  const invalidateProfileImage = useInvalidateProfileImage();
  const { mutateAsync: removePicture } =
    trpc.user.removeProfilePicture.useMutation();

  const removeProfilePicture = async () => {
    await removePicture();

    // The object at profile-pictures/{env}/{userId} is gone and the column is
    // null, so every cached presigned URL for the signed-in user now points at
    // bytes that are not there. This updates every avatar mounted on the page,
    // such as the header, not just the one in the profile form.
    await invalidateProfileImage();
  };

  return { removeProfilePicture };
};
