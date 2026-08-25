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
} from "../../utils/uploadToS3";
import { adminDataRouter } from "./user/admin";
import { resolveOwnedLocations } from "../db/locationOwnership";

const getPresignedDownloadUrlInput = z.object({
  userId: z.string().optional(),
});

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
      // POI fields (empty defaults for now)
      companyPOIAddress: "",
      companyPOICoordLng: 0,
      companyPOICoordLat: 0,
      startPOILocation: "",
      startPOICoordLng: 0,
      startPOICoordLat: 0,
    };
  }),

  edit: protectedRouter
    .input(
      z.object({
        role: z.nativeEnum(Role),
        status: z.nativeEnum(Status),
        seatAvail: z.number().int().min(0).max(MAX_SEATS_AVAILABLE),
        // `company_name`, `preferred_name`, `pronouns` and `bio` are all
        // `VARCHAR(191)`, and every one of them was unbounded here (SCRUM-231).
        // The forms cap the two name fields and the bio, but nothing capped
        // `companyName` at all, so a pasted value over the width failed the
        // whole profile save inside Prisma instead of at the boundary.
        companyName: z.string().max(PROFILE_TEXT_MAX_LENGTH),
        companyAddress: z.string(),
        companyCoordLng: z.number(),
        companyCoordLat: z.number(),
        startAddress: z.string(),
        startCoordLng: z.number(),
        startCoordLat: z.number(),
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
      // reconciliation job, so the inconsistency was permanent (SCRUM-233).
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
            // rather than "this user agreed" (SCRUM-240). Only `acceptTerms`
            // writes it now.
          },
        });

        // CarpoolSearch - find or create
        const existingSearch = await tx.carpoolSearch.findFirst({
          where: { userId: id },
        });

        // Home and company Locations belong to this CarpoolSearch and nobody
        // else, so the coordinates just submitted are always what gets stored
        // (SCRUM-232). This used to match an existing row on address text alone
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

  getPresignedUrl: protectedRouter
    .input(
      z.object({
        contentType: z.string(),
      }),
    )
    .query(async ({ ctx, input }): Promise<{ url: string } | undefined> => {
      const { contentType } = input;
      const fileName: string | undefined = ctx.session.user?.id;
      if (fileName) {
        try {
          const url: string = await generatePresignedUrl(fileName, contentType);
          return { url };
        } catch (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to generate a pre-signed URL",
          });
        }
      }
    }),
  /**
   * Always resolves an object, never `undefined` (SCRUM-242).
   *
   * React Query treats a query function that resolves `undefined` as a
   * failure ("... data is undefined"), and a query in the error state
   * refetches on every mount regardless of staleTime or refetchOnMount. This
   * procedure used to return `undefined` for a user with no profile picture,
   * so those users - the majority - were never cacheable and paid an S3
   * HeadObject on every avatar mount. `{ url: null }` is a cacheable success.
   */
  getPresignedDownloadUrl: protectedRouter
    .input(getPresignedDownloadUrlInput)
    .query(async ({ ctx, input }): Promise<{ url: string | null }> => {
      const userId: string | undefined = input.userId ?? ctx.session.user?.id;
      if (!userId) {
        return { url: null };
      }
      try {
        return { url: await getPresignedImageUrl(userId) };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate a pre-signed URL",
        });
      }
    }),

  /**
   * Records that the caller accepted the terms shown by `ComplianceModal`.
   *
   * This is the only writer of `licenseSigned`. Before SCRUM-240 nothing wrote
   * it on acceptance at all: the "I Agree" button fired a Mixpanel event and
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
