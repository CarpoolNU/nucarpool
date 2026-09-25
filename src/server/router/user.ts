import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "./createRouter";
import { MAX_SEATS_AVAILABLE } from "../../utils/carpoolSeats";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";
import { CURRENT_TERMS_VERSION } from "../../utils/termsAcceptance";
import { Role } from "@prisma/client";
import { Status } from "@prisma/client";
import { Prisma } from "@prisma/client";
import _ from "lodash";
import { favoritesRouter } from "./user/favorites";
import { groupsRouter } from "./user/groups";
import { requestsRouter } from "./user/requests";
import { messageRouter } from "./user/message";
import { recommendationsRouter } from "./user/recommendations";
import { emailsRouter } from "./user/email";
import { blocksRouter } from "./user/blocks";
import { reportsRouter } from "./user/reports";
import {
  generatePresignedUrl,
  signProfileImageUrl,
} from "../../utils/uploadToS3";
import {
  MAX_PROFILE_IMAGE_BYTES,
  PROFILE_IMAGE_CONTENT_TYPES,
} from "../../utils/profileImage";
import { adminDataRouter } from "./user/admin";
import { resolveOwnedLocations } from "../db/locationOwnership";
import {
  latitudeSchema,
  longitudeSchema,
  UNRESOLVED_ADDRESS_MESSAGE,
  unresolvedAddressFields,
} from "../../utils/coordinates";
import {
  DAYS_WORKING_INVALID_MESSAGE,
  DAYS_WORKING_PATTERN,
  DAYS_WORKING_REQUIRED_MESSAGE,
  SCHEDULE_TIME_INVALID_MESSAGE,
  SCHEDULE_TIME_REQUIRED_MESSAGE,
  fromScheduleTimeInput,
  isScheduleTimeString,
} from "../../utils/scheduleTime";
import {
  COOP_DATE_ORDER_MESSAGE,
  coopYearMessage,
  implausibleCoopYearFields,
  reversedCoopRangeFields,
} from "../../utils/dateUtils";

/**
 * Access rule for `getPresignedDownloadUrl`:
 * **any signed-in user may read any user's profile picture.**
 *
 * This is deliberate, not an oversight. Avatars render in recommendations, on
 * the map, on group cards and throughout messaging, so a viewer has no prior
 * relationship with most of the people whose pictures they legitimately see;
 * scoping this to existing relationships would break those surfaces. A profile
 * picture is the one field a user uploads specifically to be seen by strangers
 * on the platform, which is what separates it from the precise home coordinates
 * in the sibling ticket.
 *
 * What *is* constrained is the shape of the id, because it is interpolated
 * straight into an S3 key. Ids are cuids, so refusing anything outside
 * `[A-Za-z0-9_-]` costs nothing and stops the parameter being used to name a key
 * outside the `profile-pictures/{env}/` prefix.
 */
const getPresignedDownloadUrlInput = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(191)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

/**
 * Whether `error` is MySQL refusing a second `carpool_search` row for one user.
 *
 * Only the unique index on `userId` counts. MySQL names the index in
 * `meta.target`; other connectors list the fields, which is also accepted so
 * that the check does not depend on which of the two Prisma reports.
 */
const isDuplicateCarpoolSearch = (error: unknown) => {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  return (
    target === "carpool_search_userId_key" ||
    (Array.isArray(target) && target.length === 1 && target[0] === "userId")
  );
};

