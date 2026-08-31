import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { convertCarpoolSearchToPublic } from "../../publicUser";
import { fetchRankedCandidates } from "../../db/candidateSearch";
import { z } from "zod";

/** Recommendations shown in the explore sidebar. */
const RECOMMENDATION_LIMIT = 50;

// use this router to manage invitations
export const recommendationsRouter = router({
  me: protectedRouter
    .input(
      z.object({
        sort: z.string(),
        filters: z.object({
          days: z.number(), /// 0 for any, 1 for exact
          daysWorking: z.string(),
          flexDays: z.number(),
          startDistance: z.number(), // max 20, greater = any
          endDistance: z.number(),
          startTime: z.number(), // max = 4 hours, greater = any
          endTime: z.number(),
          startDate: z.date(),
          endDate: z.date(),
          dateOverlap: z.number(), // 0 any, 1 partial, 2 full
          favorites: z.boolean(), // if true, only show users user has favorited
          messaged: z.boolean(), // if false, hide users user has messaged
        }),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.session.user?.id;

      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated.",
        });
      }

      // Get current user's CarpoolSearch for comparison
      const currentUserSearch = await ctx.prisma.carpoolSearch.findFirst({
        where: { userId },
        include: {
          user: {
            include: {
              favorites: input.filters.favorites,
              sentRequests: !input.filters.messaged,
              receivedRequests: !input.filters.messaged,
            },
          },
          homeLocation: true,
          companyLocation: true,
        },
      });

      if (!currentUserSearch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No carpool search found for user ${userId}.`,
        });
      }

      const { favorites, sentRequests, receivedRequests } =
        currentUserSearch.user;

      const excludedUserIds: string[] = [userId];
      if (!input.filters.messaged) {
        excludedUserIds.push(
          ...sentRequests.map((r) => r.toUserId),
          ...receivedRequests.map((r) => r.fromUserId),
        );
      }

      // Bounded candidate query plus scoring, shared with
      // `mapbox.geoJsonUserList`.
      const sortedSearches = await fetchRankedCandidates({
        prisma: ctx.prisma,
        currentUserSearch,
        filters: input.filters,
        sort: input.sort,
        excludedUserIds,
        // Only read when the filter is on, and only included then: the
        // `favorites` include above is `input.filters.favorites`, and Prisma
        // omits the key entirely rather than returning [] for a false include,
        // so mapping it unconditionally threw on every default page load.
        favoriteUserIds: input.filters.favorites
          ? favorites.map((f) => f.id)
          : [],
      });

      return sortedSearches
        .slice(0, RECOMMENDATION_LIMIT)
        .map(convertCarpoolSearchToPublic);
    }),
});
