import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import UserSection from "./UserSection";
import CarpoolSection from "./CarpoolSection";
import AccountSection from "./AccountSection";
import { CarpoolFeature, OnboardingFormInputs } from "../../utils/types";
import { useAddressSelection } from "../../utils/useAddressSelection";

/**
 * Enter in a field on any of the three `/profile` tabs saves that tab.
 *
 * Each tab is its own `<form>` and `onSubmit` is a form handler:
 * react-hook-form's `handleSubmit(...)`, which is what the page hands down, and
 * which cancels the event itself. Fields plus a `type="button"` Save Changes
 * would leave Enter doing nothing. These render each section against a real
 * `useForm` and a `handleSubmit` around a spy, so "the save ran" is the spy.
 *
 * **Every key press is `user.keyboard("{Enter}")` on a focused field.**
 * user-event submits on Enter only when the form has a submit button, so a tab
 * whose Save Changes is `type="button"` fails these, where a hand-fired
 * `submit` would pass straight through and prove nothing.
 *
 * The negatives are each paired with a positive control in the same test - the
 * same Enter on a neighbouring field *does* save - because "the spy was not
 * called" is also what a form that ignores every key looks like.
 */

jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

// antd's picker panel and the address combobox's list both observe their
// trigger's size once they open. jsdom has no `ResizeObserver`, and does no
// layout for one to report anyway, so an inert stand-in is enough.
(global as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Lets a queued `handleSubmit` finish, so "was not called" is not vacuous. */
const drain = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const suggestion: CarpoolFeature = {
  id: "address.1",
  place_name: "1 Main St, Boston, MA",
  center: [-71.06, 42.36],
};

const addressHook = (
  overrides: Partial<ReturnType<typeof useAddressSelection>> = {},
): ReturnType<typeof useAddressSelection> => ({
  selectedAddress: { place_name: "", center: [0, 0] },
  setSelectedAddress: jest.fn(),
  updateAddress: Object.assign(jest.fn(), {
    cancel: jest.fn(),
    flush: jest.fn(),
  }),
  suggestions: [],
  ...overrides,
});

describe("UserSection - Enter in a field is Save Changes", () => {
  const save = jest.fn();
  const checkChanges = jest.fn();

  beforeEach(() => {
    save.mockClear();
    checkChanges.mockClear();
  });

  const Harness = () => {
    const { register, watch, setValue, handleSubmit, formState } =
      useForm<OnboardingFormInputs>({
        defaultValues: {
          role: Role.RIDER,
          status: Status.ACTIVE,
          preferredName: "Riley",
          pronouns: "",
          bio: "",
          seatAvail: 0,
        },
      });

    return (
      <UserSection
        register={register}
        watch={watch}
        setValue={setValue}
        errors={formState.errors}
        onSubmit={handleSubmit(() => save())}
        onPendingPictureChange={() => undefined}
        pendingPicture={null}
        checkChanges={checkChanges}
      />
    );
  };

  it("is a named form whose Save Changes is its submit button", () => {
    render(<Harness />);

    const form = screen.getByRole("form", { name: "User profile" });
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect((form as HTMLFormElement).noValidate).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save Changes" }),
    ).toHaveAttribute("type", "submit");
  });

  it("saves once on Enter in Preferred Name", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText("Preferred Name"));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves once on a click of Save Changes", async () => {
    // Save Changes submits the form, so an `onClick` left on it would save
    // twice per press.
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save when Sign Out is pressed", async () => {
    // An untyped button in a form submits. Sign Out sits 20px under Save
    // Changes and would otherwise save the profile on its way to the guard.
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Sign Out" }));
    await drain();

    // Positive control: the button did its own job, so it rendered and fired.
    expect(checkChanges).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps Enter in About Me as a newline", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const bio = screen.getByLabelText("About Me");

    await user.click(bio);
    await user.keyboard("one{Enter}two");
    await drain();

    expect(bio).toHaveValue("one\ntwo");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("CarpoolSection - Enter in a field is Save Changes", () => {
  const save = jest.fn();

  beforeEach(() => {
    save.mockClear();
  });

  const Harness = ({
    startAddressHook,
  }: {
    startAddressHook?: ReturnType<typeof useAddressSelection>;
  }) => {
    const { register, watch, setValue, control, handleSubmit, formState } =
      useForm<OnboardingFormInputs>({
        defaultValues: {
          role: Role.DRIVER,
          status: Status.ACTIVE,
          companyName: "",
        },
      });

    return (
      <CarpoolSection
        register={register}
        watch={watch}
        setValue={setValue}
        control={control}
        errors={formState.errors}
        onSubmit={handleSubmit(() => save())}
        startAddressHook={startAddressHook ?? addressHook()}
        companyAddressHook={addressHook()}
      />
    );
  };

  it("is a named form whose Save Changes is its submit button", () => {
    render(<Harness />);

    const form = screen.getByRole("form", { name: "Carpool details" });
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect((form as HTMLFormElement).noValidate).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save Changes" }),
    ).toHaveAttribute("type", "submit");
  });

  it("saves once on Enter in Workplace Name", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText(/Workplace Name/));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("uses Enter to choose an open suggestion first, and only then to save", async () => {
    // Headless UI's combobox cancels Enter while its list is open, and lets it
    // through when closed. That is the right pair: the first Enter must pick
    // the address, not save a profile whose address is still being chosen.
    const user = userEvent.setup();
    const setSelectedAddress = jest.fn();
    render(
      <Harness
        startAddressHook={addressHook({
          suggestions: [suggestion],
          setSelectedAddress,
        })}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: /Home Address/ }));
    await user.keyboard("1");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await drain();

    expect(setSelectedAddress).toHaveBeenCalledWith(suggestion);
    expect(save).not.toHaveBeenCalled();

    // The list is closed now, so the second Enter is the form's.
    await user.keyboard("{Enter}");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save when Enter is pressed in a time picker", async () => {
    // A picker's input is read-only and Enter belongs to its panel. The
    // control is Workplace Name, whose Enter does save.
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const startTime =
      container.querySelector<HTMLInputElement>("input#startTime");
    expect(startTime).not.toBeNull();
    expect(startTime).toHaveAttribute("readonly");

    await user.click(startTime!);
    await user.keyboard("{Enter}");
    await drain();

    expect(save).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/Workplace Name/));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });
});

