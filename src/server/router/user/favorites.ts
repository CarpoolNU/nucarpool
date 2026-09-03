import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedRouter } from "../createRouter";
import _ from "lodash";
import { convertCarpoolSearchToPublic } from "../../publicUser";

export const favoritesRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    // Kept purely as an existence guard: a caller with no CarpoolSearch has
    // not finished onboarding, and this procedure has always answered them with
    // NOT_FOUND rather than an empty list. The `role` it selects used to feed
    // the compatibility filter below, which is gone.
    const currentUserSearch = await ctx.prisma.carpoolSearch.findFirst({
      where: { userId },
      select: { role: true },
    });

    if (!currentUserSearch) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No carpool search found for user ${userId}.`,
      });
    }

    // get user with favorites
    const user = await ctx.prisma.user.findUnique({
      where: { id: userId },
      select: {
        favorites: true,
      },
    });

    // throws TRPCError if no user with ID exists
    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No profile with id '${userId}'`,
      });
    }

    // get CarpoolSearches for all favorited users
    const favoritedUserIds = user.favorites.map((f) => f.id);
    const favoriteCarpoolSearches = await ctx.prisma.carpoolSearch.findMany({
      where: {
        userId: { in: favoritedUserIds },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
            bio: true,
            preferredName: true,
            pronouns: true,
          },
        },
        homeLocation: true,
        companyLocation: true,
      },
    });

    // Role compatibility governs discovery, not a list the user curated.
    //
    // This used to drop any favourite whose role matched the caller's, whose
    // role was VIEWER, or whose search was INACTIVE - the predicate that
    // belongs in recommendations, where the scorer applies it. Applied to
    // favourites it created a state with no way out: this query is the only
    // source of the favourites list, the un-favourite star lives on the card
    // it renders, and `buildCandidateWhere` narrows the explore map to
    // compatible roles too. So the person vanished from every surface while
    // their `_Favorites` row persisted, unreachable and unremovable.
    //
    // Roles change between co-op cycles and searches get paused, so a
    // favourite who cannot be carpooled with today is an ordinary state rather
    // than one to hide. `carpoolUnavailableExplanation` is what the card shows
    // on those entries, and `connectAction` is what refuses to open the
    // Connect modal for them - the same division SCRUM-296 settled on for
    // requests.
    //
    // The converter is unchanged and must stay `convertCarpoolSearchToPublic`:
    // returning more rows must not also widen what each row discloses. A
    // favourite is not a counterpart, so no exact home coordinate and no email.
    return favoriteCarpoolSearches.map(convertCarpoolSearchToPublic);
  }),
  edit: protectedRouter
    .input(
      z
        .object({
          // The owning user is deliberately absent from this input.
          // It used to be a client-supplied `userId` that was passed straight to
          // `where`, which let any signed-in caller edit anyone else's favorites.
          // The owner now comes from the session and cannot be influenced by the
          // client; `.strict()` makes a re-added `userId` a BAD_REQUEST rather
          // than a silently ignored field.
          favoriteId: z.string(),
          add: z.boolean(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;

      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated.",
        });
      }

      await ctx.prisma.user.update({
        where: {
          id: userId,
        },
        data: {
          favorites: {
            [input.add ? "connect" : "disconnect"]: { id: input.favoriteId },
          },
        },
      });
    }),
});
