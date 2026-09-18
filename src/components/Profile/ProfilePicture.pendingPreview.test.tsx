/**
 * That the preview the user sees and the file that will be uploaded cannot
 * disagree.
 *
 * SCRUM-511's second symptom. The cropped `File` lived in the parent - the
 * profile page, or `setup.tsx` - while the preview URL lived in
 * `ProfilePicture`'s own state, and the component's unmount cleanup revoked it.
 * So switching profile tabs, or stepping back through onboarding, destroyed the
 * preview and left the parent holding a picture the user could no longer see,
 * which the next Save uploaded anyway. Two pieces of one value, kept in two
 * places, with only one of them surviving a remount.
 *
 * The fix is to stop storing the preview at all: `selectedFile` is the single
 * source of truth and the preview is derived from it by an effect, so a
 * remount rebuilds it. These assertions are about that derivation, which is
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
 * What this file cannot see: jsdom implements no canvas, so `getCroppedImg` -
 * and therefore `handleCrop`, the thing that produces the file - is
 * unreachable here. That is why the file is supplied as a prop rather than
 * produced by cropping. `cropImage.test.ts` records the same limitation for the
 * arithmetic half.
 */

import { render, screen } from "@testing-library/react";
import ProfilePicture from "./ProfilePicture";

jest.mock("react-easy-crop", () => ({
  __esModule: true,
  default: () => <div data-testid="cropper" />,
}));

/**
 * No stored picture, so the only avatar that can appear is the pending one.
 * Stubbed as a shape rather than driven through a tRPC provider, the same
 * treatment `UserSection.test.tsx` gives it.
 */
jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

/** The cropped JPEG `handleCrop` hands up, as `getCroppedImg` names it. */
const croppedFile = () =>
  new File(["cropped-bytes"], "cropped-image.jpeg", { type: "image/jpeg" });

let createdUrls: string[] = [];
let revokedUrls: string[] = [];

/** The object URLs handed out and not yet released. */
const liveUrls = () => createdUrls.filter((url) => !revokedUrls.includes(url));

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];

  // jsdom implements neither. Each call returns a distinct URL so that a
  // rebuilt preview is distinguishable from a retained one - the whole question
  // here is whether the component derives a fresh URL on mount or depends on
  // one it stored earlier.
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

/** The pending preview, or null when none is rendered. */
const preview = () => screen.queryByAltText("Cropped Image");

describe("the pending picture preview", () => {
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
   * The regression: a profile tab switch, or an onboarding step change.
   *
   * Both unmount this component while the parent goes on holding the file, so
   * this is the sequence that used to leave a pending upload with no visible
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
    // than leaked - the guarantee the old unmount cleanup was there to make,
    // now carried by the effect's own cleanup.
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
