import type { Area } from "react-easy-crop";

/**
 * The longest side, in pixels, a cropped avatar is encoded at.
 *
 * The avatar is rendered at 160px in the profile editor and 56px in the
 * conversation header, so 512 is already generous: it covers a retina 160px
 * box and leaves room for a larger treatment later without a re-upload.
 *
 * The number that matters is the one this replaces. The crop rectangle
 * react-easy-crop reports is measured in the *source* image's pixels, so a
 * 4032x3024 camera-roll photo cropped square at `zoom: 1` arrives here as
 * 3369x3369 - an 11.3 megapixel canvas, roughly 45MB of RGBA, to produce a
 * 56px avatar. iOS Safari caps total canvas area (around 5MP on older
 * devices, ~16.7MP on newer) and **past the cap it yields a blank canvas
 * rather than an error**: `toBlob` succeeds, `getCroppedImg` reports success,
 * and the user uploads a blank avatar with nothing having failed. 512x512 is
 * 0.26MP, under every such cap by more than an order of magnitude.
 */
export const MAX_CROPPED_IMAGE_PX = 512;

/**
 * The canvas size to encode a crop rectangle at: the rectangle scaled to fit
 * within `maxPx` on its longest side, never enlarged.
 *
 * Pure, and exported, because it is the only half of this module a test in
 * this repository can reach. jsdom implements no canvas - `getContext("2d")`
 * returns `null` and `toBlob` does not exist - so `getCroppedImg` itself is
 * observable only on a device. The arithmetic is where this can be silently
 * wrong, so it is separated out and stated as a table in `cropImage.test.ts`,
 * the same split `sheetDetents.ts` and `viewRoutePlan.ts` already use for the
 * same reason.
 *
 * Aspect ratio is preserved rather than assumed square. `ProfilePicture`
 * passes `aspect={1}` and react-easy-crop squares the rectangle itself, so
 * both sides are equal in current usage - but that is the caller's choice,
 * not something this function should bake in and silently stretch if it ever
 * changes.
 *
 * A crop already smaller than the cap is left alone: upscaling would add
 * bytes and no detail.
 */
export function croppedCanvasSize(
  croppedAreaPixels: Pick<Area, "width" | "height">,
  maxPx: number = MAX_CROPPED_IMAGE_PX,
): { width: number; height: number } {
  const { width, height } = croppedAreaPixels;

  // A degenerate rectangle - zero, negative or non-finite - would otherwise
  // reach `canvas.width`, which coerces it to 0 and makes `toBlob` hand back a
  // blank 0x0 image: the same silent-success failure the cap exists to remove.
  // 1x1 is not useful either, but it is small, cheap and obviously wrong
  // rather than plausibly blank.
  if (![width, height].every((side) => Number.isFinite(side) && side > 0)) {
    return { width: 1, height: 1 };
  }

  const scale = Math.min(1, maxPx / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * `Area` is react-easy-crop's own type for the crop rectangle, rather than a
 * local shape or `any`. It is the contract this function shares with the
 * library, so borrowing it means a future major that reshapes the crop data
 * fails `tsc` here instead of at runtime - nothing tests this function, and
 * the only symptom would be a silently wrong avatar.
 */
export default function getCroppedImg(
  imageSrc: string,
  croppedAreaPixels: Area,
) {
  return new Promise<{ file: File; url: string }>((resolve, reject) => {
    const image = new Image();
    image.src = imageSrc;
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return reject(new Error("Failed to get canvas context"));
      }

      const output = croppedCanvasSize(croppedAreaPixels);

      canvas.width = output.width;
      canvas.height = output.height;

      // A camera-roll crop is downscaled about 6.6x in this single `drawImage`
      // step, and the default filter samples too few source pixels for that to
      // read cleanly. Chromium, WebKit and Gecko all honour this; where it is
      // unsupported the assignment is ignored rather than throwing.
      ctx.imageSmoothingQuality = "high";

      // The source rectangle stays exactly what the user framed, in the source
      // image's own pixels - only the destination shrinks, so the output is
      // the crop they chose rather than a re-centred or stretched one.
      //
      // That rectangle now always lies inside the image. `ProfilePicture` used
      // to pass `restrictPosition={false}` and open at a zoom too small to
      // cover its own crop box, so a landscape photo cropped square arrived
      // here with a negative `y`: `drawImage` left that band of the
      // destination transparent, and JPEG has no alpha channel to store it in,
      // so it composited onto black. SCRUM-479 fixed both halves at the
      // source - see `cropZoom.ts`. Nothing here depends on that having
      // happened, because `drawImage` clips the source and the destination in
      // the same proportion either way, which is what keeps the framing
      // identical to the cropper's preview at any output size.
      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        output.width,
        output.height,
      );

      canvas.toBlob(
        (blob) => {
          if (blob) {
            const file = new File([blob], "cropped-image.jpeg", {
              type: "image/jpeg",
            });
            const url = URL.createObjectURL(blob);
            resolve({ file, url });
          } else {
            reject(new Error("Canvas is empty"));
          }
        },
        "image/jpeg",
        0.7,
      );
    };

    image.onerror = () => {
      reject(new Error("Failed to load image"));
    };
  });
}
