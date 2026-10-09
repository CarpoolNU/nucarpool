/**
 * `ProfilePicture`, and the four things about it that have been broken.
 *
 * These were four sibling files - `cropZoom`, `dialog`, `modalHeight` and
 * `pendingPreview` - one per ticket that touched the component. All four opened
 * with the same two `jest.mock` blocks and the same jsdom object-URL shim, so
 * the split cost four copies of the setup and bought nothing; the mandatory
 * splits this suite does have are recorded in `CLAUDE.md` and none of them
 * applied here. The four concerns survive as the four `describe` blocks below,
 * each keeping its own rationale and its own opener, because the openers differ
 * in what they return rather than in what they do.
 *
 * **The two mocks the merge had to reconcile**, both resolved by taking the
 * wider of the two forms rather than by weakening either:
 *
 * - `react-easy-crop` was replaced by a props-recording component in
 *   `cropZoom` and by an inert one in the other three. The recorder renders the
 *   same `data-testid="cropper"` div, so it is a superset: the three blocks
 *   that only locate the element are indifferent to the recording.
 * - `URL.createObjectURL` returned a constant `"blob:mock-source"` in three
 *   files and distinct, tracked URLs in `pendingPreview`. No assertion anywhere
 *   read the constant - it existed only to let the modal open - so the tracking
 *   form serves all four, and `beforeEach` clears its ledgers per test.
 *
 * **What this file can and cannot see, across all four blocks.** jsdom performs
 * no layout and resolves no media query: every rectangle here is zero and
 * `max-height` is never applied to anything. It implements no canvas either, so
 * `getCroppedImg` - and therefore `handleCrop` - is unreachable, which is why
 * the cropped file arrives as a prop rather than from cropping. The geometry
 * and the black bands were measured in Chromium against the compiled stylesheet
 * and are recorded on their tickets. What is left, and what actually broke each
 * time, is the wiring: which numbers the component computes, which props it
 * hands back, and which element carries which class.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Area, Point } from "react-easy-crop";
import ProfilePicture, { CROP_FAILURE_MESSAGE } from "./ProfilePicture";
import { CROP_BOX_PX, minZoomToFill } from "../../utils/cropZoom";
import { PENDING_REMOVAL } from "../../utils/profile/pendingPicture";
import { profileImageSpies } from "../../testing/profileImageStub";

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
  // The crop rectangle, in the *source image's* pixels. `handleCrop` refuses
  // to run without one, so the failure block below has to supply it the way a
  // laid-out cropper would.
  onCropComplete?: (
    croppedAreaPercentage: Area,
    croppedAreaPixels: Area,
  ) => void;
  onMediaLoaded?: (mediaSize: {
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  }) => void;
};

let cropperProps: CropperProps | null = null;

// The recording form, which the framing block below reads and the other three
// blocks ignore. It renders exactly what the inert version did.
jest.mock("react-easy-crop", () => ({
  __esModule: true,
  default: (props: CropperProps) => {
    cropperProps = props;
    return <div data-testid="cropper" />;
  },
}));

/**
 * The canvas crop, which jsdom cannot run.
 *
 * `getCroppedImg` builds a canvas, draws to it and calls `toBlob`, none of
 * which jsdom implements - so the only way to reach `handleCrop` at all is to
 * replace it. That is a limitation rather than a shortcut: the arithmetic the
 * real function does is covered directly in `utils/cropImage.test.ts`, and
 * what is left here is the branch the component owns, which is what it does
 * with a rejection.
 *
 * Mocked for the whole file rather than inside one block, because `jest.mock`
 * is hoisted to module scope regardless of where it is written. The other
 * blocks are unaffected: none of them clicks `Crop Image`, so none of them
 * calls this.
 *
 * The factory forwards to a `jest.fn` declared above rather than being one,
 * so that each test can set its own outcome. Reading `getCroppedImgMock`
 * *inside* the arrow defers the lookup until call time, which is what keeps
 * the hoisted factory from reading an uninitialised binding.
 */
const getCroppedImgMock = jest.fn();

jest.mock("../../utils/cropImage", () => ({
  __esModule: true,
  default: (...args: unknown[]) => getCroppedImgMock(...args),
}));

/**
 * No stored picture, so the only avatar that can appear is the pending one.
 * Stubbed as a shape rather than driven through a tRPC provider, the same
 * treatment `UserSection.test.tsx` gives it.
 */
jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

let createdUrls: string[] = [];
let revokedUrls: string[] = [];

/** The object URLs handed out and not yet released. */
const liveUrls = () => createdUrls.filter((url) => !revokedUrls.includes(url));

