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
  const utils = trpc.useUtils();
  const uploadable = !!selectedFile && isUploadableProfileImage(selectedFile);
  // The server is not otherwise told the PUT happened - the client uploads
  // straight to S3 - so this is what records the picture's existence. It is
  // the only record: `getPresignedDownloadUrl` never asks S3, so a picture
  // whose upload is not recorded here is never shown.
  const { mutateAsync: recordUpload } =
    trpc.user.recordProfilePictureUpload.useMutation();

  const uploadFile = async () => {
    if (!selectedFile) {
      return;
    }

    // Refusing here rather than silently doing nothing: nothing below signs a
    // URL for these files, so without this the save would appear to succeed
    // and the picture would never change.
    if (!uploadable) {
      throw new Error(
        `Profile pictures must be one of ${PROFILE_IMAGE_CONTENT_TYPES.join(", ")} and at most ${Math.floor(MAX_PROFILE_IMAGE_BYTES / (1024 * 1024))} MB.`,
      );
    }

    // Signed here, at the moment of the PUT, rather than when the file was
    // chosen - and this is the whole of SCRUM-665.
    //
    // A presigned URL is a credential, not query data. It is good for
    // `PRESIGNED_UPLOAD_EXPIRY_SECONDS`, one hour, and as a mounted `useQuery`
    // it could never be refreshed within a visit to `/profile`: the app's
    // `defaultQueryOptions` turn off `refetchOnMount` and
    // `refetchOnWindowFocus`, the observer stays mounted so `gcTime` never
    // elapses, and the key is derived from a file that does not change. A user
    // who cropped a photo and saved an hour later PUT to a dead signature, and
    // the retry the failure toast invites replayed the same dead signature out
    // of cache - every press, until a reload.
    //
    // Fetching imperatively makes the URL milliseconds old by construction and
    // gives a retry a fresh one for free, which closes the class rather than
    // narrowing it. It also stops signing a URL for every user who crops a
    // photo and then abandons the save.
    //
    // `staleTime: 0` is explicit rather than inherited. It is the default
    // today, so this changes nothing now; it is here because a future global
    // `staleTime` would otherwise quietly let `fetchQuery` serve the cached
    // credential again and restore exactly this bug.
    const { url } = await utils.user.getPresignedUrl.fetch(
      {
        contentType: selectedFile.type as ProfileImageContentType,
        contentLength: selectedFile.size,
      },
      { staleTime: 0 },
    );

    // Content-Type has to match what the server signed, and the browser sets
    // Content-Length from the body — both are in the signature now, so S3
    // rejects the request if either one disagrees.
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": selectedFile.type,
      },
      body: selectedFile,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.statusText}`);
    }

    // Only now, and never before the PUT: signing an upload URL is not
    // evidence that anything was uploaded, and recording a picture that does
    // not exist would make the download path sign URLs for a missing object.
    //
    // Awaited before the invalidation below, in that order deliberately: the
    // refetch it triggers reads this column, so invalidating first would race
    // the write and could refetch the old state.
    await recordUpload();

    // The object at profile-pictures/{env}/{userId} has just been replaced,
    // so every cached presigned URL for the signed-in user now points at
    // stale bytes. S3 PUTs are read-after-write consistent, so refetching
    // here is enough, and it updates every avatar mounted on the page, such
    // as the header, not just the one in this component.
    await invalidateProfileImage();
  };

  // No `error` companion any more. It used to carry the signing query's error
  // state, which no longer exists as state: a failure to sign now rejects
  // `uploadFile` itself, on the same path as a failed PUT, which is where both
  // call sites already handle it. Neither ever read `error`.
  return { uploadFile };
};
