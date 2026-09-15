/**
 * The side, in CSS pixels, of the profile-picture cropper's crop box.
 *
 * `ProfilePicture` hands this to react-easy-crop as an explicit `cropSize` and
 * uses it to compute the cropper's opening zoom, so the two have to agree: a
 * box sized from one number and a zoom computed from another is exactly the
 * mismatch SCRUM-479 was filed for. One constant, imported by both.
 */
export const CROP_BOX_PX = 300;

/**
 * The smallest zoom at which the displayed media still covers the whole crop
 * box - so the crop the user takes is entirely photograph, with no uncovered
 * edge.
 *
 * **The intent this implements is "fill", not "fit".** Those are opposite
 * choices and the code used to claim one while doing neither, so it is stated
 * here once: the crop box is always fully covered, and the photo's long edge
 * is cropped to achieve that. Filling is the conventional behaviour for an
 * avatar - the box is round (`cropShape="round"`) and the output is encoded as
 * JPEG, which has no transparency - and fitting would mean deciding what
 * colour to letterbox the remainder with. The user frames the crop by dragging
 * along the long edge and by zooming in; they cannot zoom out far enough to
 * include the whole of a non-square photo, which is the deliberate cost.
 *
 * **Why the argument is the displayed size, not the natural one.** `zoom`
 * multiplies the size react-easy-crop lays the media out at - `mediaSize.width`
 * and `mediaSize.height`, which for `objectFit="contain"` are derived from the
 * container - not the source photo's pixel dimensions. The previous
 * implementation divided the crop box by `naturalWidth`/`naturalHeight`, which
 * is a ratio between two unrelated coordinate spaces and had no useful meaning
 * at any image size; it then discarded the result and used `1` for any image
 * larger than the box, which is every photograph. `MediaSize` carries both
 * pairs, so the mistake costs a compiler nothing to make.
 *
 * At the returned zoom the crop rectangle's origin is exactly 0 on the
 * constrained axis. Below it the origin goes negative - react-easy-crop
 * computes it as `(mediaSize - cropSize / zoom) / 2`, which is signed - and a
 * negative origin is a source rectangle hanging off the edge of the photo.
 * `drawImage` leaves that part of the destination transparent and
 * `toBlob("image/jpeg")` cannot store transparency, so it composites onto
 * black: the bars this exists to prevent.
 *
 * @param mediaSize the media's *displayed* size, as react-easy-crop reports it
 * @param cropSize the crop box, defaulting to the square `ProfilePicture` uses
 */
export function minZoomToFill(
  mediaSize: { width: number; height: number },
  cropSize: { width: number; height: number } = {
    width: CROP_BOX_PX,
    height: CROP_BOX_PX,
  },
): number {
  const sides = [
    mediaSize.width,
    mediaSize.height,
    cropSize.width,
    cropSize.height,
  ];

  // A zero, negative or non-finite side yields Infinity or NaN, and this value
  // is handed straight to the `zoom` prop. react-easy-crop clamps it with
  // `Math.min(Math.max(...))`, which NaN passes through unchanged, and a NaN
  // CSS transform renders nothing at all - a blank cropper with no error. The
  // library's own default is 1, so falling back to it is merely the wrong
  // framing rather than a broken one.
  if (!sides.every((side) => Number.isFinite(side) && side > 0)) {
    return 1;
  }

  // `max`, because the box must be covered on *both* axes: the tighter
  // constraint wins. `min` is the fit-inside reading, and it is what used to
  // be here.
  return Math.max(
    cropSize.width / mediaSize.width,
    cropSize.height / mediaSize.height,
  );
}