beforeEach(() => {
  // `mockReturnValue` persists across tests, so a block that installs a
  // stored picture would otherwise leak it into every test after it -
  // including the controls that assert the button is absent.
  profileImageSpies().useProfileImage.mockReturnValue({
    profileImageUrl: null,
    isLoading: false,
    imageLoadError: false,
  });
  cropperProps = null;
  createdUrls = [];
  revokedUrls = [];
  getCroppedImgMock.mockReset();

  // jsdom implements neither half of the object-URL API, and
  // `handleFileChange` calls `createObjectURL` before the cropper can mount.
  // Each call returns a distinct URL so that a rebuilt preview is
  // distinguishable from a retained one - the whole question in the last block
  // is whether the component derives a fresh URL on mount or depends on one it
  // stored earlier. The other three blocks only need the calls not to throw.
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: jest.fn(() => {
      const url = `blob:cropped-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: jest.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
});

/**
 * That the cropper opens at a zoom which covers the crop box, and never tells
 * react-easy-crop to let the crop rectangle leave the photo.
 *
 * A landscape camera-roll photo accepted at the default framing produced an
 * avatar with opaque black bands top and bottom. `onMediaLoaded`
 * pinned `minZoom` to `1` for any image over 300px - every photograph - so the
 * 300x300 crop box was taller than the displayed image, and
 * `restrictPosition={false}` allowed the overshoot instead of clamping it. The
 * uncovered region reached `drawImage` as transparent and `toBlob("image/jpeg")`
 * composited it onto black.
 *
 * A real `Cropper` here would measure a 0x0 container and report a `mediaSize`
 * of zeroes - the callback under test would run on numbers that never occur in
 * a browser - so the media size is supplied directly, and the arithmetic those
 * props carry is verified independently in `utils/cropZoom.test.ts`.
 *
 * Measured against the pre-fix component, every assertion below fails: the
 * zoom came back as 1 and `restrictPosition` as `false`.
 */
describe("ProfilePicture cropper framing", () => {
  /**
   * The cropper's box on an iPhone-width viewport, and the media size
   * react-easy-crop lays a 4032x3024 photo out at inside it: `h-96` is 384px
   * tall and a 375px viewport inside the modal's `border-8` leaves 359px, so a
   * 4:3 photo contains to 359x269.25. These are the numbers the fix above was
   * measured against, and `mediaSize` is the library's own type - it carries
   * the displayed pair *and* the natural pair, which is how the pre-fix code
   * came to use the wrong one.
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

  /** Opens the cropper the way a user does, and returns the mocked Cropper's props. */
  const openCropperWith = (media: typeof LANDSCAPE_MEDIA) => {
    // `selectedFile` is the parent's *pending* picture, which is null until a
    // crop is confirmed - and this block never confirms one, it only opens the
    // cropper. So null is the state every assertion below runs against.
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    const input = screen.getByLabelText("Upload Profile Picture");
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    if (!cropperProps) throw new Error("the cropper did not mount");

    // The library calls this once the <img> has decoded, *after* it has
    // computed the layout - so the displayed size is already available to the
    // callback.
    act(() => cropperProps!.onMediaLoaded?.(media));

    if (!cropperProps) throw new Error("the cropper unmounted");
    return cropperProps;
  };

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
    // A box sized from one number and a zoom computed from another is a
    // mismatch, so both come from `CROP_BOX_PX`.
    expect(openCropperWith(LANDSCAPE_MEDIA).cropSize).toEqual({
      width: CROP_BOX_PX,
      height: CROP_BOX_PX,
    });
  });

  it("stores the position react-easy-crop asks for, without re-bounding it", () => {
    const props = openCropperWith(LANDSCAPE_MEDIA);

    // The component must not apply its own bound on top of the library's. A
    // bound of `±(zoomIncrease * 150 + 150)` permits moving the image halfway
    // out of the crop box at the opening zoom, and with `restrictPosition` on
    // the library has already clamped this value against the real media size
    // before calling back, so a second, looser bound can only fight it.
    act(() => props.onCropChange({ x: 1000, y: -1000 }));

    expect(cropperProps!.crop).toEqual({ x: 1000, y: -1000 });
  });
});

/**
 * The crop dialog's accessibility contract.
 *
 * This was a `createPortal` into `document.body` with no `role`, no focus
 * trap and no Escape handling - the sole route to setting a profile picture,
 * reachable only by tabbing through the entire rest of the page first. It is
 * now a Headless UI `Dialog`, which supplies all three.
 *
 * The positive `getByRole("dialog")` query runs before any assertion about
 * the page behind it: a negative assertion alone would pass vacuously if the
 * dialog itself failed to render.
 *
 * What this block cannot see: with no layout, containment of the focus trap -
 * whether Tab can actually escape to the page behind - is only partially
 * testable here. Real verification takes a browser; the existing Chromium
 * measurement harness is where that would go.
 */
describe("the crop dialog", () => {
  /**
   * Opens the cropper the way a user does: picking a file from the input,
   * which - as the browser's own native file picker does - leaves focus on the
   * input itself. That is what makes it the control the dialog must hand focus
   * back to on close.
   *
   * Headless UI moves focus into the panel asynchronously once the dialog
   * mounts, so opening has to be awaited inside `act` for that to settle before
   * an assertion runs.
   */
  const openCropper = async () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    const input: HTMLElement = screen.getByLabelText("Upload Profile Picture");
    input.focus();
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    return input;
  };

  it("exposes itself as a modal dialog once a file is picked", async () => {
    await openCropper();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders no dialog before a file is picked", () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape, the same as Cancel", async () => {
    await openCropper();
    expect(screen.getByTestId("cropper")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByTestId("cropper")).not.toBeInTheDocument();
  });

  it("returns focus to the file input once it closes", async () => {
    const input = await openCropper();
    expect(input).not.toHaveFocus();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(input).toHaveFocus();
  });
});

/**
 * That a crop which fails says so, in a place the user can actually find it.
 *
 * `handleCrop` is the only way out of the dialog that keeps the photo, and its
 * failure branch was `console.error` alone. Everything observable stayed as it
 * was - the dialog open, the photo on the stage, the parent told nothing - so a
 * user whose file the browser cannot decode tapped `Crop Image` and watched
 * nothing happen, with no reason given and no retry that could ever work.
 *
 * Two causes reach that branch and they are indistinguishable from here:
 * `image.onerror` for a file the browser cannot decode - HEIC and HEIF from an
 * Android camera roll being the realistic case, since `accept="image/*"` admits
 * them and only Safari decodes them - and a null `toBlob`, the mobile-memory
 * failure `MAX_CROPPED_IMAGE_PX` makes rare rather than impossible. One message
 * covers both, so the rejection below stands in for either.
 *
 * **Why the message is inline and not a toast.** The toast was the obvious
 * choice - it is what the save handlers use, and `_app` already mounts a
 * container - and it is the wrong one here, for a reason that is measurable
 * rather than aesthetic. Headless UI's `Dialog` marks the rest of the
 * application `aria-hidden` while it is open, and `_app` renders
 * `ToastContainer` as a sibling of the page inside that subtree. So a toast
 * raised from this handler paints on top of the backdrop and is still outside
 * the accessibility tree: a screen reader is never told, and the toast's own
 * alert role is suppressed along with it. Verified in jsdom by walking the
 * toast container's ancestors with the cropper open. "puts the message inside
 * the dialog" pins the conclusion, by asserting the message is a *descendant*
 * of the dialog rather than merely present somewhere in the document - which a
 * toast would satisfy just as well.
 *
 * Measured against the pre-fix component - the `catch` restored to
 * `console.error` alone - five of these nine fail. The other four pass either
 * way, and each does so deliberately rather than by accident: two pin
 * behaviour this change had to *leave alone* (the log, and the whole
 * successful path), and two pin the half of the old behaviour that was already
 * correct, which is that a failed crop tells the parent nothing and does not
 * close the dialog underneath the user. Those four are regression guards, and
 * are what lets the other five be read as describing a change rather than a
 * rewrite.
 *
 * The two that assert the message is *gone* carry a control asserting it was
 * there first, because without one they are satisfied by a component that
 * never shows a message at all - which is precisely the component this
 * replaces.
 */
describe("when the crop itself fails", () => {
  /** The cropped JPEG a successful `getCroppedImg` resolves with. */
  const croppedFile = new File(["cropped"], "cropped-image.jpeg", {
    type: "image/jpeg",
  });

  /**
   * Silenced rather than left to print. `handleCrop` still logs the underlying
   * error, which is worth keeping for a developer with a console open, but a
   * deliberate rejection should not look like a broken suite. Spying also lets
   * the last case assert the log survives alongside the new message.
   */
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  /**
   * Opens the cropper and supplies the crop rectangle, which is the state
   * `handleCrop` refuses to run without. A real `Cropper` would report one from
   * `onCropComplete` after laying itself out; the mock lays nothing out, so the
   * callback is invoked directly with a plausible source-pixel rectangle.
   */
  const openCropperReadyToCrop = async (
    onPendingPictureChange: jest.Mock = jest.fn(),
  ) => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={onPendingPictureChange}
      />,
    );

    const input = screen.getByLabelText("Upload Profile Picture");
    const file = new File(["photo"], "photo.heic", { type: "image/heic" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    act(() => {
      const rectangle = { x: 0, y: 0, width: 3369, height: 3369 };
      cropperProps?.onCropComplete?.(rectangle, rectangle);
    });

    return { input, onPendingPictureChange };
  };

  /** Clicks `Crop Image` and lets the handler's promise settle. */
  const clickCrop = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crop Image" }));
    });
  };

  it("tells the user the photo could not be read", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    await openCropperReadyToCrop();

    await clickCrop();

    expect(screen.getByRole("alert")).toHaveTextContent(CROP_FAILURE_MESSAGE);
  });

  it("hands the parent nothing when the crop fails", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Canvas is empty"));
    const { onPendingPictureChange } = await openCropperReadyToCrop();

    await clickCrop();

    expect(onPendingPictureChange).not.toHaveBeenCalled();
  });

  it("keeps the dialog open so the failure is read in context", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    await openCropperReadyToCrop();

    await clickCrop();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("puts the message inside the dialog, where a toast could not be", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    await openCropperReadyToCrop();

    await clickCrop();

    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByRole("alert"),
    );
  });

  it("keeps the message outside the scrolling stage", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    await openCropperReadyToCrop();

    await clickCrop();

    // A sibling of the scroller, for the same reason the button row is one:
    // the panel is capped and the stage is what gives way, so a message
    // *inside* the scroller would scroll out of sight on the short viewports
    // this is most likely to be read on. The structural assertion is what
    // survives a refactor that keeps every class name and still hides it.
    const scroller = screen.getByTestId("cropper").parentElement?.parentElement;
    const alert = screen.getByRole("alert");

    expect(scroller?.contains(alert)).toBe(false);
    expect(alert.parentElement).toBe(scroller?.parentElement);
  });

  it("drops the message when a different photo is picked", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    const { input } = await openCropperReadyToCrop();
    await clickCrop();
    expect(screen.queryByRole("alert")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [new File(["other"], "other.jpg", { type: "image/jpeg" })],
        },
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops the message when the dialog is cancelled", async () => {
    getCroppedImgMock.mockRejectedValue(new Error("Failed to load image"));
    const { input } = await openCropperReadyToCrop();
    await clickCrop();
    // The control for the negative assertion below, which a component that
    // never shows a message at all would otherwise satisfy.
    expect(screen.queryByRole("alert")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [new File(["other"], "other.jpg", { type: "image/jpeg" })],
        },
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still logs the underlying error for a developer", async () => {
    const error = new Error("Failed to load image");
    getCroppedImgMock.mockRejectedValue(error);
    await openCropperReadyToCrop();

    await clickCrop();

    expect(consoleError).toHaveBeenCalledWith(error);
  });

  /**
   * The positive control. Without it every assertion above is satisfied by a
   * component that simply never crops anything.
   */
  it("still hands up the file and closes, when the crop succeeds", async () => {
    getCroppedImgMock.mockResolvedValue({
      file: croppedFile,
      url: "blob:from-getCroppedImg",
    });
    const { onPendingPictureChange } = await openCropperReadyToCrop();

    await clickCrop();

    expect(onPendingPictureChange).toHaveBeenCalledWith(croppedFile);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The URL `getCroppedImg` returns is redundant the moment it exists, and
    // the source is finished with once the crop has been drawn. Both are
    // released rather than left for the browser to collect.
    expect(revokedUrls).toContain("blob:from-getCroppedImg");
    expect(liveUrls()).toHaveLength(0);
  });
});

/**
 * That the cropper modal caps its own height and keeps its button row outside
 * the scrolling region.
 *
 * Without a `max-h`, a `dvh` unit and an overflow rule, the panel is centred
 * inside a `fixed inset-0` wrapper at its natural 476px, which overflows a
 * 375px landscape-phone viewport by 51px at *each* end and slices both
 * `Cancel` and `Crop Image` in half. `#__next` is `height: 100dvh`, so there
 * is no page scroll to reach them with.
 *
 * **What this block cannot see is most of the geometry.** A 476px box in a
 * 375px viewport is indistinguishable here from one that fits. Uncapped,
 * `Cancel` sits 27px below the fold; capped, the panel is 338px tall and both
 * buttons are fully within the viewport - both figures measured in Chromium.
 *
 * What *is* observable is the structure that produces that geometry, and it is
 * the part a later edit would break silently: which element carries the cap,
 * and whether the button row is a sibling of the scroller rather than a child
 * of it. A row inside the scroller would scroll away while every class name
 * here still read correctly.
 *
 * Run against the pre-fix component, four of the five cases below fail. The
 * fifth - that the stage keeps its `h-96` - passes either way by design: it
 * pins a property this change deliberately did *not* alter, because shrinking
 * the stage is the obvious fix and the wrong one.
 */
describe("the cropper modal's height", () => {
  /** Opens the cropper the way a user does, and returns its panel element. */
  const openCropper = (): HTMLElement => {
    // No crop has been confirmed at this point, so the parent holds no pending
    // picture. Only the cropper panel's height is under test here either way.
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    const input = screen.getByLabelText("Upload Profile Picture");
    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    const stage = screen.getByTestId("cropper").parentElement;
    if (!stage) throw new Error("the cropper did not mount");

    // stage -> scroller -> panel.
    const panel = stage.parentElement?.parentElement;
    if (!panel) throw new Error("the panel is not where this test expects it");
    return panel;
  };

  it("caps the panel against the dynamic viewport", () => {
    const panel = openCropper();

    // The unit matters as much as the cap: `vh` is the viewport with the
    // mobile browser's chrome retracted, which over-measures on exactly the
    // devices this is for. `globals.css` records the same reasoning.
    expect(panel.className).toContain("max-h-[90dvh]");
    // A *bare* `vh`, which `dvh` deliberately does not match.
    expect(panel.className).not.toMatch(/\d+vh\]/);
  });

  it("lays the panel out as a column so the cap can be shared out", () => {
    const panel = openCropper();

    expect(panel.className).toContain("flex");
    expect(panel.className).toContain("flex-col");
  });

  it("gives the crop stage a scroller that is allowed to shrink", () => {
    openCropper();

    const scroller = screen.getByTestId("cropper").parentElement?.parentElement;
    if (!scroller) throw new Error("no scroller around the stage");

    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("flex-1");
    // A flex item's default `min-height` is `auto`, which refuses to shrink
    // below its content - without this the scroller stays 384px tall and
    // pushes the button row straight back off the screen.
    expect(scroller.className).toContain("min-h-0");
  });

  it("keeps the crop stage at its full height rather than shrinking it", () => {
    openCropper();

    const stage = screen.getByTestId("cropper").parentElement;
    // `cropSize` is a flat `CROP_BOX_PX` (300px), so a stage shorter than that
    // would draw the round crop box overflowing its own container. Holding it
    // at 384px also leaves `mediaSize` - which react-easy-crop derives from
    // this container under `objectFit="contain"` - the value the fill-zoom
    // arithmetic elsewhere was measured against.
    expect(stage?.className).toContain("h-96");
  });

  it("keeps the button row outside the scroller, at full height", () => {
    const panel = openCropper();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const crop = screen.getByRole("button", { name: "Crop Image" });
    const row = cancel.parentElement;
    if (!row) throw new Error("the buttons have no row");

    expect(crop.parentElement).toBe(row);

    // The row is a *sibling* of the scroller, not inside it. This is the
    // assertion that survives a refactor which keeps every class name and
    // still puts the buttons back out of reach.
    const scroller = screen.getByTestId("cropper").parentElement?.parentElement;
    expect(row.parentElement).toBe(panel);
    expect(row.contains(scroller as Node)).toBe(false);
    expect(scroller?.contains(row)).toBe(false);

    // `shrink-0` so the row keeps its height as the scroller gives way, rather
    // than the two sharing the shortfall.
    expect(row.className).toContain("shrink-0");
  });
});

/**
 * That the preview the user sees and the file that will be uploaded cannot
 * disagree.
 *
 * The second half of the pending-preview contract. The cropped `File` lives
 * in the parent - the profile page, or `setup.tsx` - so if the preview URL
 * lived in `ProfilePicture`'s own state the unmount cleanup would revoke it,
 * and switching profile tabs or stepping back through onboarding would destroy
 * the preview and leave the parent holding a picture the user cannot see,
 * which the next Save uploads anyway. Two pieces of one value, kept in two
 * places, with only one of them surviving a remount.
 *
 * So the preview is not stored at all: `selectedFile` is the single source of
 * truth and the preview is derived from it by an effect, so a remount rebuilds
 * it. These assertions are about that derivation, which is
 * what makes the two agree by construction rather than by remembering to keep
 * them in step.
 *
 * **Measured against the pre-fix component every test here fails**, and not
 * only on the assertions: `selectedFile` was not a prop, so the preview could
 * not be driven from outside the component at all.
 *
 * **The assertions count *live* object URLs rather than calls.**
 * `jest.setup.dom.ts` turns StrictMode on for every component test because
 * production runs with it, so mounting runs the effect setup, its cleanup, and
 * the setup again - two `createObjectURL` calls for one mount, of which one is
 * already revoked. Counting calls would encode that doubling into the
 * expectations and would then break on any change to it; what actually matters,
 * and what the memory this component is careful about depends on, is that
 * exactly one URL is alive while a picture is pending and none once it is not.
 *
 * `cropImage.test.ts` records the same canvas limitation for the arithmetic
 * half of the crop.
 */
describe("the pending picture preview", () => {
  /** The cropped JPEG `handleCrop` hands up, as `getCroppedImg` names it. */
  const croppedFile = () =>
    new File(["cropped-bytes"], "cropped-image.jpeg", { type: "image/jpeg" });

  /** The pending preview, or null when none is rendered. */
  const preview = () => screen.queryByAltText("Cropped Image");

  it("renders from the file the parent holds", () => {
    render(
      <ProfilePicture
        pendingPicture={croppedFile()}
        onPendingPictureChange={jest.fn()}
      />,
    );

    expect(preview()).toBeInTheDocument();
    expect(liveUrls()).toHaveLength(1);
    expect(preview()?.getAttribute("src")).toContain(liveUrls()[0]);
  });

  /**
   * The control. Without it every assertion here would pass against a
   * component that always renders a preview, which would show a stale avatar
   * to a user who has chosen no picture at all.
   */
  it("renders no preview when the parent holds no file", () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    expect(preview()).not.toBeInTheDocument();
    expect(createdUrls).toHaveLength(0);
  });

  /**
   * A profile tab switch, or an onboarding step change.
   *
   * Both unmount this component while the parent goes on holding the file, so
   * this is the sequence that can leave a pending upload with no visible
   * preview.
   */
  it("rebuilds the preview after an unmount and remount", () => {
    // The parent's state survives the unmount, so the same file is handed back.
    const file = croppedFile();

    const first = render(
      <ProfilePicture
        pendingPicture={file}
        onPendingPictureChange={jest.fn()}
      />,
    );
    expect(preview()).toBeInTheDocument();
    const beforeUnmount = liveUrls();
    expect(beforeUnmount).toHaveLength(1);

    first.unmount();
    // Nothing is left alive: the URL from the first mount is released rather
    // than leaked, which the effect's own cleanup is what guarantees.
    expect(liveUrls()).toEqual([]);

    render(
      <ProfilePicture
        pendingPicture={file}
        onPendingPictureChange={jest.fn()}
      />,
    );

    // The assertion that matters: the preview is back, on a URL derived fresh
    // from the file rather than the revoked one the first mount held.
    const rebuilt = preview();
    expect(rebuilt).toBeInTheDocument();
    expect(liveUrls()).toHaveLength(1);
    expect(liveUrls()).not.toEqual(beforeUnmount);
    expect(rebuilt?.getAttribute("src")).toContain(liveUrls()[0]);
  });

  it("replaces the preview, and releases the old URL, when the file changes", () => {
    const { rerender } = render(
      <ProfilePicture
        pendingPicture={croppedFile()}
        onPendingPictureChange={jest.fn()}
      />,
    );
    const first = liveUrls();
    expect(first).toHaveLength(1);

    rerender(
      <ProfilePicture
        pendingPicture={croppedFile()}
        onPendingPictureChange={jest.fn()}
      />,
    );

    // Cropping a second photo must not leave the first blob alive. On mobile
    // the source is a multi-megabyte camera-roll photo, which is the memory
    // this component's URL bookkeeping exists for.
    expect(liveUrls()).toHaveLength(1);
    expect(liveUrls()).not.toEqual(first);
    expect(revokedUrls).toContain(first[0]);
    expect(preview()?.getAttribute("src")).toContain(liveUrls()[0]);
  });

  it("drops the preview when the parent clears the file", () => {
    // What Save does on success and what Continue does on the way out: the
    // page sets `selectedFile` to null, and the avatar must stop showing a
    // local crop that is no longer pending.
    const { rerender } = render(
      <ProfilePicture
        pendingPicture={croppedFile()}
        onPendingPictureChange={jest.fn()}
      />,
    );
    expect(preview()).toBeInTheDocument();

    rerender(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    expect(preview()).not.toBeInTheDocument();
    expect(liveUrls()).toEqual([]);
  });
});

/**
 * The two halves of the upload control, either of which can leave a user in
 * front of a button that does nothing.
 *
 * **Keyboard reach.** A file input carrying a class that compiles to
 * `display: none` is unfocusable, and the only visible control is a `<label>`,
 * which is not focusable either - so between them the upload control would
 * hold no focusable element at all, making a profile picture pointer-only on
 * `/profile` and on setup step 4. As in `Setup/FormRadioButton.test.tsx`,
 * jsdom loads no stylesheet and so cannot see that; the class contract is what
 * is assertable here, and the tab order was verified in Chromium.
 *
 * **Re-picking the same file.** A file input fires `change` when its value
 * changes, not when the dialog closes. So `handleFileChange` must clear the
 * value: otherwise the sequence that actually happens - pick a photo, dislike
 * the crop, cancel, pick the same photo again - sets the input to the value it
 * already holds, fires nothing, and reopens no cropper.
 *
 * jsdom cannot reproduce that sequence, and the obvious test is worthless
 * *because* it cannot: `fireEvent.change` dispatches the event
 * unconditionally, with no regard for whether the value changed, so "pick the
 * same file twice and assert the dialog reopens" passes just as happily
 * against a component that never clears. What is observable, and what the
 * browser's behaviour is downstream of, is that the handler leaves the value
 * empty - so
 * that is asserted directly, against a value seeded the way a real pick leaves
 * one.
 */
describe("the upload control", () => {
  const uploadInput = () =>
    screen.getByLabelText("Upload Profile Picture") as HTMLInputElement;

  it("hides the file input visually rather than removing it from the page", () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    // The control: the input is reachable by its label at all, so the class
    // assertions below are about the element the user would actually tab to.
    const input = uploadInput();
    expect(input).toBeInTheDocument();

    const classes = input.className.split(" ");
    expect(classes).toContain("sr-only");
    expect(classes).not.toContain("hidden");
  });

  it("puts the focus ring on the label, the only box the user can see", () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    const input = uploadInput();
    const label = document.querySelector<HTMLElement>('label[for="fileInput"]');
    expect(label).not.toBeNull();

    // A sibling variant only reaches *forward*, so the ordering is part of the
    // contract: the label can only style itself from the input's focus state
    // while the input precedes it.
    expect(input.nextElementSibling).toBe(label);
    expect(input.className.split(" ")).toContain("peer");
    expect(label!.className).toContain("peer-focus-visible:outline");
  });

  it("clears the input's value so re-picking the same file is still a change", () => {
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );
    const input = uploadInput();

    // What a real pick leaves behind. Seeded explicitly because
    // `fireEvent.change` sets only `files`, and against an untouched `value`
    // of "" the assertion below would hold with the fix reverted.
    Object.defineProperty(input, "value", {
      configurable: true,
      writable: true,
      value: "C:\\fakepath\\photo.jpg",
    });
    expect(input.value).not.toBe("");

    const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    // The handler still did its job with the file it was given - the clear
    // must not cost the pick - and then left nothing for the next one to
    // collide with.
    expect(screen.getByTestId("cropper")).toBeInTheDocument();
    expect(input.value).toBe("");
  });
});

