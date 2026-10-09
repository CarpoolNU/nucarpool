/**
 * The profile page's unsaved-changes modal, reached from the router rather
 * than from a control that remembered to ask.
 *
 * `useUnsavedChangesGuard.test.tsx` covers the hook's three listeners in
 * isolation. This file is about the wiring: that the real page arms the guard
 * from the same `hasProfileChanges` its modal already used, that the
 * destination survives the modal, and that all three answers reach the right
 * end state. **The real page, the real modal, the real save path** - only the
 * section components and the network are stubbed, so `hasProfileChanges`,
 * `proceedRef` and `onSubmit` are the shipping ones.
 *
 * ---
 *
 * **What the suite cannot show.** Two of the three exits are asserted one
 * level below the browser behaviour they stand for, and neither gap is
 * closeable in jsdom:
 *
 * 1. A `next/link` click is driven here by emitting `routeChangeStart`. The
 *    step this skips - that `Link` reaches that event at all - is
 *    `next/dist/client/link.js:110` calling `router.push`, which emits it at
 *    `shared/lib/router/router.js:844`. The router is stubbed, so clicking a
 *    real `Link` in this suite would call a `jest.fn` and emit nothing; a test
 *    written that way would pass while proving less.
 * 2. `beforeunload` is dispatched as an event and the assertion is that the
 *    handler calls `preventDefault`. jsdom does not run the unload flow, so
 *    nothing here observes a browser actually prompting.
 *
 * Per `docs/testing.md`, that makes a green run evidence about the page's
 * handlers, not about Chrome.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UseFormRegister } from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";
import { PendingPicture } from "../../utils/profile/pendingPicture";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock({
    pathname: "/profile",
    asPath: "/profile",
  }),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

/** The name the test types, and the name the server is pretending to hold. */
const EDITED_NAME = "Samantha";
const STORED_NAME = "Sam";

/**
 * The server's copy of the one field this suite edits.
 *
 * It has to be mutable, and the reason is the whole of the "no prompt after a
 * successful save" case. `updateUser`'s `onSuccess` calls
 * `utils.user.me.refetch()`, and the page resets the form from whatever comes
 * back - so a `user.me` pinned to the old value leaves the form reading
 * `Samantha` against a stored `Sam` and the page is still, correctly, dirty.
 * Asserting "no prompt" against that stub would have been asserting that the
 * guard ignores a real unsaved change.
 */
let storedPreferredName = STORED_NAME;

/** Set per test: what the server does with the save. */
const commitTheEdit = async () => {
  storedPreferredName = EDITED_NAME;
  return {};
};
let editBehaviour: () => Promise<unknown> = commitTheEdit;
const editFn = jest.fn(() => editBehaviour());

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.me": {
      query: async () => ({
        ...VIEWER_USER,
        preferredName: storedPreferredName,
      }),
      // `useUtils()` hands back spies that resolve and do nothing, so the
      // `utils.user.me.refetch()` in `updateUser`'s `onSuccess` would never
      // re-read the stub - and the page would go on comparing the edited form
      // against the pre-save value, which is dirty forever. `trpcHarness`
      // documents this declaration as the way to reach the live cache.
      refetch: (queryClient: import("@tanstack/react-query").QueryClient) =>
        queryClient.refetchQueries(),
    },
    "user.edit": { mutation: () => editFn() },
    "user.recommendations.me": {},
    "mapbox.geoJsonUserList": {},
  }),
);

jest.mock("../../utils/mixpanel", () => ({
  trackProfileCompletion: jest.fn(),
}));

