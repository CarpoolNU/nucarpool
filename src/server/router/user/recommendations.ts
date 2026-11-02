import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { convertCarpoolSearchToPublic } from "../../publicUser";
import {
  candidateExclusions,
  fetchRankedCandidates,
} from "../../db/candidateSearch";
import { riderDemandCount } from "../../db/riderDemand";
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
          days: z.number(), // 0 any, 1 exact, 2 flex
          daysWorking: z.string(),
          flexDays: z.number(),
          startDistance: z.number(), // miles, 0-20; 20 means any
          endDistance: z.number(),
          startTime: z.number(), // hours of deviation, 0-4; 4 means any (a maximum)
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

      // The reader, anyone with a block either way, and - when the filter
      // asks - anyone they have a request with. Shared with
      // `mapbox.geoJsonUserList`.
      const excludedUserIds = await candidateExclusions({
        prisma: ctx.prisma,
        userId,
        messaged: input.filters.messaged,
        sentRequests,
        receivedRequests,
      });

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
        // so mapping it unconditionally would throw on every default page load.
        favoriteUserIds: input.filters.favorites
          ? favorites.map((f) => f.id)
          : [],
      });

      return sortedSearches
        .slice(0, RECOMMENDATION_LIMIT)
        .map(convertCarpoolSearchToPublic);
    }),

  /**
   * How many riders this user could carry if they drove — the matching query
   * run backwards. `riderDemand.ts` carries the design; this is the wiring.
   *
   * **No input, deliberately.** Everything the count is taken under comes
   * from the caller's own stored search and from fixed constants, so there is
   * no parameter a client could vary to ask the same floored question at
   * several radii and recover a suppressed number from the pattern of nulls.
   * It is also why this cannot be folded into `me` above, which is
   * parameterised by the explore filters.
   *
   * Returns `{ count: number | null }` rather than a bare number so the field
   * is named at the call site, and so a later addition — a city, a trend —
   * does not change the procedure's shape.
   */
  riderDemand: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    const currentUserSearch = await ctx.prisma.carpoolSearch.findFirst({
      where: { userId },
      include: {
        // The id and nothing else. Unlike `me` above, nothing here is handed
        // back to the client - the response is one integer - so every other
        // column would be read only to be discarded, the reader's email
        // address among them.
        user: { select: { id: true } },
        homeLocation: true,
        companyLocation: true,
      },
    });

    // No search is not an error here, unlike in `me`. This query decorates a
    // page rather than filling it, and a reader who has not finished setup
    // has nothing to be told — so it answers "nothing to show" in the same
    // shape as a suppressed count instead of failing the request.
    if (!currentUserSearch) {
      return { count: null };
    }

    return {
      count: await riderDemandCount({
        prisma: ctx.prisma,
        userId,
        search: currentUserSearch,
      }),
    };
  }),
});
