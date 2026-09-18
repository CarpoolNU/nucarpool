/**
 * The crop dialog's accessibility contract. SCRUM-514.
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
 * What this file cannot see: jsdom performs no layout, so containment of the
 * focus trap - whether Tab can actually escape to the page behind - is only
 * partially testable here. Real verification takes a browser; the existing
 * Chromium measurement harness is where that would go.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("the crop dialog", () => {
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
