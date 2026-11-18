/**
 * `/profile` asks before saving a schedule whose end is at or before its start
 * (SCRUM-732), and asks about nothing else.
 *
 * **Why it asks.** A wrong AM or PM on either end moves it twelve hours, which
 * turns a day shift into one that ends the next day. `onboardSchema` accepts
 * that pair on purpose - night shifts are real - so the only place left to
 * catch a mis-pick is a question at save time, answered by the one person who
 * knows.
 *
 * **What it must not do.** Block a real night shift, ask about a stored
 * schedule nobody touched, or rewrite one: a save beside an untouched schedule
 * sends the stored times back unchanged.
 *
 * **The real page, the real save path and the real pickers.** `updateUser` and
 * `useEditUserMutation` run for real against a stubbed `user.edit`, so what is
 * asserted is the exact request the page sends. The stub does not feed the
 * save back into `user.me`: this harness's `useUtils().refetch` is inert, so
 * the page keeps the row it loaded. The write/read cycle through `TIME(0)` is
 * pinned in `SelectTimeRange.test.tsx` instead. `CarpoolSection` is a stub
 * around the real `SelectTimeRange`, whose antd panels are clicked cell by
 * cell. Not co-located, because a test file under `src/pages/` is also a
 * route.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Control, UseFormRegister } from "react-hook-form";
import type { OnboardingFormInputs } from "../../utils/types";
import {
  installResizeObserverStub,
  pickTime,
} from "../../testing/timePickerDriver";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

// Opened on the Carpool tab, where the pickers are.
jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock({
    query: { tab: "carpool" },
  }),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

type EditInput = { startTime?: string | null; endTime?: string | null };

/** Set per test: whether the server accepts the save. */
let refuseNextSave = false;
// The input is only recorded; `toMatchObject` on `mock.calls` reads it.
const editFn = jest.fn(async (_input: EditInput) => {
  if (refuseNextSave) {
    refuseNextSave = false;
    throw new Error("Refused");
  }
  return {};
});

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.me": { query: async () => storedUser },
    "user.edit": { mutation: (input: EditInput) => editFn(input) },
    "user.recommendations.me": {},
    "user.recommendations.riderDemand": { inertQuery: true },
    "mapbox.geoJsonUserList": {},
  }),
);

jest.mock("../../utils/mixpanel", () => ({
  trackProfileCompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/profile/useRemoveProfilePicture", () => ({
  useRemoveProfilePicture: () => ({ removeProfilePicture: jest.fn() }),
}));
// Resolved coordinates, so the page's unresolved-address guard lets a RIDER's
// save through and the schedule question is the only thing in its way.
jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: {
      center: [-71.0892, 42.3398],
      street: "",
      city: "",
      state: "",
    },
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));

const proceed = jest.fn();
jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: (props: {
    checkChanges: (proceed: () => void) => Promise<void>;
  }) => <button onClick={() => void props.checkChanges(proceed)}>Leave</button>,
}));
jest.mock("../../components/Profile/UserSection", () => ({
  __esModule: true,
  default: (props: {
    register: UseFormRegister<OnboardingFormInputs>;
    onSubmit: () => void;
  }) => (
    <>
      <input aria-label="Preferred name" {...props.register("preferredName")} />
      <button type="button" onClick={() => props.onSubmit()}>
        Save user
      </button>
    </>
  ),
}));
jest.mock("../../components/Profile/CarpoolSection", () => {
  // Required here, when the factory runs, rather than inside the component:
  // loading it during a render creates its styled components mid-render.
  const SelectTimeRange = jest.requireActual(
    "../Schedule/SelectTimeRange",
  ).default;

  return {
    __esModule: true,
    default: (props: {
      control: Control<OnboardingFormInputs>;
      onSubmit: () => void;
    }) => (
      <>
        <SelectTimeRange control={props.control} />
        <button type="button" onClick={() => props.onSubmit()}>
          Save carpool
        </button>
      </>
    ),
  };
});
jest.mock("../../components/Profile/AccountSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/BlockedUsersSection", () => ({
  __esModule: true,
  default: () => null,
}));

