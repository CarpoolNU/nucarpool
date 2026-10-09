/**
 * `ProfileAvatar`, and the failure it exists to absorb: a picture that does not
 * load.
 *
 * **The error is dispatched, not provoked, and that is a proxy.** jsdom fetches
 * no images, so nothing here can make a `src` 404 the way a removed S3 object
 * does in a browser. `fireEvent.error` fires the same `error` event the browser
 * would, on the same element, and `next/image` forwards `onError` to that
 * element's handler - so what these tests pin is the component's response to
 * the event, not the browser's decision to emit it. The other half was measured
 * instead: Next's optimizer answers `400` with no image body for a missing
 * upstream object, against a `200 image/png` control, which is what makes a
 * real `<img>` fire this event. That measurement is on SCRUM-660.
 *
 * The class names passed in below are deliberately **not** Tailwind utilities.
 * Tailwind v4 scans this file like any other, so a real sizing utility written
 * here as a test fixture would ship that rule in the bundle - which is also why
 * this comment does not name one. `avatar-placeholder` and its siblings compile
 * to nothing and still identify the branch that rendered.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import ProfileAvatar from "./ProfileAvatar";
import { profileImageSpies } from "../testing/profileImageStub";

jest.mock("../utils/useProfileImage", () =>
  require("../testing/profileImageStub").buildProfileImageMock(),
);

const SIGNED_URL = "https://bucket.s3.amazonaws.com/profile/alex?sig=abc";
const OTHER_URL = "https://bucket.s3.amazonaws.com/profile/alex?sig=def";

/** Renders the component with the class names this file identifies branches by. */
const renderAvatar = (props?: { userId?: string; enabled?: boolean }) =>
  render(
    <ProfileAvatar
      alt="Alex's Profile Image"
      width={56}
      height={56}
      placeholderClassName="avatar-placeholder"
      imageClassName="avatar-image"
      fallbackClassName="avatar-fallback"
      {...props}
    />,
  );

/** What the hook reports; merged over a settled, picture-less default. */
const hookReturns = (result: {
  profileImageUrl?: string | null;
  isLoading?: boolean;
  imageLoadError?: boolean;
}) =>
  profileImageSpies().useProfileImage.mockReturnValue({
    profileImageUrl: null,
    isLoading: false,
    imageLoadError: false,
    ...result,
  });

const placeholder = () => document.querySelector(".avatar-placeholder");

/**
 * The "no picture" icon.
 *
 * By element, not by role: it is an `AiOutlineUser`, and react-icons renders a
 * bare `svg` with no `role` and no accessible name, so `getByRole` has nothing
 * to match. This component renders no other `svg`.
 */
const fallbackIcon = () => document.querySelector("svg");

const avatarImage = () =>
  screen.queryByRole("img", { name: "Alex's Profile Image" });

beforeEach(() => {
  hookReturns({});
});

describe("the three settled branches", () => {
  it("renders the neutral placeholder while the URL is still resolving", () => {
    hookReturns({ isLoading: true });
    renderAvatar();

    expect(placeholder()).toBeInTheDocument();
    // The point of the placeholder: neither of the other two branches, so the
    // avatar does not flash the "no picture" icon on its way to a picture.
    expect(fallbackIcon()).not.toBeInTheDocument();
    expect(avatarImage()).not.toBeInTheDocument();
  });

  it("renders the picture when there is one", () => {
    hookReturns({ profileImageUrl: SIGNED_URL });
    renderAvatar();

    expect(avatarImage()).toBeInTheDocument();
    expect(fallbackIcon()).not.toBeInTheDocument();
  });

  it("renders the fallback icon when the user has no picture", () => {
    hookReturns({ profileImageUrl: null });
    renderAvatar();

    expect(fallbackIcon()).toBeInTheDocument();
    expect(avatarImage()).not.toBeInTheDocument();
  });

  it("renders the fallback icon when the URL request itself failed", () => {
    // `imageLoadError` is the *query* failing - a different failure from the
    // one below, and the only one the component could see before SCRUM-660.
    hookReturns({ profileImageUrl: SIGNED_URL, imageLoadError: true });
    renderAvatar();

    expect(fallbackIcon()).toBeInTheDocument();
    expect(avatarImage()).not.toBeInTheDocument();
  });
});

describe("when the picture itself fails to load", () => {
  it("replaces the broken image with the fallback icon", () => {
    hookReturns({ profileImageUrl: SIGNED_URL });
    renderAvatar();

    const image = avatarImage();
    expect(image).toBeInTheDocument();

    fireEvent.error(image!);

    expect(fallbackIcon()).toBeInTheDocument();
    expect(avatarImage()).not.toBeInTheDocument();
  });

  it("leaves an image that has not errored alone", () => {
    // The positive control for the test above. Without it that one would pass
    // against a component that never renders the picture at all.
    hookReturns({ profileImageUrl: SIGNED_URL });
    renderAvatar();

    expect(avatarImage()).toBeInTheDocument();
    expect(fallbackIcon()).not.toBeInTheDocument();
  });

  it("shows a new URL for the same user rather than staying on the fallback", () => {
    // Why the failure is stored as the URL and not a boolean. The hook hands
    // back a fresh URL after a re-upload or a refetch, and a latched boolean
    // would hold the fallback over a picture that loads perfectly well.
    hookReturns({ profileImageUrl: SIGNED_URL });
    const { rerender } = renderAvatar();

    fireEvent.error(avatarImage()!);
    expect(fallbackIcon()).toBeInTheDocument();

    hookReturns({ profileImageUrl: OTHER_URL });
    rerender(
      <ProfileAvatar
        alt="Alex's Profile Image"
        width={56}
        height={56}
        placeholderClassName="avatar-placeholder"
        imageClassName="avatar-image"
        fallbackClassName="avatar-fallback"
      />,
    );

    expect(avatarImage()).toBeInTheDocument();
    expect(fallbackIcon()).not.toBeInTheDocument();
  });

  it("keeps the fallback while the failed URL is the one on offer", () => {
    // The other side of the comparison: a re-render that changes nothing must
    // not undo the downgrade, or the broken image returns on every render.
    hookReturns({ profileImageUrl: SIGNED_URL });
    const { rerender } = renderAvatar();

    fireEvent.error(avatarImage()!);

    rerender(
      <ProfileAvatar
        alt="Alex's Profile Image"
        width={56}
        height={56}
        placeholderClassName="avatar-placeholder"
        imageClassName="avatar-image"
        fallbackClassName="avatar-fallback"
      />,
    );

    expect(fallbackIcon()).toBeInTheDocument();
    expect(avatarImage()).not.toBeInTheDocument();
  });
});

describe("what it asks the hook for", () => {
  it("passes the user through, so a card draws the other user's picture", () => {
    renderAvatar({ userId: "user-123" });

    expect(profileImageSpies().useProfileImage).toHaveBeenCalledWith(
      "user-123",
      { enabled: undefined },
    );
  });

  it("forwards `enabled`, so a caller that draws nothing pays for nothing", () => {
    renderAvatar({ userId: "user-123", enabled: false });

    expect(profileImageSpies().useProfileImage).toHaveBeenCalledWith(
      "user-123",
      { enabled: false },
    );
  });

  it("asks for the signed-in user when given no id", () => {
    renderAvatar();

    expect(profileImageSpies().useProfileImage).toHaveBeenCalledWith(
      undefined,
      {
        enabled: undefined,
      },
    );
  });
});
