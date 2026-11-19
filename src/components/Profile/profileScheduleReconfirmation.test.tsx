/**
 * `/profile` asks the owner of a stored schedule that may hold a wrong AM or
 * PM to confirm it, once, and never writes it (SCRUM-733).
 *
 * **The real page, the real save path and the real pickers**, the harness
 * `profileOvernightSchedule.test.tsx` established. `updateUser` and
 * `useEditUserMutation` run for real against a stubbed `user.edit`, so a
 * correction is asserted as the exact request the page sends, and "never
 * writes" is asserted as no request at all. `CarpoolSection` is a stub around
 * the real `SelectTimeRange`, whose antd panels are clicked cell by cell. The
 * notice's answers are read back from real jsdom `localStorage`.
 *
 * This harness's `useUtils().refetch` is inert, so a save never re-seeds
 * `user.me`. Where a test needs the page as it would look after a save
 * refetched it, it renders the page again on the saved row. That is what a
 * reload does, and a reload is exactly when the notice must not come back.
 *
 * Not co-located, because a test file under `src/pages/` is also a route.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Control, UseFormRegister } from "react-hook-form";
import { toast } from "react-toastify/unstyled";
import type { OnboardingFormInputs } from "../../utils/types";
import {
  installResizeObserverStub,
  pickTime,
} from "../../testing/timePickerDriver";
import { scheduleReconfirmationKey } from "../../utils/profile/useScheduleReconfirmationRecord";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

// Opened on the default tab, User Profile, so "Update my schedule" has
// somewhere to take the user.
jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock({ query: {} }),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

type EditInput = {
  startTime?: string | null;
  endTime?: string | null;
  preferredName?: string;
};

/** Set per test: whether the server refuses the next save. */
let refuseNextSave = false;
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
// Resolved coordinates, so the unresolved-address guard lets a RIDER's save
// through and nothing else stands between a correction and `user.edit`.
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

jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => null,
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
  // Required when the factory runs, not during a render: loading it then
  // creates its styled components mid-render.
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
jest.mock("../../components/Profile/PastConnectionsSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/BlockedUsersSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/SafetySection", () => ({
  __esModule: true,
  default: () => null,
}));

import Profile from "../../pages/profile/index";

installResizeObserverStub();

const storedAt = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));
const iso = (utcHour: number) => storedAt(utcHour).toISOString();

/**
 * A co-op that ends next year, whenever this runs, so no fixture expires.
 * The year ceiling is ten years out, so next year is always inside it.
 */
const NEXT_YEAR_END = new Date(
  Date.UTC(new Date().getUTCFullYear() + 1, 5, 30),
);

/**
 * A live RIDER whose stored schedule is 9:00 AM to 5:00 AM: stored `14:00` to
 * `10:00`, since Boston is UTC-5 at the anchor date.
 */
const MIS_PICKED = {
  id: "user-sam",
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
  endTime: storedAt(10) as Date | null,
  coopStartDate: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
  coopEndDate: NEXT_YEAR_END as Date | null,
  bio: "",
  startCoordLng: -71.0892,
  startCoordLat: 42.3398,
  companyCoordLng: -71.0589,
  companyCoordLat: 42.3601,
};
let storedUser: typeof MIS_PICKED = { ...MIS_PICKED };