import Profile from "../../pages/profile/index";

installResizeObserverStub();

const storedAt = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));
const iso = (utcHour: number) => storedAt(utcHour).toISOString();

/** A complete RIDER, stored 9:00 AM to 5:00 PM unless a test says otherwise. */
const RIDER = {
  role: "RIDER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "Acme",
  companyAddress: "1 Main St, Boston, MA",
  startAddress: "360 Huntington Ave, Boston, MA",
  preferredName: "Sam",
  pronouns: "",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: storedAt(14) as Date | null,
  endTime: storedAt(22) as Date | null,
  coopStartDate: new Date(2026, 8, 1),
  coopEndDate: new Date(2026, 11, 18),
  bio: "",
  startCoordLng: -71.0892,
  startCoordLat: 42.3398,
  companyCoordLng: -71.0589,
  companyCoordLat: 42.3601,
};
let storedUser = { ...RIDER };

const renderProfile = async () => {
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
  await screen.findByRole("button", { name: "Save carpool" });
};

const startInput = () => screen.getByLabelText(/Start Time/);
const endInput = () => screen.getByLabelText(/End Time/);
const saveCarpool = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save carpool" }));
const overnightQuestion = () =>
  screen.queryByRole("dialog", { name: "Does your shift run overnight?" });

/** The save finished: the page is back from its spinner with the form. */
const afterSave = () => screen.findByRole("button", { name: "Save carpool" });

beforeEach(() => {
  jest.clearAllMocks();
  refuseNextSave = false;
  storedUser = { ...RIDER };
});

describe("/profile, a schedule that ends at or before it starts", () => {
  it("asks before saving 9:00 AM to 5:00 AM, and saves nothing meanwhile", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    saveCarpool();

    const question = await screen.findByRole("dialog", {
      name: "Does your shift run overnight?",
    });
    expect(question).toHaveTextContent(
      "Your schedule is 9:00 AM to 5:00 AM, so it ends the next day, 20 hours after it starts.",
    );
    expect(editFn).not.toHaveBeenCalled();
  });

  it("saves nothing on Change times, and leaves the picked times to fix", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    saveCarpool();

    fireEvent.click(
      await screen.findByRole("button", { name: "Change times" }),
    );

    await waitFor(() => expect(overnightQuestion()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(endInput()).toHaveValue("5:00 AM");
  });

  it("treats Escape as Change times", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    saveCarpool();

    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(overnightQuestion()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
  });

  it("puts the safe answer under the keyboard: Change times has focus", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    saveCarpool();

    await screen.findByRole("dialog");

    expect(screen.getByRole("button", { name: "Change times" })).toHaveFocus();
  });

  it("is answerable from the keyboard alone, and hands focus back to Save", async () => {
    const user = userEvent.setup();
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    // A real click, so focus moves to Save the way it does in a browser.
    await user.click(screen.getByRole("button", { name: "Save carpool" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(overnightQuestion()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save carpool" }),
      ).toHaveFocus(),
    );
  });

  it("keeps the schedule from the keyboard by tabbing to Keep overnight", async () => {
    const user = userEvent.setup();
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    await user.click(screen.getByRole("button", { name: "Save carpool" }));
    await screen.findByRole("dialog");

    // Focus is trapped in the dialog, so Shift+Tab from Change times reaches
    // the button before it rather than leaving the dialog.
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(
      screen.getByRole("button", { name: "Keep overnight" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
  });

  it("saves the pair exactly as picked once the user keeps it", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    saveCarpool();

    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(14),
      endTime: iso(10),
    });
  });

  it("asks about a real night shift once, saves it as picked, and does not ask again on the next save", async () => {
    await renderProfile();
    await pickTime(startInput(), { hour: "10", meridiem: "PM" });
    await pickTime(endInput(), { hour: "06", meridiem: "AM" });
    saveCarpool();

    const question = await screen.findByRole("dialog", {
      name: "Does your shift run overnight?",
    });
    expect(question).toHaveTextContent("8 hours after it starts");
    fireEvent.click(screen.getByRole("button", { name: "Keep overnight" }));
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(3),
      endTime: iso(11),
    });

    // Back from the save, still showing what was kept.
    await afterSave();
    await waitFor(() => expect(startInput()).toHaveValue("10:00 PM"));
    expect(endInput()).toHaveValue("6:00 AM");

    // The answer is remembered, so the next save does not ask again. In the
    // app the refetched row would also match by then; this harness's
    // `useUtils().refetch` is inert, so it is the remembered answer alone that
    // is proven here. Reopening a stored night shift is the "unrelated edit"
    // case below.
    saveCarpool();
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(2));
    expect(overnightQuestion()).not.toBeInTheDocument();
    expect(editFn.mock.calls[1]![0]).toMatchObject({
      startTime: iso(3),
      endTime: iso(11),
    });
  });

  it("does not ask again when a kept schedule's save is refused and retried", async () => {
    refuseNextSave = true;
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    saveCarpool();
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    await afterSave();

    saveCarpool();

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(2));
    expect(overnightQuestion()).not.toBeInTheDocument();
  });

  it("asks about equal start and end times as a 24-hour shift", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "09", meridiem: "AM" });
    saveCarpool();

    const question = await screen.findByRole("dialog", {
      name: "Is this a 24-hour shift?",
    });
    expect(question).toHaveTextContent(
      "Your schedule starts and ends at 9:00 AM, so it is 24 hours long.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep 24 hours" }));
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(14),
      endTime: iso(14),
    });
  });

  it("asks on the unsaved-changes modal's Save and Continue too, and leaves only once kept", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and Continue" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(editFn).toHaveBeenCalledTimes(1);
  });

  it("does not leave on Save and Continue when the user changes the times instead", async () => {
    await renderProfile();
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and Continue" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Change times" }),
    );

    await waitFor(() => expect(overnightQuestion()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });
});

