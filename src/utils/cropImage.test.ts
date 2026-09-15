import { croppedCanvasSize, MAX_CROPPED_IMAGE_PX } from "./cropImage";

/**
 * The size arithmetic behind the profile-picture cropper.
 *
 * **This is the only part of `cropImage.ts` a test in this repository can
 * reach.** jsdom implements no canvas: `getContext("2d")` returns `null`, so
 * `getCroppedImg` rejects with "Failed to get canvas context" before it draws
 * anything, and `toBlob` does not exist at all. Whether the cropped avatar
 * *looks* right is therefore a question for a device, and the iOS blank-canvas
 * behaviour this cap exists to prevent cannot be reproduced here either - see
 * the PR for the manual pass.
 *
 * What is testable is the number that reaches `canvas.width`, and that is
 * exactly where this was silently wrong: the canvas used to be sized from the
 * crop rectangle directly, which react-easy-crop reports in the *source*
 * image's pixels rather than the output's.
 */

/**
 * The crop rectangle a 4032x3024 iPhone photo actually produces, which is the
 * case the ticket was filed for.
 *
 * Derived from react-easy-crop 6.2.3's own `computeCroppedArea`: with
 * `objectFit="contain"` the image lays out at 359x269.25 in the modal's
 * 359x384 cropper box, and the cropper opens at the zoom that just covers the
 * 300x300 crop box - `300/269.25`, or 1.1142. The box is then exactly 100% of
 * the displayed height and 75% of the width, so the rectangle is the full
 * 3024px height and `0.75 * 4032` of the width. With `aspect={1}` the library
 * squares it itself, so both sides are 3024 - not merely close to equal.
 *
 * **This was 3369x3369 before SCRUM-479**, when the cropper opened at a flat
 * `zoom: 1` and the crop box was 111% of the displayed image's height: the
 * rectangle overhung the photo by 173px top and bottom, and those bands
 * reached the encoded JPEG as opaque black. The framing changed, so this
 * number did; `croppedCanvasSize` itself is unchanged and still caps either
 * one at 512.
 */
const IPHONE_CROP = { width: 3024, height: 3024 };

/** The older iOS Safari total-canvas-area ceiling, past which it blanks. */
const IOS_CANVAS_AREA_CAP_PX = 5_000_000;

const megapixels = ({ width, height }: { width: number; height: number }) =>
  (width * height) / 1_000_000;

