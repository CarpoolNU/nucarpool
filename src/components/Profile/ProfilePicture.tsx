import React, { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import Cropper, { Area, MediaSize } from "react-easy-crop";
import { AiOutlineUser } from "react-icons/ai";
import getCroppedImg from "../../utils/cropImage";
import { CROP_BOX_PX, minZoomToFill } from "../../utils/cropZoom";
import useProfileImage from "../../utils/useProfileImage";
import { createPortal } from "react-dom";
interface ProfilePictureProps {
  onFileSelected: (file: File | null) => void;
}
const ProfilePicture = ({ onFileSelected }: ProfilePictureProps) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [croppedImageUrl, setCroppedImageUrl] = useState<string>("");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);

  // The crop rectangle react-easy-crop reports, and the only thing
  // `handleCrop` needs. Its units are the *source image's* pixels, not the
  // cropper box's - a 4032x3024 photo cropped square reports ~3369x3369 - which
  // is why `getCroppedImg` scales it to a capped output rather than trusting it
  // as a canvas size. Typed with the library's own `Area` rather than `any`,
  // because this is the value a future major could reshape without anything
  // here noticing: no test covers this component, and only the size arithmetic
  // is reachable from one (`src/utils/cropImage.test.ts`).
  //
  // `onCropComplete`'s first argument - the same rectangle as percentages - was
  // also being stored, in state nothing ever read. Dropped rather than typed.
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [showModal, setShowModal] = useState<boolean>(false);

  /**
   * The two object URLs this component owns, held in refs rather than read
   * back out of state.
   *
   * `URL.createObjectURL` hands out a reference the browser keeps alive - along
   * with the whole underlying blob - until it is revoked or the document is
   * discarded. On mobile, where the source is a 4MB camera-roll photo, letting
   * those accumulate across a few selections is exactly the memory the ticket
   * is about.
   *
   * Refs because the unmount cleanup below has to see the *current* URL: a
   * cleanup closing over state would revoke whatever was set when the effect
   * was created, which for an empty dependency list is `null` forever.
   */
  const sourceUrlRef = useRef<string | null>(null);
  const croppedUrlRef = useRef<string | null>(null);

  /** Releases the full-resolution source, which only the open cropper needs. */
  const revokeSourceUrl = useCallback(() => {
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }
  }, []);

  // Both URLs die with the component. Safe under StrictMode's double-invoke:
  // the setup does nothing, and on the first mount both refs are still null,
  // so the extra cleanup pass has nothing to revoke.
  useEffect(
    () => () => {
      revokeSourceUrl();
      if (croppedUrlRef.current) {
        URL.revokeObjectURL(croppedUrlRef.current);
        croppedUrlRef.current = null;
      }
    },
    [revokeSourceUrl],
  );

  const {
    profileImageUrl,
    imageLoadError,
    isLoading: isProfileImageLoading,
  } = useProfileImage();

  const onCropComplete = useCallback(
    (_croppedAreaPercentage: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    [],
  );

  const handleCancel = () => {
    revokeSourceUrl();
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setMinZoom(1);
    setCroppedAreaPixels(null);
    setShowModal(false);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      onFileSelected(null);
      return;
    }

    // An object URL rather than `FileReader.readAsDataURL`. A data URL puts a
    // base64 copy of the whole file - about 33% larger than the bytes - on the
    // JS heap, in React state, and then hands the same string to both the
    // cropper's `<img>` and `getCroppedImg`'s `new Image()`, so each decode
    // carries its own copy. An object URL is a short reference to bytes the
    // browser already holds, and the two decodes can share one resource.
    //
    // Revoking first matters: picking a second photo without it would leak the
    // first, which is the common path when someone dislikes their own crop.
    revokeSourceUrl();
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    setImageSrc(url);
    setShowModal(true);
  };

  const handleCrop = async () => {
    if (!imageSrc || !croppedAreaPixels) return;
    try {
      const { file, url } = await getCroppedImg(imageSrc, croppedAreaPixels);

      // The preview this replaces is about to stop being rendered, so its URL
      // is dead. Revoking before storing the new one keeps at most one alive.
      if (croppedUrlRef.current) {
        URL.revokeObjectURL(croppedUrlRef.current);
      }
      croppedUrlRef.current = url;

      setCroppedImageUrl(url);
      onFileSelected(file);
      setShowModal(false);

      // `getCroppedImg` has already decoded and drawn by the time it resolves,
      // so the source is finished with. Nothing else reads it once the modal
      // is closed, and revoking it does not disturb the already-loaded <img>.
      revokeSourceUrl();
      setImageSrc(null);
    } catch (error) {
      console.error(error);
    }
  };
  /**
   * Opens the cropper at the tightest zoom that still covers the crop box, so
   * the square the user takes is entirely photograph.
   *
   * The intent - fill the box and crop the long edge, rather than fit the
   * whole photo inside it and letterbox the rest - is recorded in
   * `minZoomToFill`, along with why `mediaSize`'s *displayed* pair is the
   * right one to measure. This used to divide the crop box by the source
   * photo's natural pixels and then discard the answer for a flat `1`, which
   * left a 4:3 photo shorter than the 300px box and burned black bands into
   * the saved JPEG.
   *
   * Setting `minZoom` as well as `zoom` is what makes it stick: react-easy-crop
   * clamps every subsequent zoom change to `[minZoom, maxZoom]`, so the user
   * cannot pinch back out to an uncovered framing.
   */
  const onMediaLoaded = useCallback((mediaSize: MediaSize) => {
    const fillZoom = minZoomToFill(mediaSize);

    setMinZoom(fillZoom);
    setZoom(fillZoom);
    setCrop({ x: 0, y: 0 }); // ReCenter
  }, []);

  return (
    <>
      {showModal &&
        imageSrc &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-xs">
            <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border-8 border-gray-400 bg-white">
              <div className="relative h-96 w-full">
                <Cropper
                  image={imageSrc}
                  minZoom={minZoom}
                  maxZoom={10}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  showGrid={false}
                  onCropComplete={onCropComplete}
                  onZoomChange={setZoom}
                  onMediaLoaded={onMediaLoaded}
                  cropSize={{ width: CROP_BOX_PX, height: CROP_BOX_PX }}
                  cropShape="round"
                  objectFit="contain"
                  // `restrictPosition` is deliberately absent, which is the
                  // library's default of `true`: it clamps the crop rectangle
                  // inside the photo, so `croppedAreaPixels` can never come
                  // back with a negative origin. Passing `false` disabled that
                  // clamp and was half of SCRUM-479's black bands. The
                  // clamping is the library's to do - it is the only party
                  // that knows the laid-out media size - so this stores the
                  // position it asks for rather than bounding it a second
                  // time against a guess.
                  onCropChange={setCrop}
                />
              </div>
              <div className="flex w-full items-stretch justify-between p-4">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="font-montserrat mr-2 rounded-lg bg-gray-300 px-8 py-2 text-lg text-black"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCrop}
                  className="bg-northeastern-red font-montserrat rounded-lg px-8 py-2 text-lg text-white hover:bg-red-700"
                >
                  Crop Image
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div className="mt-2 flex items-center">
        {croppedImageUrl ? (
          <div className="relative h-40 w-40 flex-shrink-0 overflow-hidden rounded-full">
            <Image
              src={croppedImageUrl}
              alt="Cropped Image"
              fill
              className="object-cover"
            />
          </div>
        ) : isProfileImageLoading ? (
          <div className="h-40 w-40 flex-shrink-0 rounded-full bg-gray-400" />
        ) : profileImageUrl && !imageLoadError ? (
          <div className="relative h-40 w-40 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
            <Image
              src={profileImageUrl}
              alt="Profile Picture"
              fill
              className="object-cover"
            />
          </div>
        ) : (
          <div className="flex h-40 w-40 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-400">
            <AiOutlineUser className="h-28 w-28 text-white" />
          </div>
        )}

        <div className="ml-4">
          <label
            htmlFor="fileInput"
            className="bg-northeastern-red font-montserrat ml-10 inline-block cursor-pointer rounded-lg border border-black px-4 py-2 text-xl text-white hover:bg-red-700"
          >
            Upload Profile Picture
          </label>
          <input
            id="fileInput"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      </div>
    </>
  );
};

export default ProfilePicture;
