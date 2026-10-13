/**
 * What `DropDownMenu`'s trigger is called, in each of the three states its
 * avatar can be in.
 *
 * The trigger is the desktop header's only route to Profile, Feedback and Sign
 * Out, and its only child is a `ProfileAvatar`. That avatar renders one of
 * three things - a bare placeholder `div` while the presigned URL resolves, an
 * `AiOutlineUser` when there is no picture, and an `Image` when there is - and
 * only the last of those carries any text, because `alt` is forwarded to
 * `next/image` and nowhere else. So a name taken from the avatar's content
 * exists on one branch out of three, and the two it is missing from are the
 * ordinary ones: most accounts have no picture at all. SCRUM-672.
 *
 * **The fallback branch is the test that means something.** A suite covering
 * only the loaded branch would have passed against the code before the fix,
 * since `alt` reached the DOM there, and proved nothing about the state a
 * screen reader actually meets. Each case below therefore names the branch it
 * puts the hook in, and `the three branches` covers all of them rather than
 * the convenient one.
 *
 * *What this does not cover:* how a screen reader renders the name. jsdom
 * computes no accessibility tree of its own - testing-library's `name` filter
 * is `dom-accessibility-api`'s implementation of the spec, which is a close
 * model of what AT would compute but not a recording of one.
 */

import { render, screen } from "@testing-library/react";
import DropDownMenu from "./DropDownMenu";
import { profileImageSpies } from "../testing/profileImageStub";

/**
 * `DropDownMenu` pushes `/profile` from its Profile button. Nothing here
 * presses it, but `useRouter` must return an object either way.
 */
jest.mock("next/router", () =>
  require("../testing/nextRouterStub").buildRouterMock({
    pathname: "/",
    query: {},
  }),
);

/**
 * The signed-in session the menu body reads its name and email from. The
 * trigger renders regardless, but `Menu.Items` is gated on `session?.user`,
 * so an unauthenticated stub would leave the menu with a trigger and nothing
 * behind it - a different component from the one under test.
 */
jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock({
    user: { name: "Alex Rider", email: "rider.a@northeastern.edu" },
  }),
);

/**
 * The avatar's presigned-URL query, stubbed at the hook rather than at `trpc`.
 *
 * The three branches are properties of what the hook returns, and driving them
 * through a real React Query would mean resolving a query differently per test
 * for no gain: nothing here asserts on the request itself. `Header.test.tsx`
 * is where that query's firing is pinned.
 */
jest.mock("../utils/useProfileImage", () =>
  require("../testing/profileImageStub").buildProfileImageMock(),
);

const SIGNED_URL = "https://bucket.s3.amazonaws.com/profile/alex?sig=abc";

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

/**
 * The trigger, selected by something other than its name.
 *
 * `aria-expanded="false"` is what Headless UI puts on the closed `Menu.Button`
 * and nothing else here carries. Elsewhere that filter was a workaround for
 * the missing name; here it is the point - a `toHaveAccessibleName` assertion
 * against an element found *by* its name proves nothing, so the element has to
 * be identified structurally first.
 */
const trigger = () => screen.getByRole("button", { expanded: false });

beforeEach(() => {
  hookReturns({});
});

describe("the menu trigger's accessible name", () => {
  /**
   * The three states `ProfileAvatar` can be in, by what it renders rather than
   * by hook field, since that is what decides whether any text exists.
   */
  const BRANCHES: [string, Parameters<typeof hookReturns>[0]][] = [
    ["the placeholder, while the URL is still resolving", { isLoading: true }],
    [
      "the fallback icon, when the user has no picture",
      { profileImageUrl: null },
    ],
    ["the picture, when there is one", { profileImageUrl: SIGNED_URL }],
  ];

  it.each(BRANCHES)("is present while the avatar shows %s", (_, result) => {
    hookReturns(result);
    render(<DropDownMenu />);

    expect(
      screen.getByRole("button", { name: "Account menu" }),
    ).toBeInTheDocument();
  });

  it("does not come from the avatar's `alt`", () => {
    // The assertion that would have failed before the fix and the one that
    // keeps it: on the fallback branch there is no `alt` in the DOM to borrow,
    // so a name here can only be the button's own. Both halves are needed -
    // the positive above would pass against a trigger that went back to
    // depending on `alt`, as long as some test happened to load a picture.
    hookReturns({ profileImageUrl: null });
    render(<DropDownMenu />);

    expect(trigger()).toHaveAccessibleName("Account menu");
    expect(
      screen.queryByRole("button", { name: "Profile Image" }),
    ).not.toBeInTheDocument();
  });

  it("names what the control opens, not the picture inside it", () => {
    // The loaded branch is where an `alt`-derived name would still exist, and
    // where it would describe the wrong thing: the button opens a menu, it is
    // not an image. The name must win over the `Image` it wraps.
    hookReturns({ profileImageUrl: SIGNED_URL });
    render(<DropDownMenu />);

    expect(trigger()).toHaveAccessibleName("Account menu");
  });
});