/**
 * The remove control, and the two questions it has to answer correctly.
 *
 * **When it exists.** A button that is always present is a button that does
 * nothing for the majority of users, who have no picture: against the fallback
 * icon, with nothing pending, "remove" has no meaning. So the control appears
 * only when there is a picture on screen to take away - a stored one, or a crop
 * waiting to be uploaded - and disappears again once a removal is pending,
 * because by then there is nothing further to remove.
 *
 * **What it means.** Removal is pending until Save, exactly as an upload is, so
 * the click hands a value up to the parent rather than calling the server. The
 * value is not always the removal marker: discarding a crop when the server
 * holds no picture returns the user to the state they started in, which is no
 * change at all. Marking *that* for removal would arm the unsaved-changes modal
 * over nothing and spend a mutation on saving nothing, so this component - the
 * only one that knows whether a stored picture exists - resolves it to null
 * instead. That distinction is the reason the two click tests below differ only
 * in whether a stored picture is present.
 *
 * `useProfileImage` is stubbed per test rather than through a provider, the
 * same treatment the rest of this file gives it. jsdom loads no stylesheet, so
 * what is assertable here is which element is rendered and what it hands back,
 * not how any of it looks.
 */
describe("the remove control", () => {
  /** The cropped JPEG `handleCrop` hands up. */
  const croppedFile = () =>
    new File(["cropped-bytes"], "cropped-image.jpeg", { type: "image/jpeg" });

  const removeButton = () =>
    screen.queryByRole("button", { name: "Remove Profile Picture" });

  /**
   * The "no picture" avatar.
   *
   * Located by element rather than by role: it is an `AiOutlineUser`, and
   * react-icons renders a bare `svg` carrying no `role` and no accessible
   * name, so there is nothing for `getByRole` to match. Nothing else in this
   * component renders an `svg` - the cropper is mocked to a `div` - so this is
   * specific enough to serve as the positive control the negative assertions
   * beside it need.
   */
  const fallbackIcon = () => document.querySelector("svg");

  /** Puts a stored picture behind the component, as a signed URL would. */
  const withStoredPicture = () =>
    profileImageSpies().useProfileImage.mockReturnValue({
      profileImageUrl: "https://bucket.s3.amazonaws.com/me?sig=abc",
      isLoading: false,
      imageLoadError: false,
    });

  describe("is shown only when there is something to remove", () => {
    it("is absent with no stored picture and nothing pending", () => {
      // The majority case, and the control for every assertion below: without
      // it they would all pass against a component that renders the button
      // unconditionally.
      render(
        <ProfilePicture
          pendingPicture={null}
          onPendingPictureChange={jest.fn()}
        />,
      );

      expect(removeButton()).not.toBeInTheDocument();
    });

    it("is present when the server holds a picture", () => {
      withStoredPicture();

      render(
        <ProfilePicture
          pendingPicture={null}
          onPendingPictureChange={jest.fn()}
        />,
      );

      expect(removeButton()).toBeInTheDocument();
    });

    it("is present when a crop is waiting to be uploaded", () => {
      // No stored picture here, so the only thing to remove is the pending
      // crop - which is the onboarding case, where discarding is all the
      // control can mean.
      render(
        <ProfilePicture
          pendingPicture={croppedFile()}
          onPendingPictureChange={jest.fn()}
        />,
      );

      expect(removeButton()).toBeInTheDocument();
    });

    it("is absent once a removal is already pending", () => {
      withStoredPicture();

      render(
        <ProfilePicture
          pendingPicture={PENDING_REMOVAL}
          onPendingPictureChange={jest.fn()}
        />,
      );

      // The stored URL is still there - the server has not been told yet - so
      // a visibility rule written against `profileImageUrl` alone would leave
      // the button up and let the user press it a second time to no effect.
      expect(removeButton()).not.toBeInTheDocument();
    });
  });

  it("is a button that cannot submit the profile form", () => {
    withStoredPicture();

    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    // This sits inside the profile form. The default `type` for a `button` is
    // `submit`, which would save the whole profile on click and would also make
    // this the target of implicit submission on Enter - the defect
    // `profileImplicitSubmission.test.tsx` exists for, reintroduced one control
    // further along.
    expect(removeButton()).toHaveAttribute("type", "button");
  });

  describe("hands the right pending change to the parent", () => {
    it("marks a stored picture for removal", () => {
      withStoredPicture();
      const onPendingPictureChange = jest.fn();

      render(
        <ProfilePicture
          pendingPicture={null}
          onPendingPictureChange={onPendingPictureChange}
        />,
      );
      fireEvent.click(removeButton() as HTMLElement);

      expect(onPendingPictureChange).toHaveBeenCalledTimes(1);
      expect(onPendingPictureChange).toHaveBeenCalledWith(PENDING_REMOVAL);
    });

    it("replaces a pending crop with a removal when a picture is stored", () => {
      // Upload a new photo, then change your mind entirely. What the user is
      // asking for is the stored picture gone, not the crop restored, so the
      // crop is dropped and the removal takes its place - which the single
      // slot makes automatic.
      withStoredPicture();
      const onPendingPictureChange = jest.fn();

      render(
        <ProfilePicture
          pendingPicture={croppedFile()}
          onPendingPictureChange={onPendingPictureChange}
        />,
      );
      fireEvent.click(removeButton() as HTMLElement);

      expect(onPendingPictureChange).toHaveBeenCalledWith(PENDING_REMOVAL);
    });

    it("discards a pending crop to nothing when no picture is stored", () => {
      // The onboarding case. There is nothing on the server to delete, so the
      // honest pending state is "no change" - not a removal that would arm the
      // unsaved-changes modal and then save nothing.
      const onPendingPictureChange = jest.fn();

      render(
        <ProfilePicture
          pendingPicture={croppedFile()}
          onPendingPictureChange={onPendingPictureChange}
        />,
      );
      fireEvent.click(removeButton() as HTMLElement);

      expect(onPendingPictureChange).toHaveBeenCalledTimes(1);
      expect(onPendingPictureChange).toHaveBeenCalledWith(null);
    });
  });

  describe("shows what saving will leave behind", () => {
    it("renders the fallback icon instead of the stored picture", () => {
      withStoredPicture();

      render(
        <ProfilePicture
          pendingPicture={PENDING_REMOVAL}
          onPendingPictureChange={jest.fn()}
        />,
      );

      // The positive query first: the fallback really did render, so the two
      // negative assertions below are about a picture that is genuinely gone
      // rather than one that was never found by that name.
      expect(fallbackIcon()).toBeInTheDocument();
      expect(screen.queryByAltText("Profile Picture")).not.toBeInTheDocument();
      expect(screen.queryByAltText("Cropped Image")).not.toBeInTheDocument();
    });

    it("does not wait for a still-loading picture before showing it", () => {
      // The neutral placeholder exists so an avatar does not flash the fallback
      // on the way to its image. A pending removal is heading for the fallback
      // whatever the query resolves to, so holding the placeholder would be the
      // flicker it was added to prevent.
      profileImageSpies().useProfileImage.mockReturnValue({
        profileImageUrl: null,
        isLoading: true,
        imageLoadError: false,
      });

      render(
        <ProfilePicture
          pendingPicture={PENDING_REMOVAL}
          onPendingPictureChange={jest.fn()}
        />,
      );

      expect(fallbackIcon()).toBeInTheDocument();
    });
  });
});

