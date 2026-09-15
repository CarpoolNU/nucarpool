/**
 * That the cropper modal caps its own height and keeps its button row outside
 * the scrolling region.
 *
 * SCRUM-482 (phase 1 of SCRUM-477): the panel had no `max-h`, no `dvh` and no
 * overflow, and it is centred inside a `fixed inset-0` wrapper - so at its
 * natural 476px it overflowed a 375px landscape-phone viewport by 51px at
 * *each* end, slicing both `Cancel` and `Crop Image` in half. `#__next` is
 * `height: 100dvh`, so there was no page scroll to reach them with.
 *
 * **What this file can and cannot see, and it is most of the defect.** jsdom
 * performs no layout and resolves no media query: every rectangle here is
 * zero, `max-height` is never applied to anything, and a 476px box in a 375px
 * viewport is indistinguishable from one that fits. The geometry was measured
 * in Chromium against the compiled stylesheet and is recorded on the ticket -
 * before the fix, `Cancel` sat 27px below the fold; after it, the panel is
 * 338px tall and both buttons are fully within the viewport.
 *
 * What *is* observable here is the structure that produces that geometry, and
 * it is the part a later edit would break silently: which element carries the
 * cap, and whether the button row is a sibling of the scroller rather than a
 * child of it. A row inside the scroller would scroll away again while every
 * class name in this file still read correctly.
 *
 * Run against the pre-fix component, four of the five cases below fail. The
 * fifth - that the stage keeps its `h-96` - passes either way by design: it
 * pins a property this change deliberately did *not* alter, because shrinking
 * the stage is the obvious fix and the wrong one.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import ProfilePicture from "./ProfilePicture";

jest.mock("react-easy-crop", () => ({
  __esModule: true,
  default: () => <div data-testid="cropper" />,
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

beforeEach(() => {
  // `handleFileChange` calls `createObjectURL` before the cropper can mount,
  // and jsdom implements neither half of the object-URL API.
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: jest.fn(() => "blob:mock-source"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: jest.fn(),
  });
});

/** Opens the cropper the way a user does, and returns its panel element. */
const openCropper = (): HTMLElement => {
  render(<ProfilePicture onFileSelected={jest.fn()} />);

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

describe("the cropper modal's height", () => {
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
    // this container under `objectFit="contain"` - the value SCRUM-479's
    // fill-zoom arithmetic was measured against.
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