describe("/profile, everything else saves without a question", () => {
  it("saves a same-day change with no extra step", async () => {
    await renderProfile();

    await pickTime(endInput(), { hour: "04" });
    expect(endInput()).toHaveValue("4:00 PM");
    saveCarpool();

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(overnightQuestion()).not.toBeInTheDocument();
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(14),
      endTime: iso(21),
    });
  });

  it("saves an evening shift that ends before midnight with no extra step", async () => {
    await renderProfile();

    await pickTime(startInput(), { hour: "08", meridiem: "PM" });
    await pickTime(endInput(), { hour: "11", meridiem: "PM" });
    saveCarpool();

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(overnightQuestion()).not.toBeInTheDocument();
  });

  it.each([
    ["a night shift", 3, 11],
    // Shown today as 9:00 PM to 5:00 AM: a legacy-era value nobody should be
    // asked about while editing their name.
    ["a legacy value that reads as overnight", 2, 10],
  ])(
    "saves an unrelated edit beside a stored %s without asking, and sends it back unchanged",
    async (_label, startHour, endHour) => {
      storedUser = {
        ...RIDER,
        startTime: storedAt(startHour),
        endTime: storedAt(endHour),
      };
      await renderProfile();
      fireEvent.click(screen.getByRole("button", { name: /User Profile/ }));
      const name = await screen.findByLabelText("Preferred name");
      fireEvent.change(name, { target: { value: "Samantha" } });

      fireEvent.click(screen.getByRole("button", { name: "Save user" }));

      await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
      expect(overnightQuestion()).not.toBeInTheDocument();
      expect(editFn.mock.calls[0]![0]).toMatchObject({
        preferredName: "Samantha",
        startTime: iso(startHour),
        endTime: iso(endHour),
      });
    },
  );
});