const uploadFile = jest.fn();
const removeProfilePicture = jest.fn();
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: () => uploadFile() }),
}));
jest.mock("../../utils/profile/useRemoveProfilePicture", () => ({
  useRemoveProfilePicture: () => ({
    removeProfilePicture: () => removeProfilePicture(),
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

/**
 * One real field, so the edit is a genuine form change the real
 * `hasProfileChanges` sees, plus the one control that queues a picture
 * removal - the unsaved change that is not a form field at all.
 */
jest.mock("../../components/Profile/UserSection", () => ({
  __esModule: true,
  default: (props: {
    register: UseFormRegister<OnboardingFormInputs>;
    onPendingPictureChange: (pending: PendingPicture) => void;
  }) => (
    <>
      <input aria-label="Preferred name" {...props.register("preferredName")} />
      <button onClick={() => props.onPendingPictureChange("remove")}>
        Remove Picture
      </button>
    </>
  ),
}));
jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => null,
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

import { resetRouterSpies, routerSpies } from "../../testing/nextRouterStub";
import { ROUTE_CHANGE_ABORTED } from "../../utils/profile/useUnsavedChangesGuard";
import Profile from "../../pages/profile/index";

/** A VIEWER, so neither the co-op date rules nor the address guard apply. */
const VIEWER_USER = {
  role: "VIEWER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: STORED_NAME,
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

/** Waits for the form to hold the stored value, then edits it. */
const editPreferredName = async () => {
  const field = await screen.findByLabelText("Preferred name");
  await waitFor(() => expect(field).toHaveValue(STORED_NAME));
  fireEvent.change(field, { target: { value: EDITED_NAME } });
};

/** What a `next/link` click or a `router.push` does, as the page sees it. */
const navigateTo = (url: string): { aborted: boolean } => {
  try {
    routerSpies().events.emit("routeChangeStart", url);
    return { aborted: false };
  } catch (error) {
    expect(error).toBe(ROUTE_CHANGE_ABORTED);
    return { aborted: true };
  }
};

const beforeUnload = (): boolean => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

const clickModal = async (name: string) =>
  fireEvent.click(await screen.findByRole("button", { name }));

beforeEach(() => {
  resetRouterSpies();
  storedPreferredName = STORED_NAME;
  editBehaviour = commitTheEdit;
  editFn.mockClear();
  uploadFile.mockClear();
  removeProfilePicture.mockClear();
});

describe("/profile unsaved changes: intercepting a navigation", () => {
  it("offers the modal instead of following a link away", async () => {
    renderProfile();
    await editPreferredName();

    expect(navigateTo("/safety").aborted).toBe(true);
    expect(
      await screen.findByText("You have unsaved changes!"),
    ).toBeInTheDocument();
  });

  it("follows the link untouched when nothing has been edited", async () => {
    renderProfile();
    await screen.findByLabelText("Preferred name");

    expect(navigateTo("/safety").aborted).toBe(false);
    expect(
      screen.queryByText("You have unsaved changes!"),
    ).not.toBeInTheDocument();
  });

  it("treats a queued picture removal as an unsaved change", async () => {
    renderProfile();
    await screen.findByLabelText("Preferred name");
    fireEvent.click(screen.getByRole("button", { name: "Remove Picture" }));

    expect(navigateTo("/safety").aborted).toBe(true);
    expect(
      await screen.findByText("You have unsaved changes!"),
    ).toBeInTheDocument();
  });
});

describe("/profile unsaved changes: answering the modal", () => {
  it("keeps the user on the page, with their edit, on dismiss", async () => {
    renderProfile();
    await editPreferredName();
    navigateTo("/safety");

    await clickModal("Close");

    await waitFor(() =>
      expect(
        screen.queryByText("You have unsaved changes!"),
      ).not.toBeInTheDocument(),
    );
    expect(routerSpies().push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Preferred name")).toHaveValue(EDITED_NAME);
  });

  it("discards to the intercepted destination, not the map fallback", async () => {
    renderProfile();
    await editPreferredName();
    navigateTo("/safety");

    await clickModal("Continue");

    await waitFor(() =>
      expect(routerSpies().push).toHaveBeenCalledWith("/safety"),
    );
    expect(editFn).not.toHaveBeenCalled();
  });

  it("does not remove the stored picture when a removal is discarded", async () => {
    renderProfile();
    await screen.findByLabelText("Preferred name");
    fireEvent.click(screen.getByRole("button", { name: "Remove Picture" }));
    navigateTo("/safety");

    await clickModal("Continue");

    await waitFor(() =>
      expect(routerSpies().push).toHaveBeenCalledWith("/safety"),
    );
    expect(removeProfilePicture).not.toHaveBeenCalled();
  });

  it("saves and then reaches the intercepted destination", async () => {
    renderProfile();
    await editPreferredName();
    navigateTo("/safety");

    await clickModal("Save and Continue");

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(routerSpies().push).toHaveBeenCalledWith("/safety"),
    );
  });

  it("stays put and keeps the edit when the save is refused", async () => {
    editBehaviour = async () => {
      throw new Error("nope");
    };
    renderProfile();
    await editPreferredName();
    navigateTo("/safety");

    await clickModal("Save and Continue");

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(routerSpies().push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Preferred name")).toHaveValue(EDITED_NAME);
    // Still dirty, so the guard is still armed.
    expect(navigateTo("/safety").aborted).toBe(true);
  });
});

describe("/profile unsaved changes: refresh and tab close", () => {
  it("asks the browser to confirm once an edit is pending", async () => {
    renderProfile();
    await editPreferredName();

    expect(beforeUnload()).toBe(true);
  });

  it("does not before anything has been edited", async () => {
    renderProfile();
    await screen.findByLabelText("Preferred name");

    expect(beforeUnload()).toBe(false);
  });

  it("does not once the edit has been saved", async () => {
    renderProfile();
    await editPreferredName();
    navigateTo("/safety");

    await clickModal("Save and Continue");
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));

    // The page is left behind after a successful save, but nothing has
    // unmounted it here - so the handler is still live and must now be quiet.
    await waitFor(() => expect(beforeUnload()).toBe(false));
  });
});
