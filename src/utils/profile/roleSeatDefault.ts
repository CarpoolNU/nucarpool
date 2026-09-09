/**
 * The seat count a **role change** implies, and the form wiring that applies it.
 *
 * Both profile forms used to do this in an effect keyed on `role`:
 *
 * ```ts
 * useEffect(() => {
 *   const seatAvail = watch("seatAvail");
 *   if (role === Role.DRIVER && (seatAvail ?? 0) <= 0) setValue("seatAvail", 1);
 *   else if (role !== Role.DRIVER) setValue("seatAvail", 0);
 * }, [setValue, watch, role]);
 * ```
 *
 * The intent was "give a driver a usable starting value when they *switch* to
 * DRIVER". An effect cannot express that, because it cannot tell a switch from
 * the form being **populated** — and the mount sequence guarantees the latter:
 * `profileDefaultValues.role` is `RIDER`, so `role` is `RIDER` on first render;
 * `user.me` then resolves and `reset(...)` writes the stored `role` and
 * `seatAvail`; `role` becomes `DRIVER`, the effect re-runs, reads the
 * just-restored `seatAvail`, sees `0`, and overwrites it with `1`.
 *
 * `0` is not a missing default. `carpoolSeats.ts` records that `seats_avail`
 * "starts as the capacity they enter during onboarding and is decremented as
 * riders join", and that capacity is never stored separately — so a driver at
 * `0` has a **full car**. Merely opening `/profile` told the platform they had
 * a seat free, and the next save persisted it, whatever field they had actually
 * come to edit. `reserveSeat` decrements under `seatsAvail: { gt: 0 }`, so the
 * invented seat was immediately spendable and the car ended up over-subscribed
 * with the over-subscription visible to nobody — least of all the driver, whose
 * profile now showed `1` as though they had typed it. SCRUM-380.
 *
 * The fix is to run the coercion where the ambiguity does not exist: the role
 * radio's own `onChange`, which fires only when a person picks a different
 * role. That is what `registerRoleWithSeatDefault` below is for.
 *
 * Deliberately **not** a `useRef` remembering the previous role, which was the
 * other candidate. The ref has to be re-baselined by the `reset(...)` effect so
 * population is not mistaken for a transition, and the two effects race: on a
 * render where `user` is already cached, the reset effect writes the ref before
 * the coercion effect reads a `role` that is still the *previous* render's
 * value, and the coercion fires on a transition that never happened. An event
 * handler has no such ordering to get wrong.
 *
 * `previousRole` is still a parameter of the decision rather than being assumed
 * from the call site. It keeps the rule ("a *transition* implies a seat count")
 * stated rather than implied, makes a same-value change event a no-op, and
 * lets `roleSeatDefault.test.ts` assert the property that actually broke —
 * that populating the form with a role is not a role change — without a DOM.
 */

import { Role } from "@prisma/client";
import type {
  UseFormRegister,
  UseFormRegisterReturn,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { OnboardingFormInputs } from "../types";

/**
 * What a new driver starts with when they have no usable count of their own.
 *
 * One seat rather than zero because onboarding refuses a DRIVER at `0`
 * (`setup.tsx`'s step-1 guard), so the value has to be one the user can
 * proceed from.
 */
export const DEFAULT_DRIVER_SEATS = 1;

/**
 * The seat count implied by moving from `previousRole` to `nextRole`, or `null`
 * to leave the field exactly as it is.
 *
 * `null` rather than "the current value" so a caller cannot accidentally write
 * over stored data on a no-op: the only way this function changes
 * `seats_avail` is by returning a number, and it returns one only for a real
 * transition.
 */
export const seatAvailOnRoleChange = (
  previousRole: Role,
  nextRole: Role,
  currentSeats: number | undefined,
): number | null => {
  // Populating the form re-states the role the user already had. Nothing
  // changed, so nothing about their seats has changed either.
  if (previousRole === nextRole) {
    return null;
  }

  if (nextRole === Role.DRIVER) {
    // A driver arriving from RIDER or VIEWER carries their conventional `0`,
    // which means "not a driver" rather than "full car". Only that case needs
    // a starting value; a count they already entered is left alone.
    return (currentSeats ?? 0) <= 0 ? DEFAULT_DRIVER_SEATS : null;
  }

  // A rider or viewer has no seats to offer. `0` is the convention the whole
  // app reads, so the field is cleared rather than left holding a stale count.
  return currentSeats === 0 ? null : 0;
};

/**
 * `register("role")` with the seat coercion attached to its `onChange`.
 *
 * Spread into every role radio in place of `register("role")`. Both forms use
 * this one helper so `setup.tsx` and `profile/index.tsx` cannot drift — they
 * carried the same defective effect precisely because it was written twice.
 */
export const registerRoleWithSeatDefault = ({
  register,
  watch,
  setValue,
}: {
  register: UseFormRegister<OnboardingFormInputs>;
  watch: UseFormWatch<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
}): UseFormRegisterReturn<"role"> => {
  const field = register("role");

  return {
    ...field,
    onChange: async (event) => {
      // Read before delegating: `field.onChange` is what writes the new role
      // into the form store, so this is the last moment the old one is
      // readable.
      const previousRole = watch("role");
      const result = await field.onChange(event);

      const seats = seatAvailOnRoleChange(
        previousRole,
        event.target.value as Role,
        watch("seatAvail"),
      );
      if (seats !== null) {
        setValue("seatAvail", seats);
      }

      return result;
    },
  };
};