describe("croppedCanvasSize", () => {
  it("caps a camera-roll crop at the output size, not the source's", () => {
    expect(croppedCanvasSize(IPHONE_CROP)).toEqual({ width: 512, height: 512 });
  });

  it("brings that crop under the iOS canvas ceiling it used to exceed", () => {
    // The whole ticket in two assertions. Before: ~11.3MP, over the older-device
    // cap, where iOS hands back a blank canvas and `toBlob` still succeeds - so
    // the user uploads a blank avatar and nothing reports a failure.
    const before = IPHONE_CROP.width * IPHONE_CROP.height;
    expect(before).toBeGreaterThan(IOS_CANVAS_AREA_CAP_PX);

    const after = croppedCanvasSize(IPHONE_CROP);
    expect(after.width * after.height).toBeLessThan(IOS_CANVAS_AREA_CAP_PX);
    expect(megapixels(after)).toBeCloseTo(0.26, 2);
  });

  it("scales the area down by roughly 35x for that crop", () => {
    // Not a round number worth asserting precisely, but the order of magnitude
    // is the point: this is why the uploaded object gets materially smaller.
    //
    // It was ~43x when the crop rectangle was 3369x3369. SCRUM-479 made the
    // cropper open at a zoom that covers its crop box, so the rectangle is now
    // 3024x3024 - a smaller source for the same 512x512 output, hence a
    // smaller ratio. The saving this asserts is unaffected; there is simply
    // less black band to throw away.
    const after = croppedCanvasSize(IPHONE_CROP);
    const ratio =
      (IPHONE_CROP.width * IPHONE_CROP.height) / (after.width * after.height);
    expect(ratio).toBeGreaterThan(30);
  });

  describe("preserves aspect ratio rather than assuming square", () => {
    // `ProfilePicture` passes `aspect={1}` today, so every rectangle it sends
    // is square. These cover the case where that changes: a non-square crop
    // must come back scaled, never stretched to fill a square canvas.
    const cases: ReadonlyArray<{
      name: string;
      crop: { width: number; height: number };
      expected: { width: number; height: number };
    }> = [
      {
        name: "landscape 2:1",
        crop: { width: 1000, height: 500 },
        expected: { width: 512, height: 256 },
      },
      {
        name: "portrait 1:2",
        crop: { width: 500, height: 1000 },
        expected: { width: 256, height: 512 },
      },
      {
        name: "landscape 4:3",
        crop: { width: 4032, height: 3024 },
        expected: { width: 512, height: 384 },
      },
      {
        name: "square",
        crop: { width: 2000, height: 2000 },
        expected: { width: 512, height: 512 },
      },
    ];

    it.each(cases)("$name", ({ crop, expected }) => {
      expect(croppedCanvasSize(crop)).toEqual(expected);

      // The ratio survives the rounding, which is the claim that matters.
      const result = croppedCanvasSize(crop);
      expect(result.width / result.height).toBeCloseTo(
        crop.width / crop.height,
        2,
      );
    });
  });

  describe("never enlarges a crop that is already small enough", () => {
    // Upscaling would spend bytes to invent detail. A user who zooms far in
    // hands over a genuinely small rectangle, and it should pass through.
    it.each([
      { width: 300, height: 300 },
      { width: 120, height: 90 },
      { width: 1, height: 1 },
      { width: MAX_CROPPED_IMAGE_PX, height: MAX_CROPPED_IMAGE_PX },
    ])("leaves $width x $height alone", (crop) => {
      expect(croppedCanvasSize(crop)).toEqual(crop);
    });

    it("starts scaling one pixel past the cap", () => {
      const justOver = MAX_CROPPED_IMAGE_PX + 1;
      expect(croppedCanvasSize({ width: justOver, height: justOver })).toEqual({
        width: MAX_CROPPED_IMAGE_PX,
        height: MAX_CROPPED_IMAGE_PX,
      });
    });
  });

  describe("refuses to emit a zero dimension", () => {
    // `canvas.width` is an unsigned long: it coerces anything invalid to 0, and
    // a 0-wide canvas makes `toBlob` hand back a blank image *successfully* -
    // which is the exact silent-success mode this cap was added to remove. So
    // degenerate input collapses to 1x1: still wrong, but not plausibly blank.
    it.each([
      { name: "zero width", crop: { width: 0, height: 500 } },
      { name: "zero height", crop: { width: 500, height: 0 } },
      { name: "both zero", crop: { width: 0, height: 0 } },
      { name: "negative", crop: { width: -100, height: -100 } },
      { name: "NaN", crop: { width: Number.NaN, height: Number.NaN } },
      { name: "one side NaN", crop: { width: 500, height: Number.NaN } },
      {
        name: "Infinity",
        crop: { width: Number.POSITIVE_INFINITY, height: 500 },
      },
    ])("$name collapses to 1x1", ({ crop }) => {
      expect(croppedCanvasSize(crop)).toEqual({ width: 1, height: 1 });
    });

    it("rounds an extreme aspect ratio up to a pixel rather than down to none", () => {
      // 4000x1 scales to 512x0.128. Rounding alone would give height 0 and a
      // blank canvas, so the floor of 1 is load-bearing here, not decorative.
      expect(croppedCanvasSize({ width: 4000, height: 1 })).toEqual({
        width: 512,
        height: 1,
      });
    });
  });

  describe("honours an explicit cap", () => {
    it("scales to a smaller cap", () => {
      expect(croppedCanvasSize(IPHONE_CROP, 160)).toEqual({
        width: 160,
        height: 160,
      });
    });

    it("scales to a larger cap, still without upscaling past the source", () => {
      expect(croppedCanvasSize(IPHONE_CROP, 1024)).toEqual({
        width: 1024,
        height: 1024,
      });
      expect(croppedCanvasSize({ width: 200, height: 200 }, 1024)).toEqual({
        width: 200,
        height: 200,
      });
    });

    it("defaults to MAX_CROPPED_IMAGE_PX", () => {
      expect(croppedCanvasSize(IPHONE_CROP)).toEqual(
        croppedCanvasSize(IPHONE_CROP, MAX_CROPPED_IMAGE_PX),
      );
    });
  });

  it("keeps the cap generous enough for the rendered avatar sizes", () => {
    // 160px is the profile editor's `h-40 w-40`, 56px the conversation header.
    // A cap below a 2x 160px box would make the fix a regression in quality.
    expect(MAX_CROPPED_IMAGE_PX).toBeGreaterThanOrEqual(160 * 2);
  });
});
