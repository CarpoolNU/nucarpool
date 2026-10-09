import React, { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import { Dialog } from "@headlessui/react";
import Cropper, { Area, MediaSize } from "react-easy-crop";
import { AiOutlineUser } from "react-icons/ai";
import getCroppedImg from "../../utils/cropImage";
import { CROP_BOX_PX, minZoomToFill } from "../../utils/cropZoom";
import useProfileImage from "../../utils/useProfileImage";
import {
  PENDING_REMOVAL,
  PendingPicture,
  isPendingRemoval,
  pendingPictureFile,
} from "../../utils/profile/pendingPicture";
interface ProfilePictureProps {
  /**
   * The unsaved picture change, owned by the parent: a cropped file waiting to
   * be uploaded, the marker for a pending removal, or nothing.
   *
   * The preview below is *derived* from this rather than stored alongside it,
   * and that is the whole point of the prop. If the file lived only in the
   * parent while the preview URL lived only here, unmounting this component
   * - switching profile tabs, or stepping back and forward through onboarding -
   * would revoke the preview and leave the parent holding a file the user
   * cannot see, which a later Save would upload anyway. Deriving makes the two
   * agree by construction: there is one source of truth, and remounting
   * rebuilds the preview from it.
   *
   * One slot rather than a file beside a removal flag, for the reason
   * `pendingPicture.ts` records: the two are mutually exclusive, and a single
   * value makes that true by construction instead of by every handler
   * remembering to clear the other one.
   */
  pendingPicture: PendingPicture;
  onPendingPictureChange: (next: PendingPicture) => void;
}
const ProfilePicture = ({
  pendingPicture,
  onPendingPictureChange,
}: ProfilePictureProps) => {
  /**
   * The two shapes the rest of this component asks `pendingPicture` about.
   *
   * Narrowed once here rather than at each of the five places that branch on
   * it, so the preview effect, the avatar and the Remove button cannot end up
   * disagreeing about which state they are in.
   */
  const selectedFile = pendingPictureFile(pendingPicture);
  const removalPending = isPendingRemoval(pendingPicture);

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
   * those accumulate across a few selections is a real memory cost.
   *
   * A ref because the unmount cleanup below has to see the *current* URL: a
   * cleanup closing over state would revoke whatever was set when the effect
   * was created, which for an empty dependency list is `null` forever.
   *
   * The preview URL is deliberately not a second ref beside this one. It is
   * derived from `selectedFile` - see the effect below - so its lifetime is
   * the effect's rather than the component's, and nothing here has to
   * remember to revoke it.
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

  /**
   * The URL whose image failed to load, rather than a boolean.
   *
   * `ProfileAvatar` carries the same state for the same reason, and that
   * duplication is deliberate: this component needs the hook's result for
   * `hasStoredPicture` as well as for rendering, which is what keeps it from
   * simply using `ProfileAvatar` - see the note there.
   *
   * These are two different failures and only one of them is `imageLoadError`,
   * which is the *query* failing. A presigned URL resolves fine and then 404s at
   * the S3 origin when the object behind it is gone, and the owner's own page is
   * not exempt from that: `useInvalidateProfileImage` reaches one React Query
   * cache - the one in the tab that ran the mutation - so a second tab or a
   * second device holds a URL for a removed picture until it goes stale, which
   * with `refetchOnMount` and `refetchOnWindowFocus` both off is the full 15
   * minutes. An object that goes missing without this client's mutation running
   * at all - an out-of-band deletion, or the `NEXT_PUBLIC_ENV` change that
   * orphans every existing upload - is unbounded.
   *
   * Storing the URL makes the state self-correcting: after a re-upload the hook
   * hands back a new URL for the same user, the failure belongs to the old one,
   * and comparing them lets the new picture render instead of inheriting the
   * old one's fallback. A boolean would latch, on the one page the user came to
   * in order to fix this.
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailedToLoad =
    profileImageUrl !== null && failedUrl === profileImageUrl;

  /**
   * Whether the server holds a picture.
   *
   * Deliberately **not** narrowed by `imageFailedToLoad`. That flag says the
   * browser could not draw the picture; it says nothing about the row, which is
   * still set and still claims a picture. The two readers below both want the
   * server's answer rather than the browser's: `canRemove` would otherwise hide
   * the only control that clears a stale column, and `handleRemove` would send
   * `null` - saving nothing - for exactly the user who needs the removal to
   * reach the server. So a picture that fails to load draws the fallback icon
   * and still offers Remove.
   */
  const hasStoredPicture = !!profileImageUrl && !imageLoadError;

  /**
   * Whether anything the user could want removed is currently on screen.
   *
   * Deliberately not "does the user have a picture": a pending crop counts,
   * because discarding one is the other thing a user reaches for this control
   * to do, and a stored picture already marked for removal does not, because
   * there is nothing further to take away. Against the fallback icon the button
   * is absent rather than inert.
   *
   * Reads `selectedFile` rather than `croppedImageUrl`, which the effect above
   * sets a tick later: the parent's value is the one that decides what Save
   * will do, so this cannot show a button for a file the page has stopped
   * holding.
   */
  const canRemove = !!selectedFile || (!removalPending && hasStoredPicture);

  /**
   * The fallback, shared by the "nothing to show" branch and the pending
   * removal below it so the two cannot drift apart.
   */
  const fallbackAvatar = (
    <div className="flex h-40 w-40 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-400">
      <AiOutlineUser className="h-28 w-28 text-white" />
    </div>
  );

  /**
   * What Remove means depends on whether the server holds a picture, and this
   * is the only place that knows.
   *
   * With a stored picture, it is a deletion to be saved. Without one the user
   * is merely discarding a crop they have not uploaded yet, which returns them
   * to the state they started in - so the pending change is `null`, not a
   * removal. Marking that case for removal instead would arm the
   * unsaved-changes modal over a change that does not exist, and spend a
   * mutation on saving nothing.
   */
  const handleRemove = () => {
    onPendingPictureChange(hasStoredPicture ? PENDING_REMOVAL : null);
  };

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
    const input = event.target;
    const file = input.files?.[0];

    // Cleared on the way out, so the *next* pick of the same file is still a
    // change. A file input fires `change` on the value changing, not on the
    // dialog closing: leaving the chosen path in place meant that cancelling
    // the crop and re-picking the same photo - the common path, because the
    // reason to re-pick is usually disliking your own crop - fired nothing and
    // left the user tapping a button that did nothing at all.
    //
    // After reading `files`, and only after: assigning the value empties the
    // `files` list. `file` is a reference to the `File` object rather than into
    // the list, so it stays valid.
    input.value = "";

    if (!file) {
      onPendingPictureChange(null);
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

      onPendingPictureChange(file);
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
   * right one to measure. Measuring the source photo's natural pixels, or
   * falling back to a flat `1`, leaves a 4:3 photo shorter than the 300px box
   * and burns black bands into the saved JPEG.
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
      <Dialog
        open={showModal && !!imageSrc}
        onClose={handleCancel}
        className="relative z-50"
      >
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
          <Dialog.Panel className="relative flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border-8 border-gray-400 bg-white">
            {imageSrc && (
              <>
                {/*
                  The stage keeps its full `h-96` and this wrapper scrolls
                  instead, deliberately - shrinking it would be the tidier layout
                  but it is the wrong trade here. `cropSize` is a flat
                  `CROP_BOX_PX` (300px), so a stage shorter than that would draw
                  the round crop box overflowing its own container. Holding the
                  stage at 384px also leaves `mediaSize` - which react-easy-crop
                  derives from this container under `objectFit="contain"` - the
                  same value the fill-zoom arithmetic below was measured
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
                      // clamp and was half of the black-bands defect above. The
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
              </>
            )}
          </Dialog.Panel>
        </div>
      </Dialog>

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
        ) : /*
            Ahead of the stored picture, so a pending removal shows the user
            what saving will leave them with rather than the photo they have
            just asked to delete. Ahead of the loading branch too: once a
            removal is pending the stored URL is not worth waiting for, and
            holding the neutral placeholder until it resolved would only be a
            flicker on the way to this same icon.
          */
        removalPending ? (
          fallbackAvatar
        ) : isProfileImageLoading ? (
          <div className="h-40 w-40 flex-shrink-0 rounded-full bg-gray-400" />
        ) : profileImageUrl && !imageLoadError && !imageFailedToLoad ? (
          <div className="relative h-40 w-40 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
            <Image
              src={profileImageUrl}
              alt="Profile Picture"
              fill
              className="object-cover"
              // `next/image` forwards this to the underlying `<img>`'s error
              // handler, and re-assigns `src` on mount when it is set, so an
              // error that happened before hydration is not lost. The optimizer
              // answers 400 with no image body when the upstream object is
              // missing, which is what fires it.
              onError={() => setFailedUrl(profileImageUrl)}
            />
          </div>
        ) : (
          fallbackAvatar
        )}

        <div className="ml-4 flex flex-col items-start">
          {/*
            The two controls share a box width rather than each shrink-wrapping
            its own text. They are the same control in two states - the same
            padding, border, radius and type scale - so differing only by the
            11px between "Upload" and "Remove" in Montserrat reads as a
            misalignment rather than a distinction.

            A stretching column is what equalises them, deliberately in place of
            a fixed width: this nests inside the parent's `items-start`, so the
            wrapper is sized to fit its widest child, and the default
            `align-items: stretch` then gives both children exactly that width.
            No measured figure is written down, so nothing here has to be
            revisited when the copy, the type scale or the font changes.

            `gap-3` carries the spacing the Remove button used to hold as its
            own `mt-3`. With one child it contributes nothing, so the Upload
            button is unmoved when removal is not offered. The hidden input is
            `position: absolute` via `sr-only`, so it is out of flow and takes
            no gap and no stretch.
          */}
          <div className="ml-10 flex flex-col gap-3">
            {/* The input comes first in the DOM so the label can style itself
                from the input's focus state: a sibling variant only reaches
                *forward*, and the input is visually hidden, so moving it costs
                no layout. It stays inside this wrapper for that reason - the
                variant needs the two to be siblings. */}
            <input
              id="fileInput"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              // Visually hidden, NOT `display: none`. The class this replaced
              // compiled to `display: none`, which left the only keyboard path
              // to a profile picture nowhere: the visible control is a
              // `<label>`, which is not focusable, and a `display: none` input
              // is not either - so the upload was pointer-only on `/profile`
              // and on setup step 4.
              className="peer sr-only"
            />
            <label
              htmlFor="fileInput"
              // `text-center` because the label is now wider than its text. A
              // `<button>` centres its own content; a `<label>` does not, so
              // without this the two would be the same size with their labels
              // starting in different places.
              className="bg-northeastern-red font-montserrat peer-focus-visible:outline-northeastern-red cursor-pointer rounded-lg border border-black px-4 py-2 text-center text-xl text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 hover:bg-red-700"
            >
              Upload Profile Picture
            </label>
            {/*
              Rendered only when there is a picture on screen to remove, so this
              is never a control that does nothing: against the fallback icon,
              with nothing pending, removal has no meaning.

              A real `button`, and `type="button"` specifically. This sits inside
              the profile form, where the default `type="submit"` would save the
              whole profile on click, and would also make this the target of
              implicit submission on Enter.
            */}
            {canRemove && (
              <button
                type="button"
                onClick={handleRemove}
                className="font-montserrat focus-visible:outline-northeastern-red cursor-pointer rounded-lg border border-black bg-gray-300 px-4 py-2 text-center text-xl text-black hover:bg-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Remove Profile Picture
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default ProfilePicture;