// user router to get information about or edit users
export const userRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    // get user with CarpoolSearch data
    const user = await ctx.prisma.user.findUnique({
      where: { id: userId },
      include: {
        carpoolSearches: {
          include: {
            homeLocation: true,
            companyLocation: true,
          },
        },
      },
    });

    // throws TRPCError if no user with ID exists
    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No profile with id '${userId}'`,
      });
    }

    // get the first (active) CarpoolSearch
    const carpoolSearch = user.carpoolSearches[0];

    // merge CarpoolSearch data into user object for backwards compatibility
    return {
      ...user,
      // Distinguishes "no CarpoolSearch row yet" from "the stored role really
      // is VIEWER" - the two collapse to the same `role` below, and a
      // brand-new user is the former, not a Viewer. SCRUM-508.
      hasCarpoolSearch: carpoolSearch !== undefined,
      // CarpoolSearch data
      role: carpoolSearch?.role ?? Role.VIEWER,
      status: carpoolSearch?.status ?? Status.ACTIVE,
      seatAvail: carpoolSearch?.seatsAvail ?? 0,
      companyName: carpoolSearch?.companyName ?? "",
      daysWorking: carpoolSearch?.daysWorking ?? "",
      startTime: carpoolSearch?.startTime ?? null,
      endTime: carpoolSearch?.endTime ?? null,
      coopStartDate: carpoolSearch?.startDate ?? null,
      coopEndDate: carpoolSearch?.endDate ?? null,
      // Group ride preferences, as real columns.
      groupNotes: carpoolSearch?.groupNotes ?? null,
      groupMusicPreference: carpoolSearch?.groupMusicPreference ?? null,
      groupConversationStyle: carpoolSearch?.groupConversationStyle ?? null,
      carpoolId: carpoolSearch?.carpoolId ?? null,
      // Location data (homeLocation)
      startCoordLng: carpoolSearch?.homeLocation?.coordLng ?? 0,
      startCoordLat: carpoolSearch?.homeLocation?.coordLat ?? 0,
      startStreet: carpoolSearch?.homeLocation?.street ?? "",
      startCity: carpoolSearch?.homeLocation?.city ?? "",
      startState: carpoolSearch?.homeLocation?.state ?? "",
      startAddress: carpoolSearch?.homeLocation?.streetAddress ?? "",
      // Location data (companyLocation)
      companyCoordLng: carpoolSearch?.companyLocation?.coordLng ?? 0,
      companyCoordLat: carpoolSearch?.companyLocation?.coordLat ?? 0,
      companyStreet: carpoolSearch?.companyLocation?.street ?? "",
      companyCity: carpoolSearch?.companyLocation?.city ?? "",
      companyState: carpoolSearch?.companyLocation?.state ?? "",
      companyAddress: carpoolSearch?.companyLocation?.streetAddress ?? "",
    };
  }),

  edit: protectedRouter
    .input(
      z
        .object({
          role: z.nativeEnum(Role),
          status: z.nativeEnum(Status),
          seatAvail: z.number().int().min(0).max(MAX_SEATS_AVAILABLE),
          // `company_name`, `preferred_name`, `pronouns` and `bio` are all
          // `VARCHAR(191)`, and every one of them was unbounded here.
          // The forms cap the two name fields and the bio, but nothing capped
          // `companyName` at all, so a pasted value over the width failed the
          // whole profile save inside Prisma instead of at the boundary.
          companyName: z.string().max(PROFILE_TEXT_MAX_LENGTH),
          companyAddress: z.string(),
          // This is the boundary that writes coordinates to `location`, and it
          // range-checked none of them. The columns are plain
          // `Float`, so MySQL accepts any number, and `locationWithin` /
          // `milesBetween` then produce arbitrary answers rather than failing -
          // an out-of-range row is silently unmatchable and also skews the
          // bounding-box query. `getDirections` in `mapbox.ts`
          // enforces the same bounds; the two share one definition.
          companyCoordLng: longitudeSchema,
          companyCoordLat: latitudeSchema,
          startAddress: z.string(),
          startCoordLng: longitudeSchema,
          startCoordLat: latitudeSchema,
          preferredName: z.string().max(PROFILE_TEXT_MAX_LENGTH),
          pronouns: z.string().max(PROFILE_TEXT_MAX_LENGTH),
          isOnboarded: z.boolean(),
          // Seven comma-separated flags, Sunday first - the shape every reader
          // (`adminDataUtils`, `recommendation.ts`) splits on and the only one
          // the profile form produces. It was `z.string()`, so any string was
          // stored and then read as whatever `split(",")` made of it.
          //
          // Production's only other shape is `""`, the column default, on
          // searches that never saved a schedule. The form reads that as seven
          // unticked days and sends them back in this format, so no existing
          // row is locked out of saving by it.
          daysWorking: z.string().regex(DAYS_WORKING_PATTERN, {
            message: DAYS_WORKING_INVALID_MESSAGE,
          }),
          // Nullable as well as optional, and the two mean different things:
          // omitted leaves the column alone, explicit `null` clears it.
          // Without `.nullable()` a cleared schedule is unexpressible.
          //
          // A string has to be a time. `""` or an unparseable value used to be
          // converted to `null` and so cleared the schedule by another route -
          // see `isScheduleTimeString`.
          startTime: z
            .string()
            .refine(isScheduleTimeString, SCHEDULE_TIME_INVALID_MESSAGE)
            .nullable()
            .optional(),
          endTime: z
            .string()
            .refine(isScheduleTimeString, SCHEDULE_TIME_INVALID_MESSAGE)
            .nullable()
            .optional(),
          coopStartDate: z.date().nullable(),
          coopEndDate: z.date().nullable(),
          bio: z.string().max(PROFILE_TEXT_MAX_LENGTH),
          startStreet: z.string(),
          startCity: z.string(),
          startState: z.string(),
          companyStreet: z.string(),
          companyCity: z.string(),
          companyState: z.string(),
        })
        // Two things `.max()` cannot express, both of which used to be stored
        // as submitted and then fail silently at match time.
        //
        // They live on the input rather than in the resolver so a stale or
        // hand-rolled client gets the same answer as the form, and so the paths
        // below line up with the field names `onboardSchema` uses - the profile
        // page routes a failed save to the right tab by reading them.
        .superRefine((data, ctx) => {
          // A year outside `coopYearBounds` runs forwards and so passed the
          // ordering check below: production holds 22 like 1901→1908. The two
          // checks are independent, so a range that is both absurd and
          // reversed reports both. A VIEWER is exempt from both, for the
          // reason `implausibleCoopYearFields` gives.
          for (const field of implausibleCoopYearFields({
            role: data.role,
            coopStartDate: data.coopStartDate,
            coopEndDate: data.coopEndDate,
          })) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
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
              code: z.ZodIssueCode.custom,
              path: [field],
              message: COOP_DATE_ORDER_MESSAGE,
            });
          }

          // Clearing a schedule is a VIEWER's privilege, which is what
          // `onboardSchema` already tells the form. Enforced here too so a
          // stale or hand-rolled client cannot reach a state the UI refuses.
          //
          // Only an *explicit* null is refused. Omitting the field is still
          // "leave it as it is", which is what every caller that is not editing
          // the schedule sends.
          if (data.role !== Role.VIEWER) {
            for (const field of ["startTime", "endTime"] as const) {
              if (data[field] === null) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [field],
                  message: SCHEDULE_TIME_REQUIRED_MESSAGE,
                });
              }
            }

            // The days half of the same rule, in `onboardSchema`'s copy. Seven
            // zeros is well formed, so the pattern above admits it, but it is
            // a schedule with no days in it.
            if (!data.daysWorking.includes("1")) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["daysWorking"],
                message: DAYS_WORKING_REQUIRED_MESSAGE,
              });
            }
          }

          // `(0, 0)` is in range but is the "no address picked yet" sentinel
          // from `useAddressSelection`, not a place anyone lives. A VIEWER is
          // exempt: they have no Locations, and `user.me` already reports
          // `(0, 0)` for them.
          for (const field of unresolvedAddressFields({
            role: data.role,
            home: [data.startCoordLng, data.startCoordLat],
            company: [data.companyCoordLng, data.companyCoordLat],
          })) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: UNRESOLVED_ADDRESS_MESSAGE,
            });
          }
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // `fromScheduleTimeInput` keeps `undefined` and `null` apart, which the
      // truthy ternary here did not: it mapped both to `undefined`, and Prisma
      // reads that in an `update` as "omit this field". So a cleared schedule
      // was silently discarded.
      const startTimeDate = fromScheduleTimeInput(input.startTime);
      const endTimeDate = fromScheduleTimeInput(input.endTime);

      const id = ctx.session.user?.id;
      if (!id) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      // One profile save touches `user`, two `Location` rows and a
      // `CarpoolSearch`. These used to be four independent awaits, so a failure
      // part-way through committed the earlier writes and abandoned the rest —
      // profile fields saved against stale carpool data, or Location rows
      // written for a CarpoolSearch that was never created. `relationMode =
      // "prisma"` means the database rejects none of that, and there is no
      // reconciliation job, so the inconsistency was permanent.
      //
      // What this protects on the read side: `user.me` above spreads
      // `carpoolSearches[0]` and both its Locations onto one flat object, so it
      // assumes the search and the rows it points at agree.
      const saveProfile = async (tx: Prisma.TransactionClient) => {
        await tx.user.update({
          where: { id },
          data: {
            preferredName: input.preferredName,
            pronouns: input.pronouns,
            isOnboarded: input.isOnboarded,
            bio: input.bio,
            // `licenseSigned` is deliberately absent. Saving a profile is not
            // accepting the terms, and this procedure used to set it to true on
            // every save - so the field recorded "this user saved a profile"
            // rather than "this user agreed". Only `acceptTerms`
            // writes it now.
          },
        });

        // CarpoolSearch - find or create
        const existingSearch = await tx.carpoolSearch.findFirst({
          where: { userId: id },
        });

        // Nobody in a group can change role while they are in it, in either
        // direction. A group's roles are what the group routes authorize
        // against - `groups.ts` stores no owner, so "the driver" is whichever
        // member's search reads DRIVER - and this is the only procedure that
        // writes `role`.
        //
        // Away from DRIVER, dropping a group's only DRIVER leaves a state
        // nothing can get out of: `requireGroupDriver` then throws FORBIDDEN
        // for every member, so nobody can remove anybody or dissolve the
        // group, and the riders' shared preferences - read through the
        // driver's own search - vanish.
        //
        // *Towards* DRIVER is the mirror image, and was open until SCRUM-557:
        // the guard used to fire only for a driver leaving the role. A rider
        // who made themselves DRIVER then passed `requireGroupDriver`, and
        // could dissolve the group, evict the real driver, or add riders
        // against their own seat count. The profile form offered it as one
        // click on the Driver radio.
        //
        // RIDER to VIEWER is refused too, deliberately. A viewer has no
        // Locations and cannot request a ride, so a viewer in a group is not a
        // coherent member, and a rider has a way out that always works: Leave
        // Group, which the remove path in `groups.edit` never refuses a rider.
        // Changing role afterwards is then unrestricted.
        //
        // The toast this once was in the profile page was deleted by the
        // profile redesign; it was never server-side at all, so a direct call
        // always bypassed it. It lives here because this is the only place the
        // invariant cannot be routed around.
        //
        // Throwing inside the transaction rolls back the `user.update` above.
        if (existingSearch?.carpoolId && input.role !== existingSearch.role) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              existingSearch.role === Role.DRIVER
                ? "You are the driver of a carpool group. Leave or dissolve " +
                  "the group before changing your role."
                : "You are in a carpool group. Leave the group before " +
                  "changing your role.",
          });
        }

        // Home and company Locations belong to this CarpoolSearch and nobody
        // else, so the coordinates just submitted are always what gets stored.
        // This used to match an existing row on address text alone
        // and reuse whatever coordinates that row already had.
        const { homeLocationId, companyLocationId } =
          await resolveOwnedLocations(tx, {
            carpoolSearchId: existingSearch?.id ?? null,
            currentHomeLocationId: existingSearch?.homeLocationId ?? null,
            currentCompanyLocationId: existingSearch?.companyLocationId ?? null,
            home: {
              street: input.startStreet,
              city: input.startCity,
              state: input.startState,
              streetAddress: input.startAddress,
              coordLng: input.startCoordLng,
              coordLat: input.startCoordLat,
            },
            company: {
              street: input.companyStreet,
              city: input.companyCity,
              state: input.companyState,
              streetAddress: input.companyAddress,
              coordLng: input.companyCoordLng,
              coordLat: input.companyCoordLat,
            },
          });

        const carpoolSearchData = {
          role: input.role,
          status: input.status,
          // Left alone while the caller is in a group. `seatsAvail` is the
          // *remaining* count once a group exists, and `reserveSeat` and
          // `releaseSeats` in `groups.ts` move it as riders join and leave.
          // The profile form sends back whatever it loaded, so a rider joining
          // after the driver opened the page was undone by the driver's next
          // save of anything at all - the bio, say - and the car could then
          // take more riders than it seats. SCRUM-557.
          //
          // Ignored rather than refused: a stale value is exactly what the
          // form sends in that case, and it is indistinguishable from an
          // intended change, so refusing a mismatch would fail the bio save
          // instead. The form locks the field for a grouped user to match.
          // `undefined` is Prisma's "omit this field" in an `update`; the
          // `create` path never has a group, so it always writes the input.
          seatsAvail: existingSearch?.carpoolId ? undefined : input.seatAvail,
          companyName: input.companyName,
          daysWorking: input.daysWorking,
          startTime: startTimeDate,
          endTime: endTimeDate,
          startDate: input.coopStartDate,
          endDate: input.coopEndDate,
          homeLocationId,
          companyLocationId,
        };

        if (existingSearch) {
          // A role change is the half of this write `groups.create` and
          // `groups.edit` depend on: both re-check the rider's `role` before
          // linking them into a group, but only against a read taken earlier
          // in *their own* transaction. Under MySQL REPEATABLE READ that read
          // is a snapshot, so it can still say RIDER after this save has
          // already committed DRIVER. SCRUM-557 keeps a stray DRIVER-in-group
          // out of the ordinary path; this closes the concurrent one.
          //
          // This has to be a raw `UPDATE`, not `tx.carpoolSearch.updateMany`.
          // The obvious Prisma-idiomatic compare-and-swap is `updateMany`'s
          // WHERE re-checking `carpoolId` - the same shape `reserveSeat` in
          // `groups.ts` uses for seats - but verified against a real MySQL
          // (a throwaway container, forcing the exact interleaving): on this
          // Prisma version, `updateMany`'s WHERE matched against this
          // transaction's own REPEATABLE READ snapshot instead of the
          // current committed row, so it happily "won" a race it should have
          // lost. A raw `UPDATE ... WHERE ...` does not have that problem -
          // InnoDB gives it a current read - which the same throwaway
          // database confirmed. `reserveSeat`'s use of `updateMany` is
          // believed to have the identical defect; see SCRUM-563's ticket
          // discussion for why fixing that is out of this ticket's scope.
          //
          // Reachable only with `existingSearch.carpoolId === null`: the
          // FORBIDDEN guard above already threw if it was truthy and the
          // role is changing, so the WHERE below hardcodes `IS NULL` rather
          // than parameterizing a value that can only ever be null here.
          //
          // Written as a single-column claim rather than the full
          // `carpoolSearchData`, so the raw SQL does not have to be kept in
          // sync with every field this procedure writes. Once the claim
          // succeeds, this transaction holds the row's lock until commit, so
          // the ordinary `update` that follows cannot be raced - anyone
          // still competing for `carpoolId` blocks on that lock and then
          // loses their own compare-and-swap against the row this just
          // committed.
          if (input.role !== existingSearch.role) {
            const claimed = await tx.$executeRaw`
              UPDATE carpool_search
              SET role = ${input.role}
              WHERE id = ${existingSearch.id} AND carpoolId IS NULL
            `;

            if (claimed === 0) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "Your carpool group membership changed while this save " +
                  "was in progress. Reload your profile and try again.",
              });
            }
          }

          await tx.carpoolSearch.update({
            where: { id: existingSearch.id },
            data: carpoolSearchData,
          });
        } else {
          await tx.carpoolSearch.create({
            data: {
              userId: id,
              carpoolId: null,
              ...carpoolSearchData,
            },
          });
        }

        // return the updated user with CarpoolSearch data
        return await tx.user.findUnique({
          where: { id },
          include: {
            carpoolSearches: {
              include: {
                homeLocation: true,
                companyLocation: true,
              },
            },
          },
        });
      };

      // Two first-time saves for one user can both find no search and both
      // create one. The unique index on `carpool_search.userId` refuses the
      // second insert, and that save is retried from the top so that it
      // becomes an update of the row that won - a lost race is a successful
      // save, not a 500. SCRUM-544.
      //
      // The whole transaction, not just the insert. Under MySQL's REPEATABLE
      // READ the losing transaction keeps the snapshot it took before the
      // winner committed, so re-reading inside it would still find nothing.
      // Rolling back also discards the Location rows it created for a search
      // that never existed. Once is enough: the retry finds the winner's row
      // and takes the update branch, which cannot conflict.
      try {
        return await ctx.prisma.$transaction(saveProfile);
      } catch (error) {
        if (!isDuplicateCarpoolSearch(error)) {
          throw error;
        }
        return await ctx.prisma.$transaction(saveProfile);
      }
    }),

  /**
   * Signs an upload URL for the caller's *own* profile picture.
   *
   * The key is always derived from the session, never from input, so this cannot
   * be pointed at another user's object. What input controls is the type and the
   * size, and both are bounded here and then bound into the signature — see
   * `generatePresignedUrl` for why the second half is load-bearing.
   *
   * Throws rather than resolving `undefined` when there is no session user: a
   * missing URL was previously indistinguishable from a successful call, and
   * React Query reports a query that resolves `undefined` as a failure anyway.
   */
  getPresignedUrl: protectedRouter
    .input(
      z
        .object({
          contentType: z.enum(PROFILE_IMAGE_CONTENT_TYPES),
          // The declared length is what gets signed, so an oversize file cannot
          // be smuggled past this by understating it: S3 rejects a body whose
          // length disagrees with the signature.
          contentLength: z
            .number()
            .int()
            .positive()
            .max(MAX_PROFILE_IMAGE_BYTES),
        })
        .strict(),
    )
    .query(async ({ ctx, input }): Promise<{ url: string }> => {
      const fileName: string | undefined = ctx.session.user?.id;
      if (!fileName) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      try {
        const url: string = await generatePresignedUrl(
          fileName,
          input.contentType,
          input.contentLength,
        );
        return { url };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate a pre-signed URL",
        });
      }
    }),
  /**
   * Resolves `{ url: null }` for a user with no picture, never `undefined`.
   *
   * React Query treats a query function that resolves `undefined` as a
   * failure ("... data is undefined"), and a query in the error state
   * refetches on every mount regardless of staleTime or refetchOnMount. This
   * procedure used to return `undefined` for a user with no profile picture,
   * so those users - the majority - were never cacheable and paid an S3
   * HeadObject on every avatar mount. `{ url: null }` is a cacheable success.
   *
   * "No picture" is the only thing `{ url: null }` means. A session
   * carrying no user is not a picture-state, so it throws instead of borrowing
   * the same answer - that ambiguity was the point of the criterion, and it does
   * not touch the caching behaviour above, which is about successful lookups.
   */
  getPresignedDownloadUrl: protectedRouter
    .input(getPresignedDownloadUrlInput)
    .query(async ({ ctx, input }): Promise<{ url: string | null }> => {
      const userId: string | undefined = input.userId ?? ctx.session.user?.id;
      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }
      try {
        // A primary-key lookup on an already-open connection is the whole cost
        // of an avatar: signing is a local HMAC, so no S3 request is made for
        // anyone. The column is the only record that a picture exists, and a
        // null one - including a user row that does not exist - means none.
        //
        // That reading became safe only once the backfill had recorded every
        // picture uploaded before the column existed; until then a null row
        // asked S3 with a `HeadObject` instead (SCRUM-276, SCRUM-366).
        const owner = await ctx.prisma.user.findUnique({
          where: { id: userId },
          select: { profilePictureUpdatedAt: true },
        });

        if (!owner?.profilePictureUpdatedAt) {
          return { url: null };
        }

        return { url: await signProfileImageUrl(userId) };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate a pre-signed URL",
        });
      }
    }),

  /**
   * Records that the caller's profile picture has just been uploaded.
   *
   * The client PUTs straight to S3 with a presigned URL, so **the server is
   * never otherwise told the upload happened** — which is why this exists
   * rather than the write living in `getPresignedUrl`. Signing an upload URL is
   * not evidence that anything was uploaded: the user may abandon the form, or
   * S3 may reject the body for a content type or length that disagrees with the
   * signature. Writing the column when the URL is *issued* would therefore mark
   * pictures present that do not exist, and `getPresignedDownloadUrl` would
   * then sign URLs for missing objects and show broken images — the exact
   * failure the rejected alternative design was rejected for.
   *
   * So the client calls this after its PUT returns `ok`, and only then.
   *
   * Idempotent, and correct for a replacement as much as a first upload: it
   * writes `now()` either way, which is what keeps the column accurate when a
   * user changes their picture.
   *
   * Scoped to the session user with no input at all. A `userId` parameter would
   * let any signed-in caller assert that somebody else has a picture, and the
   * only honest source for "who uploaded" is the session that signed the URL.
   */
  recordProfilePictureUpload: protectedRouter.mutation(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    await ctx.prisma.user.update({
      where: { id: userId },
      data: { profilePictureUpdatedAt: new Date() },
    });

    return { success: true };
  }),

  /**
   * Records that the caller accepted the terms shown by `ComplianceModal`.
   *
   * This is the only writer of `licenseSigned`. Nothing used to write it
   * on acceptance at all: the "I Agree" button fired a Mixpanel event and
   * closed the dialog, and the flag was set as a side effect of `user.edit`.
   *
   * Note on reading the columns: they are trustworthy as evidence of acceptance
   * only for values written here. Rows that already had the boolean set may have
   * got it from a profile save - see "Terms acceptance" in
   * `src/server/db/README.md`. Those rows are exactly the ones whose
   * `licenseSignedAt` and `licenseVersion` are null.
   *
   * All three columns are written together, so the record always says when and
   * to what. The version comes from the server rather than from the client:
   * what a caller claims to have read is not evidence of what was rendered.
   */
  acceptTerms: protectedRouter.mutation(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const updatedUser = await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        licenseSigned: true,
        licenseSignedAt: new Date(),
        licenseVersion: CURRENT_TERMS_VERSION,
      },
    });

    return updatedUser;
  }),

  completeTutorial: protectedRouter.mutation(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const updatedUser = await ctx.prisma.user.update({
      where: { id: userId },
      data: {
        tutorialCompleted: true,
      },
    });

    return updatedUser;
  }),

  // merging secondary user routes
  favorites: favoritesRouter,
  messages: messageRouter,
  recommendations: recommendationsRouter,
  requests: requestsRouter,
  groups: groupsRouter,
  emails: emailsRouter,
  admin: adminDataRouter,
  blocks: blocksRouter,
  reports: reportsRouter,
});
