import { CROP_BOX_PX, minZoomToFill } from "./cropZoom";

/**
 * The zoom arithmetic behind the profile-picture cropper.
 *
 * **Why this is a pure module with its own test.** The bug it exists to fix
 * was invisible in every way CI can see: `onMediaLoaded` computed a zoom
 * factor from the source photo's *natural* pixels, but zoom scales the
 * *displayed* media, so the number was dimensionally wrong - and the result
 * was then overwritten with `1` outright for any image larger than 300px.
 * jsdom performs no layout and implements no canvas, so neither the framing
 * nor the black bands it produced can be asserted from a rendering test. The
 * arithmetic can, and that is where this was wrong, so it is separated out and
 * stated as a table here - the same split `cropImage.ts` uses for
 * `croppedCanvasSize`, and `sheetDetents.ts` for the same reason.
 *
 * The numbers below are not invented. They are the layout react-easy-crop
 * 6.2.3 actually produces, reproduced from its own `computeSizes` (the
 * `objectFit: "contain"` branch), and they match the measurements recorded on
 * SCRUM-479 against a real 4032x3024 photo in Chromium.
 */

/**
 * The cropper's box on an iPhone-width viewport: `h-96` is 384px tall, and a
 * 375px viewport inside the modal's `border-8` leaves 359px of width. This is
 * the container SCRUM-479 was measured against.
 */
const MOBILE_CONTAINER = { width: 359, height: 384 };

/** A 4032x3024 camera-roll photo - the case the ticket was filed for. */
const IPHONE_LANDSCAPE = { naturalWidth: 4032, naturalHeight: 3024 };

/** The same photo held portrait. */
const IPHONE_PORTRAIT = { naturalWidth: 3024, naturalHeight: 4032 };

/**
 * react-easy-crop's own `objectFit: "contain"` layout, reproduced.
 *
 * The library lays the media out with `max-width: 100%; max-height: 100%` and
 * reports the result as `mediaSize.width/height` - the numbers `minZoomToFill`
 * consumes. Reproducing the branch here is what lets the table below be stated
 * in real displayed pixels rather than asserted against a guess, and it is
 * test-only: production reads the size the library hands it.
 *
 * The `isMediaScaledDown` guard is load-bearing, not defensive. `max-width`
 * and `max-height` only ever shrink, so an image smaller than the container is
 * laid out at its natural size and the library reports `offsetWidth`/
 * `offsetHeight` instead of a fitted size. Omitting the guard models a 200x150
 * image as though it were blown up to fill 359x269, which is the one case
 * where the pre-fix algorithm's surviving `Math.min` branch looks correct.
 */
const containMediaSize = (
  {
    naturalWidth,
    naturalHeight,
  }: { naturalWidth: number; naturalHeight: number },
  container: { width: number; height: number },
) => {
  const isMediaScaledDown =
    naturalWidth > container.width || naturalHeight > container.height;

  if (!isMediaScaledDown) {
    return { width: naturalWidth, height: naturalHeight };
  }

  const mediaAspect = naturalWidth / naturalHeight;
  const containerAspect = container.width / container.height;

  return containerAspect > mediaAspect
    ? { width: container.height * mediaAspect, height: container.height }
    : { width: container.width, height: container.width / mediaAspect };
};

/**
 * Whether the media, scaled by `zoom`, covers the crop box on both axes.
 *
 * This is the whole point of the module. react-easy-crop's `computeCroppedArea`
 * derives the crop rectangle's origin as
 * `((mediaSize - cropSize / zoom) / 2 - crop) / mediaSize`, which is negative
 * on any axis where `mediaSize * zoom < cropSize` - and a negative origin is a
 * source rectangle hanging off the edge of the photo. `drawImage` leaves that
 * region transparent, and `toBlob("image/jpeg")` has no alpha channel to store
 * it in, so it composites onto black. Covered on both axes means the origin
 * cannot be negative, which means there are no bands.
 */