/**
 * The two controls are the same control in two states, so they are drawn as one
 * box width rather than each shrink-wrapping its own text.
 *
 * **jsdom resolves no layout**, so nothing here can assert the widths are
 * equal - every rectangle in this file is zero. What these assert is the
 * structure that makes them equal: one stretching column holding both, with
 * neither child opting out. The equality itself was measured in Chromium
 * against the compiled stylesheet - 238.52px each, against 227.43 and 238.52
 * before - and is recorded on SCRUM-660.
 */
describe("the two picture controls share a box", () => {
  const uploadLabel = () =>
    document.querySelector<HTMLElement>('label[for="fileInput"]')!;

  const removeButton = () =>
    screen.queryByRole("button", { name: "Remove Profile Picture" });

  /** Puts a stored picture behind the component, so Remove is offered. */
  const renderWithRemovable = () => {
    profileImageSpies().useProfileImage.mockReturnValue({
      profileImageUrl: "https://bucket.s3.amazonaws.com/me?sig=abc",
      isLoading: false,
      imageLoadError: false,
    });
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );
  };

  it("puts both controls in one column that stretches them", () => {
    renderWithRemovable();

    const label = uploadLabel();
    const button = removeButton();
    // The control: both are on screen, so the shared-parent assertion below is
    // about two rendered controls rather than one and a null.
    expect(label).toBeInTheDocument();
    expect(button).toBeInTheDocument();

    const wrapper = label.parentElement!;
    expect(button!.parentElement).toBe(wrapper);

    const classes = wrapper.className.split(" ");
    expect(classes).toContain("flex");
    expect(classes).toContain("flex-col");
    // `align-items` must stay at its `stretch` default: this is the whole
    // mechanism, and `items-start` here is exactly what made the two differ.
    expect(wrapper.className).not.toMatch(/\bitems-(start|center|end)\b/);
  });

  it("leaves the sizing to the column rather than to either control", () => {
    renderWithRemovable();

    // A width on either child would override the stretch and put the two back
    // out of step - which is also why no measured figure is written down.
    for (const control of [uploadLabel(), removeButton()!]) {
      expect(control.className).not.toMatch(/\bw-/);
    }
  });

  it("spaces them from the column, so the upload control stands alone cleanly", () => {
    // The gap replaces the `mt-3` the remove button used to carry. With one
    // child a gap contributes nothing, so the upload control is unmoved when
    // removal is not offered - which is the majority case.
    render(
      <ProfilePicture
        pendingPicture={null}
        onPendingPictureChange={jest.fn()}
      />,
    );

    const label = uploadLabel();
    expect(removeButton()).not.toBeInTheDocument();
    expect(label.parentElement!.className).toMatch(/\bgap-\d/);
    expect(label.className).not.toMatch(/\bmt-\d/);
  });
});