describe("AccountSection - Enter in a field is Save Changes", () => {
  const save = jest.fn();

  beforeEach(() => {
    save.mockClear();
  });

  const Harness = () => {
    const { watch, setValue, control, handleSubmit, formState } =
      useForm<OnboardingFormInputs>({
        defaultValues: {
          role: Role.DRIVER,
          status: Status.ACTIVE,
          coopStartDate: new Date("2027-01-15T00:00:00Z"),
          coopEndDate: new Date("2027-06-15T00:00:00Z"),
        },
      });

    return (
      <AccountSection
        control={control}
        watch={watch}
        setValue={setValue}
        errors={formState.errors}
        onSubmit={handleSubmit(() => save())}
      />
    );
  };

  it("is a named form whose Save Changes is its submit button", () => {
    render(<Harness />);

    const form = screen.getByRole("form", { name: "Account status" });
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect((form as HTMLFormElement).noValidate).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save Changes" }),
    ).toHaveAttribute("type", "submit");
  });

  it("saves once on a click of Save Changes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not save when Enter is pressed in a month picker, but does from the status switch", async () => {
    // This tab has no free-text field. The month pickers are read-only and use
    // Enter to open and confirm their panel, so the profile must not save as
    // a side effect of opening End Date. The switch is the control: an
    // ordinary input whose Enter is the form's.
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const endDate =
      container.querySelector<HTMLInputElement>("input#coopEndDate");
    expect(endDate).not.toBeNull();
    expect(endDate).toHaveAttribute("readonly");

    await user.click(endDate!);
    await user.keyboard("{Enter}");
    await drain();

    expect(save).not.toHaveBeenCalled();

    await user.click(screen.getByRole("switch", { name: "Profile active" }));
    save.mockClear();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await drain();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