const coversCropBox = (
  media: { width: number; height: number },
  zoom: number,
  cropSize = { width: CROP_BOX_PX, height: CROP_BOX_PX },
) =>
  media.width * zoom >= cropSize.width - 1e-9 &&
  media.height * zoom >= cropSize.height - 1e-9;

describe("containMediaSize", () => {
  // react-easy-crop lays the media out with `max-width: 100%; max-height: 100%`
  // and reports the result as `mediaSize.width/height`. Reproducing it here is
  // what lets the zoom table below be stated in real displayed pixels.
  it("fits a landscape photo to the container's width", () => {
    expect(containMediaSize(IPHONE_LANDSCAPE, MOBILE_CONTAINER)).toEqual({
      width: 359,
      height: 269.25,
    });
  });

  it("fits a portrait photo to the container's height", () => {
    expect(containMediaSize(IPHONE_PORTRAIT, MOBILE_CONTAINER)).toEqual({
      width: 288,
      height: 384,
    });
  });

  it("fits a square photo to the shorter container side", () => {
    expect(
      containMediaSize(
        { naturalWidth: 3024, naturalHeight: 3024 },
        MOBILE_CONTAINER,
      ),
    ).toEqual({ width: 359, height: 359 });
  });
});

describe("minZoomToFill", () => {
  describe("covers the crop box for every photo shape", () => {
    // The invariant, stated against the displayed sizes the library computes.
    // Every one of these shapes failed it before SCRUM-479, because the zoom
    // was pinned to 1 regardless.
    const shapes: ReadonlyArray<{
      name: string;
      natural: { naturalWidth: number; naturalHeight: number };
    }> = [
      { name: "4032x3024 landscape", natural: IPHONE_LANDSCAPE },
      { name: "3024x4032 portrait", natural: IPHONE_PORTRAIT },
      {
        name: "3024x3024 square",
        natural: { naturalWidth: 3024, naturalHeight: 3024 },
      },
      {
        name: "extreme panorama",
        natural: { naturalWidth: 8000, naturalHeight: 1000 },
      },
      {
        name: "extreme portrait",
        natural: { naturalWidth: 1000, naturalHeight: 8000 },
      },
      {
        name: "small 200x150",
        natural: { naturalWidth: 200, naturalHeight: 150 },
      },
    ];

    it.each(shapes)("$name", ({ natural }) => {
      const media = containMediaSize(natural, MOBILE_CONTAINER);
      expect(coversCropBox(media, minZoomToFill(media))).toBe(true);
    });
  });

  describe("is the tightest zoom that does so", () => {
    // Not merely "large enough": a zoom larger than necessary would crop more
    // of the photo than the user asked for. Anything below the returned value
    // must fail the invariant.
    it.each([
      { name: "landscape", natural: IPHONE_LANDSCAPE },
      { name: "portrait", natural: IPHONE_PORTRAIT },
    ])("$name", ({ natural }) => {
      const media = containMediaSize(natural, MOBILE_CONTAINER);
      const zoom = minZoomToFill(media);

      expect(coversCropBox(media, zoom)).toBe(true);
      expect(coversCropBox(media, zoom * 0.999)).toBe(false);
    });
  });

  describe("the measured values", () => {
    it("zooms a landscape photo in to reach the crop box's height", () => {
      // 300 / 269.25. The long edge is what gets cropped, which is the
      // decision recorded in `cropZoom.ts`: fill the box, do not fit inside it.
      expect(
        minZoomToFill(containMediaSize(IPHONE_LANDSCAPE, MOBILE_CONTAINER)),
      ).toBeCloseTo(1.1142, 4);
    });

    it("zooms a portrait photo in to reach the crop box's width", () => {
      // 300 / 288. The ticket predicted portrait was unaffected; it is not.
      // At this container the displayed width is 288, under the 300px box, so
      // the pre-fix zoom of 1 left bands down the left and right instead.
      expect(
        minZoomToFill(containMediaSize(IPHONE_PORTRAIT, MOBILE_CONTAINER)),
      ).toBeCloseTo(1.0417, 4);
    });

    it("zooms a square photo out, so the whole of it fills the box", () => {
      // 300 / 359, below 1. Nothing privileges 1: it is just the contain-fit
      // layout's own scale. Pinning the minimum there used to crop a square
      // photo's edges away for no reason.
      expect(
        minZoomToFill(
          containMediaSize(
            { naturalWidth: 3024, naturalHeight: 3024 },
            MOBILE_CONTAINER,
          ),
        ),
      ).toBeCloseTo(0.8357, 4);
    });

    it("zooms a small image up rather than leaving it short of the box", () => {
      // An image smaller than the container renders at its natural size, so
      // 150px of height has to become 300. The result is soft, and that is the
      // right trade for an avatar: `croppedCanvasSize` will not enlarge the
      // encoded output past the source, so this costs sharpness, not bytes.
      expect(minZoomToFill({ width: 200, height: 150 })).toBeCloseTo(2, 10);
    });
  });

  describe("rejects the fit-inside reading of the same numbers", () => {
    /**
     * The pre-SCRUM-479 algorithm, kept here as a control.
     *
     * Two faults, either one sufficient: it measured the *natural* pixels
     * where zoom scales the displayed ones, and it took `Math.min` - the zoom
     * at which the whole image fits *inside* the box, leaving gaps - where
     * covering the box needs `Math.max`. The `= 1` branch then discarded even
     * that for any image over 300px, which is every photograph.
     *
     * This test is what makes the suite honest: it fails if `minZoomToFill`
     * ever reverts to either reading.
     */
    const previousMinZoom = ({
      naturalWidth,
      naturalHeight,
    }: {
      naturalWidth: number;
      naturalHeight: number;
    }) => {
      const widthRatio = CROP_BOX_PX / naturalWidth;
      const heightRatio = CROP_BOX_PX / naturalHeight;
      let newMinZoom = Math.min(widthRatio, heightRatio);
      if (widthRatio < 1 || heightRatio < 1) newMinZoom = 1;
      return newMinZoom;
    };

    it.each([
      { name: "landscape", natural: IPHONE_LANDSCAPE },
      { name: "portrait", natural: IPHONE_PORTRAIT },
      {
        name: "small 200x150",
        natural: { naturalWidth: 200, naturalHeight: 150 },
      },
    ])("$name left the crop box uncovered", ({ natural }) => {
      const media = containMediaSize(natural, MOBILE_CONTAINER);

      expect(coversCropBox(media, previousMinZoom(natural))).toBe(false);
      expect(coversCropBox(media, minZoomToFill(media))).toBe(true);
    });
  });

  describe("refuses to emit a zoom that cannot be used", () => {
    // A zero or non-finite media size would otherwise produce Infinity or NaN
    // and reach the `zoom` prop, where react-easy-crop clamps it against
    // `minZoom` and `maxZoom` - NaN survives `clamp`, and a NaN transform
    // silently renders nothing. 1 is the library's own default and is merely
    // wrong rather than broken.
    it.each([
      { name: "zero width", media: { width: 0, height: 269 } },
      { name: "zero height", media: { width: 359, height: 0 } },
      { name: "both zero", media: { width: 0, height: 0 } },
      { name: "negative", media: { width: -359, height: -269 } },
      { name: "NaN", media: { width: Number.NaN, height: Number.NaN } },
      { name: "one side NaN", media: { width: 359, height: Number.NaN } },
      {
        name: "Infinity",
        media: { width: Number.POSITIVE_INFINITY, height: 269 },
      },
    ])("$name falls back to 1", ({ media }) => {
      expect(minZoomToFill(media)).toBe(1);
    });
  });

  it("honours an explicit crop box", () => {
    // `CROP_BOX_PX` is the default rather than a constant baked into the
    // arithmetic, so a future non-square or differently sized box stays
    // correct instead of silently reverting to bands.
    expect(
      minZoomToFill({ width: 400, height: 200 }, { width: 200, height: 200 }),
    ).toBeCloseTo(1, 10);

    expect(
      minZoomToFill({ width: 400, height: 200 }, { width: 400, height: 100 }),
    ).toBeCloseTo(1, 10);
  });
});
