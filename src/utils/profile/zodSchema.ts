import { z } from "zod";
import { Role, Status } from "@prisma/client";
import { MAX_SEATS_AVAILABLE } from "../carpoolSeats";
import { PROFILE_TEXT_MAX_LENGTH } from "../textLimits";
import { COOP_DATE_ORDER_MESSAGE, isReversedCoopRange } from "../dateUtils";

const custom = z.ZodIssueCode.custom;
const tooLong = `Cannot be longer than ${PROFILE_TEXT_MAX_LENGTH} characters`;
export const onboardSchema = z
  .object({
    role: z.nativeEnum(Role),
    status: z.nativeEnum(Status),
    seatAvail: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SEATS_AVAILABLE)
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
    profilePicture: z.string().optional(),
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

    // Ordering, checked for every role rather than inside the non-VIEWER block
    // above: a reversed range is wrong whoever stored it, and the block above is
    // about which fields are *required*. `user.edit` refuses the same thing, so
    // this exists to name the field instead of failing the save.
    //
    // Deliberately absent: any equivalent check on `startTime` / `endTime`.
    // Those are times of day, not a range, and finishing before you started is
    // exactly how a night shift reads. `minutesApart` already measures them
    // round the clock and takes the short way, so an overnight pair is scored
    // correctly rather than tolerated - see the note in
    // `src/server/db/README.md`.
    if (isReversedCoopRange(data.coopStartDate, data.coopEndDate)) {
      ctx.addIssue({
        code: custom,
        path: ["coopEndDate"],
        message: COOP_DATE_ORDER_MESSAGE,
      });
    }
  });
export const profileDefaultValues = {
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
  companyName: "",
  profilePicture: "",
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
