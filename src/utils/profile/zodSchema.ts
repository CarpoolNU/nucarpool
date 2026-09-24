import { z } from "zod";
import { Role, Status } from "@prisma/client";
import { MAX_SEATS_AVAILABLE } from "../carpoolSeats";
import { PROFILE_TEXT_MAX_LENGTH } from "../textLimits";
import {
  COOP_DATE_ORDER_MESSAGE,
  coopYearMessage,
  implausibleCoopYearFields,
  reversedCoopRangeFields,
} from "../dateUtils";

const custom = z.ZodIssueCode.custom;
const tooLong = `Cannot be longer than ${PROFILE_TEXT_MAX_LENGTH} characters`;
export const onboardSchema = z
  .object({
    role: z.nativeEnum(Role),
    status: z.nativeEnum(Status),
    // Every check below needs its own message: with none, zod's own wording
    // ("Invalid input: expected number, received NaN", "Too big: expected
    // number to be <=6") reaches the screen verbatim, which is developer
    // output rather than project copy (SCRUM-512). The bound itself still
    // comes from `MAX_SEATS_AVAILABLE` alone, so a change to it cannot drift
    // between the message and the check it describes.
    seatAvail: z
      .number("Must be a number")
      .int("Must be a whole number")
      .nonnegative("Cannot be negative")
      .max(
        MAX_SEATS_AVAILABLE,
        `Cannot be more than ${MAX_SEATS_AVAILABLE} seats`,
      )
      .optional(),
    // The four `VARCHAR(191)` profile columns are bounded here as well as in
    // `user.edit`, so an over-length value shows up as a field error on the
    // form rather than as a failed save. `maxLength` on the inputs
    // stops typing and pasting; this also catches anything set programmatically.
    companyName: z.string().max(PROFILE_TEXT_MAX_LENGTH, tooLong).optional(),
    companyAddress: z.string().optional(),
    startAddress: z.string().optional(),
    preferredName: z.string().max(PROFILE_TEXT_MAX_LENGTH, tooLong).optional(),
    pronouns: z.string().max(PROFILE_TEXT_MAX_LENGTH, tooLong).optional(),
    daysWorking: z.array(z.boolean()).optional(),
    bio: z.string().max(PROFILE_TEXT_MAX_LENGTH, tooLong).optional(),
    startTime: z.date().nullable().optional(),
    endTime: z.date().nullable().optional(),
    coopStartDate: z.date().nullable().optional(),
    coopEndDate: z.date().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.role !== Role.VIEWER) {
      if (!data.coopEndDate) {
        ctx.addIssue({
          code: custom,
          path: ["coopEndDate"],
          message: "Cannot be empty",
        });
      }
      if (!data.coopStartDate) {
        ctx.addIssue({
          code: custom,
          path: ["coopStartDate"],
          message: "Cannot be empty",
        });
      }
      if (!data.seatAvail && data.seatAvail !== 0)
        ctx.addIssue({
          code: custom,
          path: ["seatAvail"],
          message: "Cannot be empty",
        });
      if (data.companyName?.length === 0)
        ctx.addIssue({
          code: custom,
          path: ["companyName"],
          message: "Cannot be empty",
        });
      if (!data.companyAddress || data.companyAddress?.length === 0)
        ctx.addIssue({
          code: custom,
          path: ["companyAddress"],
          message: "Cannot be empty",
        });
      if (!data.startAddress || data.startAddress?.length === 0)
        ctx.addIssue({
          code: custom,
          path: ["startAddress"],
          message: "Cannot be empty",
        });
      if (!data.daysWorking || !data.daysWorking?.some(Boolean))
        ctx.addIssue({
          code: custom,
          path: ["daysWorking"],
          message: "Select at least one day",
        });
      if (!data.startTime)
        ctx.addIssue({
          code: custom,
          path: ["startTime"],
          message: "Cannot be empty",
        });
      if (!data.endTime)
        ctx.addIssue({
          code: custom,
          path: ["endTime"],
          message: "Cannot be empty",
        });
    }

    // Ordering, outside the non-VIEWER block above because that block is about
    // which fields are *required*. `user.edit` refuses the same thing, so this
    // exists to name the field instead of failing the save.
    //
    // Deliberately absent: any equivalent check on `startTime` / `endTime`.
    // Those are times of day, not a range, and finishing before you started is
    // exactly how a night shift reads. `minutesApart` already measures them
    // round the clock and takes the short way, so an overnight pair is scored
    // correctly rather than tolerated - see the note in
    // `src/server/db/README.md`.
    //
    // The year bound goes first so its message is the one a field shows when
    // both apply: `user.edit` refuses both, and a range reading 1913→1907 is
    // not fixed by swapping the two. VIEWERs are exempt from both, since their
    // pickers are disabled - see `implausibleCoopYearFields`.
    for (const field of implausibleCoopYearFields({
      role: data.role,
      coopStartDate: data.coopStartDate,
      coopEndDate: data.coopEndDate,
    })) {
      ctx.addIssue({
        code: custom,
        path: [field],
        message: coopYearMessage(),
      });
    }

    for (const field of reversedCoopRangeFields({
      role: data.role,
      coopStartDate: data.coopStartDate,
      coopEndDate: data.coopEndDate,
    })) {
      ctx.addIssue({
        code: custom,
        path: [field],
        message: COOP_DATE_ORDER_MESSAGE,
      });
    }
  });
export const profileDefaultValues = {
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: "",
  pronouns: "",
  daysWorking: [false, false, false, false, false, false, false],
  startTime: undefined,
  endTime: undefined,
  timeDiffers: false,
  coopStartDate: null,
  coopEndDate: null,
  bio: "",
};
