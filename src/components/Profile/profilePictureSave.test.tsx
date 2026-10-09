/**
 * Which picture operation `/profile`'s Save actually performs, and what it does
 * when that operation fails.
 *
 * The page now holds one slot - a cropped `File`, the removal marker, or
 * nothing - and the save handler branches on it. A branch is exactly the shape
 * that passes review while doing the wrong thing: an upload and a removal both
 * "save the picture", both clear the pending state, both end in a success
 * toast, and the only observable difference is which call was made. So this
 * file asserts the calls, each paired with the negative assertion that the
 * other one was *not* made - without which a handler that ran both would look
 * identical to one that chose correctly.
 *
 * **The failure half is the reason this is a separate suite rather than two
 * more cases in `ProfilePicture.test.tsx`.** Whether a refused removal keeps
 * the change pending is a property of the page, not the component: the
 * component only hands a value up. And it is the property that decides whether
 * the user can retry - a handler that cleared the pending state in a `finally`
 * would report a warning and then make the second press of Save do nothing at
 * all, with the picture still there.
 *
 * Modelled on `profileSaveAndContinue.test.tsx`, which this borrows its stub
 * layout and its VIEWER fixture from, and co-located here for the same reason:
 * a test file under `src/pages/` is also a route.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PendingPicture } from "../../utils/profile/pendingPicture";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.me": { query: async () => VIEWER_USER },
    "user.edit": { mutation: async () => ({}) },
    // Utils-only: the save path invalidates both and neither is the subject.
    "user.recommendations.me": {},
    "mapbox.geoJsonUserList": {},
  }),
);

jest.mock("../../utils/mixpanel", () => ({
  trackProfileCompletion: jest.fn(),
}));

/**
 * The two picture hooks, as spies rather than as inert stubs.
 *
 * Declared with `var` so the hoisted factories below can close over them: a
 * `const` would be in its temporal dead zone when `jest.mock`'s factory runs.
 */
var uploadFile: jest.Mock; // eslint-disable-line no-var
var removeProfilePicture: jest.Mock; // eslint-disable-line no-var

jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({
    uploadFile: (...args: unknown[]) => uploadFile(...args),
  }),
}));
jest.mock("../../utils/profile/useRemoveProfilePicture", () => ({
  useRemoveProfilePicture: () => ({
    removeProfilePicture: (...args: unknown[]) => removeProfilePicture(...args),
  }),
}));

jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: { center: [0, 0], street: "", city: "", state: "" },
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));

jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => null,
}));

/**
 * `UserSection` reduced to the three things this suite drives: setting each
 * pending state, submitting, and reading the pending state back.
 *
 * The real component is replaced rather than driven because what is under test
 * is the page's save handler. `ProfilePicture.test.tsx` covers the other side -
 * that a click produces the right value - so between them the two suites cover
 * the handoff without either having to render both halves.
 */
jest.mock("../../components/Profile/UserSection", () => ({
  __esModule: true,
  default: (props: {
    pendingPicture: PendingPicture;
    onPendingPictureChange: (next: PendingPicture) => void;
    onSubmit: () => void;
  }) => (
    <>
      <button onClick={() => props.onPendingPictureChange("remove")}>
        Mark removal
      </button>
      <button
        onClick={() =>
          props.onPendingPictureChange(
            new File(["cropped"], "cropped-image.jpeg", { type: "image/jpeg" }),
          )
        }
      >
        Mark upload
      </button>
      <button onClick={() => void props.onSubmit()}>Save</button>
      {/* The pending state as a word, so a failure that keeps it is
          distinguishable from a success that clears it. */}
      <span data-testid="pending">
        {props.pendingPicture === null
          ? "none"
          : props.pendingPicture === "remove"
            ? "remove"
            : "file"}
      </span>
    </>
  ),
}));
jest.mock("../../components/Profile/CarpoolSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/AccountSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/BlockedUsersSection", () => ({
  __esModule: true,
  default: () => null,
}));

import { toast } from "react-toastify/unstyled";
import Profile from "../../pages/profile/index";

