import { ErrorDisplay, Note, ProfileHeader } from "../../styles/profile";
import Radio from "../Radio";
import { Role } from "@prisma/client";
import { EntryLabel } from "../EntryLabel";
import { TextField } from "../TextField";
import {
  FieldErrors,
  UseFormHandleSubmit,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { OnboardingFormInputs, User } from "../../utils/types";
import ProfilePicture from "./ProfilePicture";
import useIsMobile from "../../utils/useIsMobile";
import {
  PROFILE_TEXT_MAX_LENGTH,
  PRONOUNS_INPUT_MAX_LENGTH,
} from "../../utils/textLimits";
import { registerRoleWithSeatDefault } from "../../utils/profile/roleSeatDefault";
import { seatAvailValueAs } from "../../utils/carpoolSeats";
import {
  signOutWithGuard,
  UnsavedChangesGuard,
} from "../../utils/profile/signOutWithGuard";
import { fieldErrorId } from "../../utils/formA11y";
import { PendingPicture } from "../../utils/profile/pendingPicture";
import { RiderDemandNotice } from "../RiderDemandNotice";

interface UserSectionProps {
  register: UseFormRegister<OnboardingFormInputs>;
  errors: FieldErrors<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
  watch: UseFormWatch<OnboardingFormInputs>;
  /**
   * The form's `onSubmit`, fired by Save Changes and by Enter in a field.
   * Must be react-hook-form's `handleSubmit(...)` result, which is why the type
   * is that rather than a bare event handler: it calls `preventDefault` itself,
   * and a handler that did not would let the browser navigate the page.
   */
  onSubmit: ReturnType<UseFormHandleSubmit<OnboardingFormInputs>>;

  onPendingPictureChange: (next: PendingPicture) => void;

  /**
   * The unsaved picture change, so `ProfilePicture` can render a preview
   * derived from it. Held by the page rather than here because the
   * unsaved-changes guard and the save handler both read it; see the prop's
   * own note in `ProfilePicture`.
   */
  pendingPicture: PendingPicture;
  user?: User;
  /**
   * How many riders this user could carry if they switched to Driver, already
   * floored by the server, or `null` when they are to be told nothing. Passed
   * down rather than queried here so the page keeps owning its queries; see
   * the note on the query in `pages/profile/index.tsx`.
   */
  riderDemandCount?: number | null;

  /**
   * The profile page's unsaved-changes guard. Required rather than optional:
   * Sign Out below is the third exit from this page found to be bypassing it,
   * and a required prop is what stops a new call site quietly becoming the
   * fourth. `signOutWithGuard` records the rest.
   */
  checkChanges: UnsavedChangesGuard;
}

const UserSection = ({
  errors,
  watch,
  register,
  onSubmit,
  setValue,
  onPendingPictureChange,
  pendingPicture,
  user,
  checkChanges,
  riderDemandCount,
}: UserSectionProps) => {
  const isMobile = useIsMobile();
  const isViewer = watch("role") === Role.VIEWER;

  // Carries the seat coercion, which belongs on the field rather than in a
  // `role` effect on the page.
  // See `roleSeatDefault.ts`: only a user-initiated switch may rewrite
  // `seatAvail`, because populating the form is not a role change.
  const roleField = registerRoleWithSeatDefault({ register, watch, setValue });

  // Nobody in a carpool group can change role until they leave it.
  // `user.edit` refuses it server-side, in both directions: a driver leaving
  // the role strands the group, and a rider taking it gains control of the
  // group from its real driver. The form says so up front so the answer is
  // not a failed save.
  //
  // Every radio but the stored role is disabled, rather than all of them:
  // the current one is inert anyway, and `Radio` dims a disabled button,
  // which would make the user's own role look unselected.
  const lockedRole = user?.carpoolId ? user.role : undefined;
  const roleDisabled = (role: Role) =>
    lockedRole !== undefined && role !== lockedRole;

  // The seat count is locked with it. Inside a group it is the number of
  // seats *left*, which joining and leaving move, and `user.edit` refuses to
  // write it from this form - a value loaded before a rider joined would hand
  // their seat back.
  const seatsLocked = lockedRole !== undefined;

  // Through the guard the header already uses, rather than straight to
  // `signOut`. This button is 20px under Save Changes and is the only route to
  // signing out on a phone; `signOutWithGuard` carries the reasoning.
  const logout = () => {
    void signOutWithGuard(checkChanges);
  };

  return (
    // The section root is the form, so Enter in a field is Save Changes. See
    // the note on `onSubmit` above for the contract, and `noValidate` for why
    // the browser's own checks are off: the seat field's `min` would otherwise
    // stop the submit before react-hook-form could name the error.
    <form
      noValidate
      aria-label="User profile"
      onSubmit={onSubmit}
      className="relative z-10 flex h-full flex-col justify-start"
    >
      <ProfileHeader className={isMobile ? "!text-2xl" : "!text-4xl"}>
        User Profile
      </ProfileHeader>

      <div className="font-montserrat flex text-2xl font-bold">
        I am a... <span className="text-northeastern-red">*</span>
      </div>

      {lockedRole === Role.DRIVER && (
        <Note className="!mt-0 !mb-2 max-w-xl">
          You are the driver of a carpool group, so your role and seats are
          locked. Leave or dissolve the group from the Group page to change them
          - switching now would leave your riders in a group with no driver.
        </Note>
      )}
      {lockedRole !== undefined && lockedRole !== Role.DRIVER && (
        <Note className="!mt-0 !mb-2 max-w-xl">
          You are in a carpool group, so your role is locked. Leave the group
          from the Group page to change it - a group has exactly one driver, and
          it is already set.
        </Note>
      )}

      {/* Immediately above the control it argues for. The locked-role notes
          come first because they explain why the radios are disabled, and a
          reason to press a disabled button would read as mockery - though the
          server already answers `null` for a grouped reader, so in practice
          the two never appear together.

          `watch("role")` rather than the saved role, so selecting Driver
          removes the notice on the click rather than on the save. The count
          itself is the server's and does not move; what moves is whether the
          reader still needs to be told. */}
      {watch("role") !== Role.DRIVER && (
        <RiderDemandNotice
          count={riderDemandCount}
          role={user?.role}
          surface="profile-role"
          className="mb-3 max-w-xl"
        />
      )}

      {/* Fixed layout issues.

          `justify-between` is what separates the role buttons from the seat
          field, and it works only in combination with the cap on that field
          below - see the comment there. The declared 700px is capped by
          `max-w-full` to the 608px content column `max-w-2xl` leaves.

          **The horizontal arrangement starts at `md` (834px), not at the
          mobile breakpoint - SCRUM-708.** It never fitted below that. The
          three buttons are content-sized at the desktop type scale and need
          360.65px, while the content column gives this row 353px at a 667px
          viewport and 326px at 640px; the group alone overflowed, and the seat
          field was pushed past the right-hand edge of a column that carries
          `overflow-x-hidden`, so a Driver could not reach a required field by
          any gesture. Below 834px the row stays the block it already was on a
          phone and the seat field sits under the buttons.

          **A CSS boundary rather than `isMobile`, deliberately.** That hook is
          one constant shared with the header, the bottom navigation and every
          other desktop branch, so moving it to fix this row would move all of
          them. What is needed here is narrower: this row, and the type scale
          in `Radio.tsx` that has to turn over with it, both read
          `MD_BREAKPOINT_PX` from `breakpoints.js` so the two halves cannot
          drift. `isMobile` is no longer consulted for the row at all - below
          834px the two arms had become the same block, so the ternary was
          stating one arrangement twice. */}
      <div className="max-w-full items-end md:flex md:h-24 md:w-[700px] md:justify-between">
        {/* Radio buttons always in a row.

            The gap is a quarter of the wide one below `md`, and that is not
            taste. The three buttons divide this row between them, so every
            pixel of gap is three pixels off their combined width - and at a
            320px viewport the row is 256px wide, which two 32px gaps would
            spend an eighth of on empty space the labels need. See the width
            comment in `Radio.tsx` for the figures.

            `md:` rather than `desktop:` for the same reason the row above
            carries it: the wide gap belongs to the content-sized arrangement,
            which now begins at 834px. At 640px the narrow gap is also what
            keeps the group inside the viewport - three content-sized buttons
            and two 32px gaps reach 642.65px against a column that ends at
            640. */}
        <div className="flex gap-2 md:gap-8">
          <Radio
            label="Viewer"
            id="viewer"
            error={errors.role}
            value={Role.VIEWER}
            currentlySelected={watch("role")}
            disabled={roleDisabled(Role.VIEWER)}
            {...roleField}
          />
          <Radio
            label="Rider"
            id="rider"
            error={errors.role}
            value={Role.RIDER}
            currentlySelected={watch("role")}
            disabled={roleDisabled(Role.RIDER)}
            {...roleField}
          />
          <Radio
            label="Driver"
            id="driver"
            error={errors.role}
            value={Role.DRIVER}
            currentlySelected={watch("role")}
            disabled={roleDisabled(Role.DRIVER)}
            {...roleField}
          />
        </div>

        {/* The seat field, and the cap on it is what puts air between this and
            the Driver button.

            Without the cap this block took every leftover pixel, so its left
            edge *was* that button's right edge - zero separation, against the
            32px between two adjacent buttons. That is SCRUM-707.

            192px is measured rather than chosen. `EntryLabel` renders "Seat
            Availability" plus its required asterisk at 20px Montserrat 700,
            which needs 179.48px to stay on one line; 192 clears that by
            12.52px. At 1440x900 the row is 608px and the three buttons plus
            their two gaps are 360.65px, so capping the field here leaves
            55.35px for `justify-between` to spend between the two groups.
            Both figures were measured in Chromium against this repository's
            compiled stylesheet - jsdom does no layout and cannot see any of it.

            A cap rather than a gap on the row, and the difference is the
            narrow case. Below a 608px row there is progressively less spare
            space; below 540.13px there is none, the cap goes inert and the
            arrangement is exactly what it was before SCRUM-707. A gap would
            instead take its pixels out of the buttons at every width this row
            is horizontal at, and the narrowest of those is now the 520px the
            column gives it at 834 - where the field is already down to
            159.35px and the two groups already touch.

            SCRUM-708 narrowed the range that paragraph is about. The row was
            horizontal from 640px up when it was written, so the squeeze it
            describes ran all the way down to a 326px row; it now stops at
            834px of viewport, and everything below is the block arrangement
            where neither the cap nor `justify-between` applies at all.

            Both arms are now selected by `md:` rather than by `isMobile`,
            following the row - the cap and the flex share only mean anything
            while the row is a flex container, and below 834px it is not. The
            `md:w-auto` is what hands the main size back to `md:flex-1`'s zero
            basis after `w-full` has applied below the breakpoint. */}
        {watch("role") == Role.DRIVER && (
          <div className="mt-2 flex w-full flex-col md:mt-0 md:w-auto md:max-w-48 md:flex-1">
            <EntryLabel
              htmlFor="seatAvail"
              required={true}
              error={errors.seatAvail}
              label="Seat Availability"
            />
            <div className="flex flex-col gap-1">
              <TextField
                inputClassName="h-14 text-lg"
                className="w-full self-end"
                id="seatAvail"
                type="number"
                min="0"
                isDisabled={seatsLocked}
                aria-invalid={errors.seatAvail ? true : undefined}
                aria-describedby={
                  errors.seatAvail ? fieldErrorId("seatAvail") : undefined
                }
                {...register("seatAvail", { setValueAs: seatAvailValueAs })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="my-2 flex w-full justify-between">
        <Note>
          {watch("role") === Role.DRIVER && (
            <span>Looking for Carpoolers to join you.</span>
          )}
          {watch("role") === Role.RIDER && (
            <span>Looking for a Carpool to join.</span>
          )}
          {watch("role") === Role.VIEWER && (
            <span>
              As a viewer, you can see other riders and drivers on the map but
              cannot request a ride.
            </span>
          )}
        </Note>
        {errors.seatAvail && watch("role") === Role.DRIVER && (
          <ErrorDisplay id={fieldErrorId("seatAvail")} role="alert">
            {errors.seatAvail.message}
          </ErrorDisplay>
        )}
      </div>

      <EntryLabel label="Personal Info" className="mt-6 mb-4 !text-2xl" />

      {/* Profile picture section */}
      <div
        className={`mb-12 ${isMobile ? "flex flex-col items-start" : "ml-10"} w-full`}
      >
        <ProfilePicture
          pendingPicture={pendingPicture}
          onPendingPictureChange={onPendingPictureChange}
        />
      </div>

      <div
        className={`flex w-full ${isMobile ? "flex-col space-y-4" : "flex-row space-x-6"}`}
      >
        <div className={`${isMobile ? "w-full" : "w-3/5"} flex flex-col`}>
          <EntryLabel
            htmlFor="preferredName"
            error={errors.preferredName}
            label="Preferred Name"
            className={"!text-lg"}
          />
          <TextField
            id="preferredName"
            error={errors.preferredName}
            isDisabled={isViewer}
            type="text"
            inputClassName={`h-12`}
            {...register("preferredName")}
          />
        </div>

        <div className={`${isMobile ? "w-full" : "w-2/6 flex-1"}`}>
          <EntryLabel
            htmlFor="pronouns"
            error={errors.pronouns}
            label="Pronouns"
            className={"!text-lg"}
          />
          <TextField
            id="pronouns"
            inputClassName={`h-12`}
            error={errors.pronouns}
            // Not `PRONOUNS_MAX_LENGTH`: the value in this input is wrapped
            // in parentheses for display and `maxLength` counts those.
            charLimit={PRONOUNS_INPUT_MAX_LENGTH}
            isDisabled={isViewer}
            defaultValue={watch("pronouns") ? `(${watch("pronouns")})` : ""}
            type="text"
            onChange={(e: any) => {
              const input = e.target;
              const cursorPosition = input.selectionStart || 0;
              const sanitizedValue = input.value.replace(/[()]/g, "");
              const displayValue = sanitizedValue ? `(${sanitizedValue})` : "";
              setValue("pronouns", sanitizedValue, {
                shouldValidate: true,
              });
              input.value = displayValue;
              const adjustedCursor = Math.min(
                cursorPosition + 1,
                displayValue.length - 1,
              );
              input.setSelectionRange(adjustedCursor, adjustedCursor);
            }}
          />
        </div>
      </div>

      <div className="w-full py-4">
        <EntryLabel
          htmlFor="bio"
          error={errors.bio}
          label="About Me"
          className={"!text-lg"}
        />
        <textarea
          id="bio"
          className={`form-input w-full resize-none rounded-md ${
            isViewer ? "border-gray-100 bg-gray-200 text-gray-400" : ""
          } border-black px-3 py-2`}
          maxLength={PROFILE_TEXT_MAX_LENGTH}
          disabled={isViewer}
          {...register("bio")}
        />
        <Note>
          This intro will be shared with people you choose to connect with.
        </Note>
      </div>

      <div className="font-montserrat flex flex-col gap-5 py-8">
        <button
          type="submit"
          className="bg-northeastern-red w-full rounded-lg py-3 text-lg text-white hover:bg-red-700"
          aria-label="Save Changes"
        >
          Save Changes
        </button>
        {/* `type="button"` is what keeps Sign Out from saving: in a form, an
            untyped button submits. */}
        <button
          type="button"
          onClick={logout}
          className="w-full rounded-lg bg-gray-600 py-3 text-lg text-white hover:bg-gray-900"
          aria-label="Sign Out"
        >
          Sign Out
        </button>
      </div>
    </form>
  );
};

export default UserSection;
