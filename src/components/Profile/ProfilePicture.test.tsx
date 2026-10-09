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
  cropperProps = null;
  createdUrls = [];
  revokedUrls = [];

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
        selectedFile={croppedFile()}
        onFileSelected={jest.fn()}
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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
      <ProfilePicture selectedFile={file} onFileSelected={jest.fn()} />,
    );
    expect(preview()).toBeInTheDocument();
    const beforeUnmount = liveUrls();
    expect(beforeUnmount).toHaveLength(1);

    first.unmount();
    // Nothing is left alive: the URL from the first mount is released rather
    // than leaked, which the effect's own cleanup is what guarantees.
    expect(liveUrls()).toEqual([]);

    render(<ProfilePicture selectedFile={file} onFileSelected={jest.fn()} />);

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
        selectedFile={croppedFile()}
        onFileSelected={jest.fn()}
      />,
    );
    const first = liveUrls();
    expect(first).toHaveLength(1);

    rerender(
      <ProfilePicture
        selectedFile={croppedFile()}
        onFileSelected={jest.fn()}
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
        selectedFile={croppedFile()}
        onFileSelected={jest.fn()}
      />,
    );
    expect(preview()).toBeInTheDocument();

    rerender(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

    // The control: the input is reachable by its label at all, so the class
    // assertions below are about the element the user would actually tab to.
    const input = uploadInput();
    expect(input).toBeInTheDocument();

    const classes = input.className.split(" ");
    expect(classes).toContain("sr-only");
    expect(classes).not.toContain("hidden");
  });

  it("puts the focus ring on the label, the only box the user can see", () => {
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);

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
    render(<ProfilePicture selectedFile={null} onFileSelected={jest.fn()} />);
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