/**
 * A VIEWER, because neither the schema's co-op date rules nor the address
 * guard apply to one - so Save reaches the picture branch without this file
 * having to satisfy either.
 */
const VIEWER_USER = {
  role: "VIEWER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: "Sam",
  pronouns: "",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  bio: "",
  startCoordLng: 0,
  startCoordLat: 0,
  companyCoordLng: 0,
  companyCoordLat: 0,
};

const renderProfile = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: {} },
        })
      }
    >
      <Profile />
    </QueryClientProvider>,
  );

/** Waits for `user.me` to land, so the form is populated before Save runs. */
const renderLoadedProfile = async () => {
  renderProfile();
  await screen.findByTestId("pending");
  await waitFor(() =>
    expect(screen.getByTestId("pending")).toHaveTextContent("none"),
  );
};

const pendingState = () => screen.getByTestId("pending").textContent;

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  jest.clearAllMocks();
  uploadFile = jest.fn(async () => undefined);
  removeProfilePicture = jest.fn(async () => undefined);
});

describe("/profile Save, with a picture change pending", () => {
  it("removes, and does not upload, when a removal is pending", async () => {
    await renderLoadedProfile();

    fireEvent.click(screen.getByRole("button", { name: "Mark removal" }));
    save();

    await waitFor(() => expect(removeProfilePicture).toHaveBeenCalledTimes(1));
    // The half that makes the assertion above mean something: a handler that
    // ran both branches would satisfy it just as well.
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("uploads, and does not remove, when a file is pending", async () => {
    await renderLoadedProfile();

    fireEvent.click(screen.getByRole("button", { name: "Mark upload" }));
    save();

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    // The one that would actually destroy something: a branch falling through
    // to the removal after an upload would delete the picture it just stored.
    expect(removeProfilePicture).not.toHaveBeenCalled();
  });

  it("does neither when nothing is pending", async () => {
    // The control for both tests above. Saving an ordinary profile edit must
    // not touch the picture at all.
    await renderLoadedProfile();

    save();

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(uploadFile).not.toHaveBeenCalled();
    expect(removeProfilePicture).not.toHaveBeenCalled();
  });

  it("clears the pending removal once it succeeds", async () => {
    await renderLoadedProfile();

    fireEvent.click(screen.getByRole("button", { name: "Mark removal" }));
    expect(pendingState()).toBe("remove");
    save();

    // Save Changes leaves the user on this page, so a pending state left set
    // would arm the unsaved-changes modal against a removal that has already
    // happened, and a second press would repeat it.
    await waitFor(() => expect(pendingState()).toBe("none"));
    expect(toast.success).toHaveBeenCalled();
  });

  describe("when the removal fails", () => {
    /** The page logs the rejection, which is expected here rather than noise. */
    let logged: jest.SpyInstance;

    beforeEach(() => {
      logged = jest.spyOn(console, "error").mockImplementation(() => {});
      removeProfilePicture = jest.fn(async () => {
        throw new Error("Refused");
      });
    });

    afterEach(() => {
      logged.mockRestore();
    });

    it("keeps the removal pending so it can be retried", async () => {
      await renderLoadedProfile();

      fireEvent.click(screen.getByRole("button", { name: "Mark removal" }));
      save();

      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      // Clearing it here - in a `finally`, say - would leave the user warned
      // that the picture is still there and a Save button that then does
      // nothing about it.
      expect(pendingState()).toBe("remove");
    });

    it("still saves the rest of the profile, and says which half failed", async () => {
      await renderLoadedProfile();

      fireEvent.click(screen.getByRole("button", { name: "Mark removal" }));
      save();

      await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
      // Not the upload wording. The same toast for both branches told a user
      // who pressed Remove that their picture "could not be uploaded", which
      // describes something they never asked for.
      const message = (toast.warning as jest.Mock).mock.calls[0][0] as string;
      expect(message).toContain("could not be removed");
      // The profile fields are saved either way, which is what makes this a
      // warning rather than an error.
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
