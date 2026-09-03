import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "./createRouter";
import { MAX_SEATS_AVAILABLE } from "../../utils/carpoolSeats";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";
import { Role } from "@prisma/client";
import { Status } from "@prisma/client";
import _ from "lodash";
import { favoritesRouter } from "./user/favorites";
import { groupsRouter } from "./user/groups";
import { requestsRouter } from "./user/requests";
import { messageRouter } from "./user/message";
import { recommendationsRouter } from "./user/recommendations";
import { emailsRouter } from "./user/email";
import {
  generatePresignedUrl,
  getPresignedImageUrl,
  signProfileImageUrl,
} from "../../utils/uploadToS3";
import { resolveImageLookup } from "../../utils/profileImageLookup";
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
  COOP_DATE_ORDER_MESSAGE,
  isReversedCoopRange,
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
      // Group ride preferences. These are real columns; `groupMessage` is
      // carried alongside only so a row that has not been backfilled yet still
      // resolves through `resolveGroupDetails`.
      groupNotes: carpoolSearch?.groupNotes ?? null,
      groupMusicPreference: carpoolSearch?.groupMusicPreference ?? null,
      groupConversationStyle: carpoolSearch?.groupConversationStyle ?? null,
      groupMessage: carpoolSearch?.groupMessage ?? null,
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
          daysWorking: z.string(),
          startTime: z.optional(z.string()),
          endTime: z.optional(z.string()),
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
          if (isReversedCoopRange(data.coopStartDate, data.coopEndDate)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["coopEndDate"],
              message: COOP_DATE_ORDER_MESSAGE,
            });
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
      const startTimeDate = input.startTime
        ? new Date(Date.parse(input.startTime))
        : undefined;
      const endTimeDate = input.endTime
        ? new Date(Date.parse(input.endTime))
        : undefined;

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
      const updatedUser = await ctx.prisma.$transaction(async (tx) => {
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

        // A driver who is in a group cannot change role out of it. Dropping a
        // group's only DRIVER leaves a state nothing can get out of:
        // `requireGroupDriver` then throws FORBIDDEN for every member, so
        // nobody can remove anybody or dissolve the group, and the riders'
        // shared preferences - read through the driver's own search - vanish.
        //
        // This was once a toast in the profile page and the profile
        // redesign deleted it; it was never server-side at all, so a direct
        // call always bypassed it. It lives here now because this is the only
        // place the invariant cannot be routed around.
        //
        // Throwing inside the transaction rolls back the `user.update` above.
        if (
          existingSearch?.carpoolId &&
          existingSearch.role === Role.DRIVER &&
          input.role !== Role.DRIVER
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "You are the driver of a carpool group. Leave or dissolve the " +
              "group before changing your role.",
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
          seatsAvail: input.seatAvail,
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
          await tx.carpoolSearch.update({
            where: { id: existingSearch.id },
            data: carpoolSearchData,
          });
        } else {
          await tx.carpoolSearch.create({
            data: {
              userId: id,
              carpoolId: null,
              groupMessage: null,
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
      });

      return updatedUser;
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
        // The whole of SCRUM-276. A primary-key lookup on an already-open
        // connection replaces an S3 `HeadObject` over the network, for every
        // user whose picture state has been recorded.
        //
        // `null` does **not** mean "no picture": every row predating the column
        // has it, whether or not an object exists, so those fall through to the
        // old path. `resolveImageLookup` owns that distinction and says why
        // reading `null` as "no picture" would have deleted the avatar of
        // everyone who already had one.
        const owner = await ctx.prisma.user.findUnique({
          where: { id: userId },
          select: { profilePictureUpdatedAt: true },
        });

        if (resolveImageLookup(owner?.profilePictureUpdatedAt) === "sign") {
          return { url: await signProfileImageUrl(userId) };
        }

        return { url: await getPresignedImageUrl(userId) };
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
   * failure the rejected alternative in SCRUM-276 was rejected for.
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
   * Note on reading the column: it is trustworthy as evidence of acceptance only
   * for values written here. Rows that already had it set may have got it from a
   * profile save - see "Terms acceptance" in `src/server/db/README.md`.
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
});
