/**
 * That the cropper opens at a zoom which covers the crop box, and never tells
 * react-easy-crop to let the crop rectangle leave the photo.
 *
 * SCRUM-479: a landscape camera-roll photo accepted at the default framing
 * produced an avatar with opaque black bands top and bottom. `onMediaLoaded`
 * pinned `minZoom` to `1` for any image over 300px - every photograph - so the
 * 300x300 crop box was taller than the displayed image, and
 * `restrictPosition={false}` allowed the overshoot instead of clamping it. The
 * uncovered region reached `drawImage` as transparent and `toBlob("image/jpeg")`
 * composited it onto black.
 *
 * **What this file can and cannot see.** jsdom performs no layout, so a real
 * `Cropper` here would measure a 0x0 container and report a `mediaSize` of
 * zeroes - the callback under test would run on numbers that never occur in a
 * browser. It implements no canvas either, so the bands themselves are not
 * observable at all; they were measured in Chromium and are recorded on the
 * ticket. What is left, and what actually broke, is the wiring: which numbers
 * this component computes from the media size the library hands it, and which
 * props it hands back. So `react-easy-crop` is replaced by a component that
 * records its props and renders nothing, and the arithmetic those props carry
 * is verified independently in `utils/cropZoom.test.ts`.
 *
 * Measured against the pre-fix component, every assertion below fails: the
 * zoom came back as 1 and `restrictPosition` as `false`.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Point } from "react-easy-crop";
import ProfilePicture from "./ProfilePicture";
import { CROP_BOX_PX, minZoomToFill } from "../../utils/cropZoom";

/** The props the mocked `Cropper` last rendered with. */
type CropperProps = {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  crop: Point;
  cropSize?: { width: number; height: number };
  restrictPosition?: boolean;
  objectFit?: string;
  onCropChange: (location: Point) => void;
  onMediaLoaded?: (mediaSize: {
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  }) => void;
};

let cropperProps: CropperProps | null = null;

jest.mock("react-easy-crop", () => ({
  __esModule: true,
  default: (props: CropperProps) => {
    cropperProps = props;
    return <div data-testid="cropper" />;
  },
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

/**
 * The cropper's box on an iPhone-width viewport, and the media size
 * react-easy-crop lays a 4032x3024 photo out at inside it: `h-96` is 384px
 * tall and a 375px viewport inside the modal's `border-8` leaves 359px, so a
 * 4:3 photo contains to 359x269.25. These are the numbers SCRUM-479 was
 * measured against, and `mediaSize` is the library's own type - it carries the
 * displayed pair *and* the natural pair, which is how the pre-fix code came to
 * use the wrong one.
 */
const LANDSCAPE_MEDIA = {
  width: 359,
  height: 269.25,
  naturalWidth: 4032,
  naturalHeight: 3024,
};

/** The same photo held portrait: it contains to 288x384 in the same box. */
const PORTRAIT_MEDIA = {
  width: 288,
  height: 384,
  naturalWidth: 3024,
  naturalHeight: 4032,
};

beforeEach(() => {
  cropperProps = null;

  // jsdom implements neither, and `handleFileChange` calls `createObjectURL`
  // before the cropper can mount. Counting revocations is not this file's
  // question - `ProfilePicture`'s object-URL lifecycle is its own concern - so
  // these are the minimum that lets the modal open.
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: jest.fn(() => "blob:mock-source"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: jest.fn(),
  });
});

/** Opens the cropper the way a user does, and returns the mocked Cropper's props. */
const openCropperWith = (media: typeof LANDSCAPE_MEDIA) => {
  render(<ProfilePicture onFileSelected={jest.fn()} />);

  const input = screen.getByLabelText("Upload Profile Picture");
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });

  if (!cropperProps) throw new Error("the cropper did not mount");

  // The library calls this once the <img> has decoded, *after* it has computed
  // the layout - so the displayed size is already available to the callback.
  act(() => cropperProps!.onMediaLoaded?.(media));

  if (!cropperProps) throw new Error("the cropper unmounted");
  return cropperProps;
};

describe("ProfilePicture cropper framing", () => {
  describe("opens at a zoom that covers the crop box", () => {
    it.each([
      { name: "a landscape photo", media: LANDSCAPE_MEDIA },
      { name: "a portrait photo", media: PORTRAIT_MEDIA },
    ])("$name", ({ media }) => {
      const props = openCropperWith(media);

      // The invariant the bands come from: below this, the crop rectangle's
      // origin goes negative and part of it hangs off the photo.
      expect(props.zoom * media.width).toBeGreaterThanOrEqual(CROP_BOX_PX);
      expect(props.zoom * media.height).toBeGreaterThanOrEqual(CROP_BOX_PX);
    });
  });

  it("uses the displayed media size, not the source photo's pixels", () => {
    const props = openCropperWith(LANDSCAPE_MEDIA);

    // 300/269.25. Computing this from `naturalHeight` instead gives 0.099,
    // and the pre-fix code then threw it away for a flat 1 - which is what
    // this asserts is gone. Both wrong answers are far from this one.
    expect(props.zoom).toBeCloseTo(minZoomToFill(LANDSCAPE_MEDIA), 10);
    expect(props.zoom).toBeCloseTo(1.1142, 4);
  });

  it("lets the user zoom no further out than that", () => {
    const props = openCropperWith(LANDSCAPE_MEDIA);

    // react-easy-crop clamps every zoom change to `[minZoom, maxZoom]`, so
    // this is what stops the user reintroducing the bands by pinching out.
    expect(props.minZoom).toBeCloseTo(props.zoom, 10);
    expect(props.maxZoom).toBeGreaterThan(props.minZoom);
  });

  it("never opts out of react-easy-crop's position clamping", () => {
    const props = openCropperWith(LANDSCAPE_MEDIA);

    // `restrictPosition={false}` swaps the library's `limitArea` clamp for a
    // no-op, which is what let `croppedAreaPixels.y` come back negative.
    // Absent means the library's default of `true`.
    expect(props.restrictPosition).not.toBe(false);
  });

  it("passes the crop box it computed the zoom from", () => {
    // A box sized from one number and a zoom computed from another is the
    // mismatch the ticket is about, so both come from `CROP_BOX_PX`.
    expect(openCropperWith(LANDSCAPE_MEDIA).cropSize).toEqual({
      width: CROP_BOX_PX,
      height: CROP_BOX_PX,
    });
  });

  it("stores the position react-easy-crop asks for, without re-bounding it", () => {
    const props = openCropperWith(LANDSCAPE_MEDIA);

    // The component used to apply its own bound on top of the library's -
    // `±(zoomIncrease * 150 + 150)`, which at the opening zoom permits moving
    // the image halfway out of the crop box. With `restrictPosition` on, the
    // library has already clamped this value against the real media size
    // before calling back, so a second, looser bound can only fight it.
    act(() => props.onCropChange({ x: 1000, y: -1000 }));

    expect(cropperProps!.crop).toEqual({ x: 1000, y: -1000 });
  });
});
