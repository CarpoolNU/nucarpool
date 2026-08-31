import { trpc } from "../trpc";
import { useInvalidateProfileImage } from "../useProfileImage";
import {
  MAX_PROFILE_IMAGE_BYTES,
  PROFILE_IMAGE_CONTENT_TYPES,
  ProfileImageContentType,
  isUploadableProfileImage,
} from "../profileImage";

export const useUploadFile = (selectedFile: File | null) => {
  const invalidateProfileImage = useInvalidateProfileImage();
  const uploadable = !!selectedFile && isUploadableProfileImage(selectedFile);

  const { data: presignedData, error } = trpc.user.getPresignedUrl.useQuery(
    {
      contentType: selectedFile?.type as ProfileImageContentType,
      contentLength: selectedFile?.size ?? 0,
    },
    { enabled: uploadable },
  );

  const uploadFile = async () => {
    if (!selectedFile) {
      return;
    }

    // Refusing here rather than silently doing nothing: the query above is
    // disabled for these files, so without this the save would appear to
    // succeed and the picture would never change.
    if (!uploadable) {
      throw new Error(
        `Profile pictures must be one of ${PROFILE_IMAGE_CONTENT_TYPES.join(", ")} and at most ${Math.floor(MAX_PROFILE_IMAGE_BYTES / (1024 * 1024))} MB.`,
      );
    }

    // Also a failure, for the same reason as the check above: a file was
    // selected and the caller asked for it to be uploaded, so returning quietly
    // here would leave the caller reporting a success that never happened. The
    // query is enabled at this point, so reaching this means it errored or has
    // not resolved yet.
    if (!presignedData?.url) {
      throw new Error(
        "Could not prepare the profile picture upload. Please try again.",
      );
    }

    // Content-Type has to match what the server signed, and the browser sets
    // Content-Length from the body — both are in the signature now, so S3
    // rejects the request if either one disagrees.
    const response = await fetch(presignedData.url, {
      method: "PUT",
      headers: {
        "Content-Type": selectedFile.type,
      },
      body: selectedFile,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.statusText}`);
    }

    // The object at profile-pictures/{env}/{userId} has just been replaced,
    // so every cached presigned URL for the signed-in user now points at
    // stale bytes. S3 PUTs are read-after-write consistent, so refetching
    // here is enough - this is what the 600ms timer in useProfileImage was
    // standing in for, and unlike the timer it also updates avatars mounted
    // elsewhere on the page, such as the header.
    await invalidateProfileImage();
  };

  return { uploadFile, error };
};