/**
 * The stored picture failing to load - a different failure from the query
 * failing, and the one branch of this component that still drew a broken image.
 *
 * `useInvalidateProfileImage` reaches one React Query cache: the one in the tab
 * that ran the mutation. A second tab, a second device, or an object that went
 * away without this client's mutation running at all - an out-of-band bucket
 * deletion, or the `NEXT_PUBLIC_ENV` change that orphans every existing upload -
 * each leave a perfectly good signed URL pointing at nothing. SCRUM-660 fixed
 * that at the four `ProfileAvatar` sites and exempted this one, on the premise
 * that the owner's own cache is always invalidated; that premise holds only
 * inside the tab that did the removal, which is SCRUM-663.
 *
 * **The error is dispatched, not provoked, and that is a proxy.** jsdom fetches
 * no images, so nothing here can make a `src` 404 the way a removed S3 object
 * does in a browser. `fireEvent.error` fires the same `error` event the browser
 * would, on the same element, and `next/image` forwards `onError` to that
 * element's handler - so what these tests pin is the component's response to the
 * event, not the browser's decision to emit it. The other half was measured on
 * SCRUM-660: Next's optimizer answers `400` with no image body for a missing
 * upstream object, against a `200 image/png` control. `ProfileAvatar.test.tsx`
 * carries the same caveat for the same reason.
 */
