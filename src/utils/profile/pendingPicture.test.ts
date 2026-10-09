/**
 * The two narrowings every consumer of `PendingPicture` goes through.
 *
 * Small, but worth pinning rather than inlining at six call sites: the whole
 * value of the single-slot model is that "a file is pending" and "a removal is
 * pending" can never both be true, and these are the functions that answer
 * those two questions. An `instanceof` that quietly accepted the string, or a
 * removal test that accepted any truthy value, would give back exactly the
 * both-at-once state the type exists to rule out.
 */

import {
  PENDING_REMOVAL,
  pendingPictureFile,
  isPendingRemoval,
} from "./pendingPicture";

/**
 * The cropped JPEG `handleCrop` hands up, as `getCroppedImg` names it.
 *
 * A real `File` rather than a stub, the same choice `hasProfileChanges.test.ts`
 * records: `pendingPictureFile` narrows by `instanceof`, so a plain object
 * would be rejected for the wrong reason and the test would agree with a rule
 * that had stopped meaning anything. Node 22 provides the constructor in the
 * node project.
 */
const croppedFile = () =>
  new File(["cropped-bytes"], "cropped-image.jpeg", { type: "image/jpeg" });

describe("pendingPictureFile", () => {
  it("returns the file when one is pending", () => {
    const file = croppedFile();

    expect(pendingPictureFile(file)).toBe(file);
  });

  it("returns null for a pending removal", () => {
    // The case that matters: a removal must never reach the upload path. The
    // pages pass this straight into `useUploadFile`, which would otherwise
    // try to sign a presigned URL for the string "remove".
    expect(pendingPictureFile(PENDING_REMOVAL)).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(pendingPictureFile(null)).toBeNull();
  });
});

describe("isPendingRemoval", () => {
  it("is true only for the removal marker", () => {
    expect(isPendingRemoval(PENDING_REMOVAL)).toBe(true);
  });

  it("is false for a pending file", () => {
    // The control. `!!pending` is true here too, so a removal test written as
    // a truthiness check would call an upload a removal and delete the
    // picture the user was in the middle of replacing.
    expect(isPendingRemoval(croppedFile())).toBe(false);
  });

  it("is false when nothing is pending", () => {
    expect(isPendingRemoval(null)).toBe(false);
  });
});
