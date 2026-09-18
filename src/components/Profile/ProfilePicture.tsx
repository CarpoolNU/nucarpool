import React, { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import Cropper, { Area, MediaSize } from "react-easy-crop";
import { AiOutlineUser } from "react-icons/ai";
import getCroppedImg from "../../utils/cropImage";
import { CROP_BOX_PX, minZoomToFill } from "../../utils/cropZoom";
import useProfileImage from "../../utils/useProfileImage";
import { createPortal } from "react-dom";
interface ProfilePictureProps {
  /**
   * The cropped file waiting to be uploaded, owned by the parent.
   *
   * The preview below is *derived* from this rather than stored alongside it,
   * and that is the whole point of the prop. The file used to live only in the
   * parent while the preview URL lived only here, so unmounting this component
   * - switching profile tabs, or stepping back and forward through onboarding -
   * revoked the preview and left the parent holding a file the user could no
   * longer see, which a later Save would upload anyway (SCRUM-511). Deriving
   * makes the two agree by construction: there is one source of truth, and
   * remounting rebuilds the preview from it.
   */
  selectedFile: File | null;
  onFileSelected: (file: File | null) => void;
}
const ProfilePicture = ({
  selectedFile,
  onFileSelected,
}: ProfilePictureProps) => {
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
   * The full-resolution source the open cropper reads, held in a ref rather
   * than read back out of state.
   *
   * `URL.createObjectURL` hands out a reference the browser keeps alive - along
   * with the whole underlying blob - until it is revoked or the document is
   * discarded. On mobile, where the source is a 4MB camera-roll photo, letting
   * those accumulate across a few selections is exactly the memory the ticket
   * is about.
   *
   * A ref because the unmount cleanup below has to see the *current* URL: a
   * cleanup closing over state would revoke whatever was set when the effect
   * was created, which for an empty dependency list is `null` forever.
   *
   * The preview URL used to be a second ref beside this one. It is now derived
   * from `selectedFile` instead - see the effect below - so its lifetime is the
   * effect's rather than the component's, and nothing here has to remember to
   * revoke it.
   */
  const sourceUrlRef = useRef<string | null>(null);

  /** Releases the full-resolution source, which only the open cropper needs. */
  const revokeSourceUrl = useCallback(() => {
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }
  }, []);

  // The source URL dies with the component. Safe under StrictMode's
  // double-invoke: the setup does nothing, and on the first mount the ref is
  // still null, so the extra cleanup pass has nothing to revoke.
  useEffect(
    () => () => {
      revokeSourceUrl();
    },
    [revokeSourceUrl],
  );

  /**
   * The preview, derived from the parent's pending file.
   *
   * One object URL per file, revoked when the file changes or this unmounts,
   * so at most one is alive at a time - the guarantee the old
   * revoke-before-replace dance in `handleCrop` was making by hand. Because it
   * re-runs on mount, a remount after a tab switch rebuilds the preview from
   * the file the parent still holds, which is what stops a pending upload from
   * becoming invisible.
   */
  useEffect(() => {
    if (!selectedFile) {
      setCroppedImageUrl("");
      return;
    }

    const url = URL.createObjectURL(selectedFile);
    setCroppedImageUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

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

      // `getCroppedImg` makes this URL from the same blob as the file, and the
      // effect above now makes its own from the file the parent stores. So this
      // one is redundant the moment it exists - revoked here rather than left
      // to the browser, because holding it would be a leak per crop and
      // rendering it would reintroduce the preview that outlives its file.
      URL.revokeObjectURL(url);

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
            {/*
              `max-h` and the column are what keep the button row on screen.
              The panel is centred in a `fixed inset-0` wrapper, so anything it
              overflows spills off *both* edges at once, and `#__next` is
              `height: 100dvh` - there is no page scroll to reach it with. At
              its natural 476px (384px stage + 16px of border + a 76px button
              row) it clipped 51px off each end of a 375px viewport, slicing
              both buttons in half.

              `dvh` rather than `vh` for the reason `globals.css` records: `vh`
              is the viewport with the mobile browser's chrome retracted, so it
              over-measures on exactly the devices this is for.
            */}
            <div className="relative flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border-8 border-gray-400 bg-white">
              {/*
                The stage keeps its full `h-96` and this wrapper scrolls
                instead, deliberately - shrinking it would be the tidier layout
                but it is the wrong trade here. `cropSize` is a flat
                `CROP_BOX_PX` (300px), so a stage shorter than that would draw
                the round crop box overflowing its own container. Holding the
                stage at 384px also leaves `mediaSize` - which react-easy-crop
                derives from this container under `objectFit="contain"` - the
                same value SCRUM-479's fill-zoom arithmetic was measured
                against.

                `min-h-0` is load-bearing: a flex item's default `min-height`
                is `auto`, which refuses to shrink below its content, so
                without it this wrapper would stay 384px tall and push the
                button row straight back off the screen.
              */}
              <div className="min-h-0 flex-1 overflow-y-auto">
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
              </div>
              {/*
                `shrink-0` so the row keeps its full height as the scroller
                above it gives way, rather than the two sharing the shortfall.
              */}
              <div className="flex w-full shrink-0 items-stretch justify-between p-4">
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