describe("when the stored picture itself fails to load", () => {
  const STORED_URL = "https://bucket.s3.amazonaws.com/me?sig=abc";
  /** A re-upload, or a refetch: the same user, a different signed URL. */
  const REUPLOADED_URL = "https://bucket.s3.amazonaws.com/me?sig=def";

  const storedImage = () =>
    screen.queryByRole("img", { name: "Profile Picture" });

  /**
   * The "no picture" icon. By element rather than by role, for the reason the
   * remove-control block above records: react-icons renders a bare `svg` with
   * no `role` and no accessible name. The cropper is mocked to a `div` and both
   * controls are text, so this component renders no other `svg`.
   */
  const fallbackIcon = () => document.querySelector("svg");

  const removeButton = () =>
    screen.queryByRole("button", { name: "Remove Profile Picture" });

  /** A stored picture the server is happy to sign a URL for. */
  const withStoredPicture = (url: string) =>
    profileImageSpies().useProfileImage.mockReturnValue({
      profileImageUrl: url,
      isLoading: false,
      imageLoadError: false,
    });

  /**
   * A fresh element each call, which the re-render tests depend on: React bails
   * out of re-rendering when handed the identical element reference, and a
   * `rerender` that did nothing would pass either way.
   */
  const pictureElement = (onPendingPictureChange: jest.Mock) => (
    <ProfilePicture
      pendingPicture={null}
      onPendingPictureChange={onPendingPictureChange}
    />
  );

  it("replaces the broken image with the fallback icon", () => {
    withStoredPicture(STORED_URL);
    render(pictureElement(jest.fn()));

    const image = storedImage();
    expect(image).toBeInTheDocument();

    fireEvent.error(image!);

    expect(fallbackIcon()).toBeInTheDocument();
    expect(storedImage()).not.toBeInTheDocument();
  });

  it("leaves a picture that has not errored alone", () => {
    // The positive control for the test above. Without it that one would pass
    // against a component that never renders the stored picture at all.
    withStoredPicture(STORED_URL);
    render(pictureElement(jest.fn()));

    expect(storedImage()).toBeInTheDocument();
    expect(fallbackIcon()).not.toBeInTheDocument();
  });

  it("still holds the neutral placeholder while the URL is resolving", () => {
    // The branch immediately above the one this ticket changed, and the reason
    // the new condition was added to that branch rather than ahead of it: the
    // placeholder exists so the avatar does not flash the "no picture" icon on
    // its way to a picture, and a failure flag consulted too early would spend
    // the resolving window on the fallback instead.
    //
    // Asserted by elimination rather than by class name. Every other branch of
    // this avatar renders either an `svg` or an `img`, so neither being present
    // is what identifies the placeholder - and it keeps the test off the
    // utilities that decide how the placeholder is drawn.
    profileImageSpies().useProfileImage.mockReturnValue({
      profileImageUrl: null,
      isLoading: true,
      imageLoadError: false,
    });

    render(pictureElement(jest.fn()));

    expect(fallbackIcon()).not.toBeInTheDocument();
    expect(storedImage()).not.toBeInTheDocument();
  });

  it("renders a new URL for the same user rather than inheriting the failure", () => {
    // Why the failure is stored as the URL and not a boolean. The hook hands
    // back a fresh URL after a re-upload or a refetch, and a latched boolean
    // would hold the fallback over a picture that loads perfectly well - on the
    // one page the user went to in order to fix exactly this.
    withStoredPicture(STORED_URL);
    const onChange = jest.fn();
    const { rerender } = render(pictureElement(onChange));

    fireEvent.error(storedImage()!);
    expect(fallbackIcon()).toBeInTheDocument();

    withStoredPicture(REUPLOADED_URL);
    rerender(pictureElement(onChange));

    expect(storedImage()).toBeInTheDocument();
    expect(fallbackIcon()).not.toBeInTheDocument();
  });

  it("keeps the fallback while the failed URL is the one on offer", () => {
    // The other side of that comparison: a re-render that changes nothing must
    // not undo the downgrade, or the broken image returns on every render.
    withStoredPicture(STORED_URL);
    const onChange = jest.fn();
    const { rerender } = render(pictureElement(onChange));

    fireEvent.error(storedImage()!);
    rerender(pictureElement(onChange));

    expect(fallbackIcon()).toBeInTheDocument();
    expect(storedImage()).not.toBeInTheDocument();
  });

  describe("still treats the picture as stored, because the server's is", () => {
    it("goes on offering Remove", () => {
      // Deliberate, and the opposite of what the fallback icon suggests. The
      // row in the database is untouched by the image failing to load, and this
      // button is the only control that clears it - so hiding it would strand a
      // user whose picture is permanently missing with no way to fix the
      // profile this page exists to fix.
      withStoredPicture(STORED_URL);
      render(pictureElement(jest.fn()));

      fireEvent.error(storedImage()!);

      expect(removeButton()).toBeInTheDocument();
    });

    it("marks it for removal on the server rather than discarding nothing", () => {
      // The half that actually matters. `handleRemove` sends `PENDING_REMOVAL`
      // only when a picture is stored, and `null` otherwise; reading the image
      // failure as "no picture stored" would send `null` here, which saves
      // nothing and leaves the stale column exactly as it was.
      withStoredPicture(STORED_URL);
      const onPendingPictureChange = jest.fn();
      render(pictureElement(onPendingPictureChange));

      fireEvent.error(storedImage()!);
      fireEvent.click(removeButton()!);

      expect(onPendingPictureChange).toHaveBeenCalledWith(PENDING_REMOVAL);
    });
  });
});
