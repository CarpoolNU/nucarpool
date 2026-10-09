import Image from "next/image";
import { useState } from "react";
import { AiOutlineUser } from "react-icons/ai";
import useProfileImage from "../utils/useProfileImage";

interface ProfileAvatarProps {
  /** The user whose picture to draw, or the signed-in user when omitted. */
  userId?: string;
  /**
   * Forwarded to `useProfileImage`. Pass `false` when this avatar is rendered
   * but never seen - `MessageHeader`'s mobile branch is the case the hook
   * documents - so no presigned-URL request is made for it.
   */
  enabled?: boolean;
  alt: string;
  /**
   * `next/image`'s intrinsic hint: the size the raster is *requested* at, not
   * the size it is drawn at. The classes below decide the box.
   */
  width: number;
  height: number;
  /** The neutral block shown while the URL is still being resolved. */
  placeholderClassName: string;
  imageClassName: string;
  /** The `AiOutlineUser` icon shown when there is no picture to draw. */
  fallbackClassName: string;
}

/**
 * One user's avatar: a neutral placeholder while the URL resolves, the picture
 * when there is one, and the fallback icon otherwise.
 *
 * The three branches were repeated at four call sites, which is why this
 * exists: the fallback below depends on state, and four copies of that state
 * is four places for the error handling to drift apart.
 *
 * `ProfilePicture` deliberately does **not** use this. It reads the same hook
 * for a second purpose - `hasStoredPicture` decides whether its Remove button
 * is offered at all - so the hook call has to stay where that logic can see it.
 *
 * Every class is a prop rather than a variant name, because each site sizes its
 * avatar differently and two of them do it responsively. Passing the literal
 * strings in also keeps them in the call site's own source, which is what
 * Tailwind's scan reads.
 */
const ProfileAvatar = ({
  userId,
  enabled,
  alt,
  width,
  height,
  placeholderClassName,
  imageClassName,
  fallbackClassName,
}: ProfileAvatarProps) => {
  const { profileImageUrl, imageLoadError, isLoading } = useProfileImage(
    userId,
    { enabled },
  );

  /**
   * The URL whose image failed to load, rather than a boolean.
   *
   * These are two different failures and only one of them is `imageLoadError`,
   * which is the *query* failing. A presigned URL resolves fine and then 404s
   * at the S3 origin when the object behind it is gone - which it can be, since
   * `useInvalidateProfileImage` reaches only the signed-in user's cache entry,
   * so another viewer holds a URL for a removed picture until it goes stale.
   * That is a successful query pointing at nothing, and without the state below
   * it takes the "show the picture" branch and draws a broken image.
   *
   * Storing the URL makes the state self-correcting. A boolean would latch: the
   * same component instance is reused when its `userId` changes - cards in a
   * list - and after a re-upload the hook hands back a new URL for the same
   * user. In both cases the failure belongs to the old URL, and comparing them
   * lets the new one render instead of inheriting the old one's fallback.
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailedToLoad =
    profileImageUrl !== null && failedUrl === profileImageUrl;

  if (isLoading) {
    return <div className={placeholderClassName} />;
  }

  if (!profileImageUrl || imageLoadError || imageFailedToLoad) {
    return <AiOutlineUser className={fallbackClassName} />;
  }

  return (
    <Image
      src={profileImageUrl}
      alt={alt}
      width={width}
      height={height}
      className={imageClassName}
      // `next/image` forwards this to the underlying `<img>`'s error handler,
      // and re-assigns `src` on mount when it is set, so an error that happened
      // before hydration is not lost. The optimizer answers 400 with no image
      // body when the upstream object is missing, which is what fires it.
      onError={() => setFailedUrl(profileImageUrl)}
    />
  );
};

export default ProfileAvatar;
