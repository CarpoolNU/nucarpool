import { trpc } from "../trpc";
import { useInvalidateProfileImage } from "../useProfileImage";

export const useUploadFile = (selectedFile: File | null) => {
  const invalidateProfileImage = useInvalidateProfileImage();
  const { data: presignedData, error } = trpc.user.getPresignedUrl.useQuery(
    {
      contentType: selectedFile?.type || "",
    },
    { enabled: !!selectedFile },
  );
  const uploadFile = async () => {
    if (presignedData?.url && selectedFile) {
      const url = presignedData.url;

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

      // The object at profile-pictures/{env}/{userId} has just been replaced,
      // so every cached presigned URL for the signed-in user now points at
      // stale bytes. S3 PUTs are read-after-write consistent, so refetching
      // here is enough - this is what the 600ms timer in useProfileImage was
      // standing in for, and unlike the timer it also updates avatars mounted
      // elsewhere on the page, such as the header (SCRUM-242).
      await invalidateProfileImage();
    }
  };

  return { uploadFile, error };
};