const renderProfile = async () => {
  const view = render(
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
  await screen.findByRole("button", { name: /^Save (user|carpool)$/ });
  return view;
};

/** Unmount and load the page afresh: a reload, or the next visit. */
const reload = async () => {
  cleanup();
  await renderProfile();
};

const NOTICE = "Please confirm your work schedule";
const notice = () => screen.queryByRole("region", { name: NOTICE });
const findNotice = () => screen.findByRole("region", { name: NOTICE });
const button = (name: string) => screen.getByRole("button", { name });

/** This account's record: the one the page under test reads and writes. */
const KEY = scheduleReconfirmationKey(MIS_PICKED.id);

const storedRecord = () => {
  const raw = window.localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
};

/** A record confirming the stored 9:00 AM to 5:00 AM. */
const CONFIRMED_NINE_TO_FIVE = {
  confirmed: {
    startMinute: 540,
    endMinute: 300,
    confirmedAt: "2026-11-01T12:00:00.000Z",
  },
  snoozed: null,
};

/** Long enough for the effect that reads storage to have run. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

const startInput = () => screen.getByLabelText(/Start Time/);
const endInput = () => screen.getByLabelText(/End Time/);
const overnightQuestion = () =>
  screen.queryByRole("dialog", { name: "Does your shift run overnight?" });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  refuseNextSave = false;
  storedUser = { ...MIS_PICKED };
});

describe("who sees the notice", () => {
  it("shows a live RIDER their stored 9:00 AM to 5:00 AM exactly, and sends nothing", async () => {
    await renderProfile();

    const region = await findNotice();
    expect(region).toHaveTextContent(
      "Your saved schedule is 9:00 AM to 5:00 AM the next day (20 hours).",
    );
    expect(region).toHaveTextContent("Is this correct?");
    // It asks; it never says the schedule is wrong or what it should be.
    expect(region).not.toHaveTextContent("5:00 PM");
    expect(editFn).not.toHaveBeenCalled();
  });

  it.each([
    ["a same-day schedule", { startTime: storedAt(14), endTime: storedAt(22) }],
    [
      "a real 10:30 PM to 6:30 AM night shift",
      { startTime: storedAt(3, 30), endTime: storedAt(11, 30) },
    ],
    [
      "a legacy value that reads as an 8-hour overnight",
      { startTime: storedAt(2), endTime: storedAt(10) },
    ],
    ["a VIEWER", { role: "VIEWER" }],
    ["an INACTIVE user", { status: "INACTIVE" }],
    [
      "a co-op that has ended",
      { coopEndDate: new Date(Date.UTC(2025, 11, 31)) },
    ],
    ["no co-op end date", { coopEndDate: null }],
    ["no schedule", { startTime: null, endTime: null }],
  ])("shows nothing for %s", async (_label, overrides) => {
    storedUser = { ...MIS_PICKED, ...overrides } as typeof MIS_PICKED;
    await renderProfile();
    await settle();

    expect(notice()).not.toBeInTheDocument();
  });

  it("shows on the mobile layout too", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    try {
      await renderProfile();
      expect(await findNotice()).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
    }
  });
});

describe("Yes, these hours are correct", () => {
  it("removes the notice, sends nothing and leaves the schedule as it was", async () => {
    await renderProfile();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Yes, these hours are correct",
      }),
    );

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Thanks for confirming your schedule.",
    );

    fireEvent.click(screen.getByRole("button", { name: /Carpool/ }));
    expect(startInput()).toHaveValue("9:00 AM");
    expect(endInput()).toHaveValue("5:00 AM");
  });

  it("remembers which pair was confirmed, and when", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Yes, these hours are correct"));

    expect(storedRecord()).toEqual({
      confirmed: {
        startMinute: 540,
        endMinute: 300,
        confirmedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
      snoozed: null,
    });
  });

  it("does not ask again on the next visit", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Yes, these hours are correct"));
    await waitFor(() => expect(notice()).not.toBeInTheDocument());

    await reload();
    await settle();

    expect(notice()).not.toBeInTheDocument();
  });

  it("asks again once the stored schedule is a different mis-pick shape", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Yes, these hours are correct"));

    // Changed elsewhere, say on another device, to 8:00 AM to 4:00 AM.
    storedUser = {
      ...MIS_PICKED,
      startTime: storedAt(13),
      endTime: storedAt(9),
    };
    await reload();

    expect(await findNotice()).toHaveTextContent(
      "8:00 AM to 4:00 AM the next day (20 hours)",
    );
  });

  it("survives a double press: one answer, no request", async () => {
    await renderProfile();
    const yes = await screen.findByText("Yes, these hours are correct");

    fireEvent.click(yes);
    fireEvent.click(yes);

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(storedRecord().confirmed).toMatchObject({
      startMinute: 540,
      endMinute: 300,
    });
  });
});

describe("Remind me later", () => {
  it("removes the notice, sends nothing, and holds it back on the next visit", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Remind me later"));

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(storedRecord()).toMatchObject({
      confirmed: null,
      snoozed: { startMinute: 540, endMinute: 300 },
    });

    await reload();
    await settle();
    expect(notice()).not.toBeInTheDocument();
  });

  it("asks again once the snooze has run out", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        confirmed: null,
        snoozed: {
          startMinute: 540,
          endMinute: 300,
          snoozedUntil: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    );

    await renderProfile();

    expect(await findNotice()).toBeInTheDocument();
  });
});

describe("Update my schedule", () => {
  it("opens the Carpool tab with the notice still above the pickers, and sends nothing", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));

    expect(await screen.findByLabelText(/Start Time/)).toBeInTheDocument();
    const region = await findNotice();
    expect(region).toHaveTextContent(
      "If not, change your start or end time below and save.",
    );
    expect(
      screen.queryByRole("button", { name: "Update my schedule" }),
    ).not.toBeInTheDocument();
    expect(editFn).not.toHaveBeenCalled();
  });

  it("saves a same-day correction through the normal save, exactly as picked", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));

    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "05",
      meridiem: "PM",
    });
    fireEvent.click(button("Save carpool"));

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(overnightQuestion()).not.toBeInTheDocument();
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(14),
      endTime: iso(22),
    });

    // The next load holds the corrected row: nothing to ask about.
    storedUser = { ...MIS_PICKED, endTime: storedAt(22) };
    await reload();
    await settle();
    expect(notice()).not.toBeInTheDocument();
  });

  it("asks SCRUM-732's question about a new overnight pair, and a kept one is not asked about again", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));

    // 9:00 AM to 4:00 AM: still the shape this notice asks about.
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "04",
      meridiem: "AM",
    });
    fireEvent.click(button("Save carpool"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      startTime: iso(14),
      endTime: iso(9),
    });
    await waitFor(() =>
      expect(storedRecord()?.confirmed).toMatchObject({
        startMinute: 540,
        endMinute: 240,
      }),
    );

    storedUser = { ...MIS_PICKED, endTime: storedAt(9) };
    await reload();
    await settle();
    expect(notice()).not.toBeInTheDocument();
  });

  it("remembers nothing when the user changes their mind at SCRUM-732's question", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "04",
      meridiem: "AM",
    });
    fireEvent.click(button("Save carpool"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Change times" }),
    );

    await waitFor(() => expect(overnightQuestion()).not.toBeInTheDocument());
    expect(editFn).not.toHaveBeenCalled();
    expect(storedRecord()).toBeNull();
    expect(await findNotice()).toBeInTheDocument();
  });

  it("remembers nothing when the server refuses a kept overnight pair", async () => {
    refuseNextSave = true;
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "04",
      meridiem: "AM",
    });
    fireEvent.click(button("Save carpool"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Save carpool" });
    expect(storedRecord()).toBeNull();
    // Still asking about what is stored, which the refused save left alone.
    expect(await findNotice()).toHaveTextContent(
      "9:00 AM to 5:00 AM the next day (20 hours)",
    );
  });

  it("keeps an earlier confirmation of the stored pair when a kept new pair is refused", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(CONFIRMED_NINE_TO_FIVE));
    refuseNextSave = true;
    await renderProfile();
    await settle();
    expect(notice()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Carpool/ }));
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "04",
      meridiem: "AM",
    });
    fireEvent.click(button("Save carpool"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Save carpool" });
    expect(storedRecord()).toEqual(CONFIRMED_NINE_TO_FIVE);

    // The stored 9:00 AM to 5:00 AM is still confirmed on the next visit.
    await reload();
    await settle();
    expect(notice()).not.toBeInTheDocument();
  });

  it("records a kept pair when a retry of its refused save succeeds, without asking again", async () => {
    refuseNextSave = true;
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "04",
      meridiem: "AM",
    });
    fireEvent.click(button("Save carpool"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save carpool" }),
    );

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(2));
    expect(overnightQuestion()).not.toBeInTheDocument();
    await waitFor(() =>
      expect(storedRecord()?.confirmed).toMatchObject({
        startMinute: 540,
        endMinute: 240,
      }),
    );
  });

  it("keeps the notice when the server refuses the correction", async () => {
    refuseNextSave = true;
    await renderProfile();
    fireEvent.click(await screen.findByText("Update my schedule"));
    await pickTime(await screen.findByLabelText(/End Time/), {
      hour: "05",
      meridiem: "PM",
    });

    fireEvent.click(button("Save carpool"));

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Save carpool" });
    expect(await findNotice()).toBeInTheDocument();
    expect(storedRecord()).toBeNull();
  });
});

describe("an unrelated save beside the notice", () => {
  it("saves without a question and sends the stored schedule back unchanged", async () => {
    await renderProfile();
    await findNotice();

    fireEvent.change(screen.getByLabelText("Preferred name"), {
      target: { value: "Samantha" },
    });
    fireEvent.click(button("Save user"));

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(overnightQuestion()).not.toBeInTheDocument();
    expect(editFn.mock.calls[0]![0]).toMatchObject({
      preferredName: "Samantha",
      startTime: iso(14),
      endTime: iso(10),
    });
    // Saving something else is not an answer.
    await screen.findByRole("button", { name: "Save user" });
    expect(await findNotice()).toBeInTheDocument();
    expect(storedRecord()).toBeNull();
  });
});

describe("from the keyboard", () => {
  it("reaches the three answers in order and confirms with Enter", async () => {
    const user = userEvent.setup();
    await renderProfile();
    await findNotice();

    button("Yes, these hours are correct").focus();
    await user.tab();
    expect(button("Update my schedule")).toHaveFocus();
    await user.tab();
    expect(button("Remind me later")).toHaveFocus();

    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(button("Yes, these hours are correct")).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
    expect(storedRecord().confirmed).not.toBeNull();
  });

  it("moves focus to the heading after Update, never to the page or a picker", async () => {
    const user = userEvent.setup();
    await renderProfile();
    await findNotice();

    button("Update my schedule").focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: NOTICE })).toHaveFocus(),
    );
    // Tab from the heading reaches the remaining answers first.
    await user.tab();
    expect(button("Yes, these hours are correct")).toHaveFocus();
    await user.tab();
    expect(button("Remind me later")).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
    expect(storedRecord().snoozed).not.toBeNull();
  });
});

describe("two tabs", () => {
  it("leaves this tab when the other one answers", async () => {
    await renderProfile();
    await findNotice();

    // What the other tab's "Yes" writes, and the event this tab then gets.
    const written = JSON.stringify({
      confirmed: {
        startMinute: 540,
        endMinute: 300,
        confirmedAt: new Date().toISOString(),
      },
      snoozed: null,
    });
    window.localStorage.setItem(KEY, written);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: written,
        }),
      );
    });

    await waitFor(() => expect(notice()).not.toBeInTheDocument());
  });

  it("ignores another key's event", async () => {
    await renderProfile();
    await findNotice();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "something.else", newValue: "1" }),
      );
    });
    await settle();

    expect(notice()).toBeInTheDocument();
  });

  it("keeps the other tab's answer when this tab answers too", async () => {
    // This tab loads with the notice; another tab then snoozes a different
    // pair. Confirming here must not overwrite that snooze.
    await renderProfile();
    await findNotice();
    const otherTabSnooze = {
      startMinute: 480,
      endMinute: 240,
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ confirmed: null, snoozed: otherTabSnooze }),
    );

    fireEvent.click(button("Yes, these hours are correct"));

    expect(storedRecord()).toEqual({
      confirmed: expect.objectContaining({ startMinute: 540, endMinute: 300 }),
      snoozed: otherTabSnooze,
    });
  });
});

describe("two accounts on one browser", () => {
  const OTHER_KEY = scheduleReconfirmationKey("user-alex");

  it("asks this account even when another account confirmed the identical pair", async () => {
    window.localStorage.setItem(
      OTHER_KEY,
      JSON.stringify(CONFIRMED_NINE_TO_FIVE),
    );

    await renderProfile();

    expect(await findNotice()).toHaveTextContent(
      "9:00 AM to 5:00 AM the next day (20 hours)",
    );
  });

  it("writes this account's answer under its own key, leaving the other's alone", async () => {
    const otherRecord = JSON.stringify({
      confirmed: null,
      snoozed: {
        startMinute: 540,
        endMinute: 300,
        snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    window.localStorage.setItem(OTHER_KEY, otherRecord);
    await renderProfile();

    fireEvent.click(await screen.findByText("Yes, these hours are correct"));

    expect(storedRecord().confirmed).toMatchObject({
      startMinute: 540,
      endMinute: 300,
    });
    expect(window.localStorage.getItem(OTHER_KEY)).toBe(otherRecord);
  });

  it("is not closed by another account answering in another tab", async () => {
    await renderProfile();
    await findNotice();

    const written = JSON.stringify(CONFIRMED_NINE_TO_FIVE);
    window.localStorage.setItem(OTHER_KEY, written);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: OTHER_KEY, newValue: written }),
      );
    });
    await settle();

    expect(notice()).toBeInTheDocument();
  });

  it("does not carry one account's confirmation to the next account to sign in", async () => {
    await renderProfile();
    fireEvent.click(await screen.findByText("Yes, these hours are correct"));
    await waitFor(() => expect(notice()).not.toBeInTheDocument());

    // Another person signs in on this browser, with the same stored pair.
    storedUser = { ...MIS_PICKED, id: "user-alex" };
    await reload();

    expect(await findNotice()).toBeInTheDocument();
  });
});

describe("when storage fails", () => {
  it("shows the notice when storage cannot be read", async () => {
    const getItem = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    try {
      await renderProfile();

      expect(await findNotice()).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
    }
  });

  it("still removes the notice when the answer cannot be written, and asks again next time", async () => {
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      await renderProfile();

      fireEvent.click(await screen.findByText("Yes, these hours are correct"));

      await waitFor(() => expect(notice()).not.toBeInTheDocument());
      expect(editFn).not.toHaveBeenCalled();

      await reload();
      expect(await findNotice()).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });
});
