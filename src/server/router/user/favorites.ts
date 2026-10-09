import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedRouter } from "../createRouter";
import _ from "lodash";
import { convertCarpoolSearchToPublic } from "../../publicUser";
import { assertNotBlocked, blockedCounterpartIds } from "../../db/blocks";

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
    // not finished onboarding, and this procedure answers them with NOT_FOUND
    // rather than an empty list. The `role` field is selected but unused here;
    // nothing below filters on it.
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
    //
    // Minus anyone with a block either way. The `_Favorites` row
    // is kept, not removed, so unblocking brings the favourite back.
    const blockedIds = new Set(await blockedCounterpartIds(ctx.prisma, userId));
    const favoritedUserIds = user.favorites
      .map((f) => f.id)
      .filter((id) => !blockedIds.has(id));
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
    // Dropping any favourite whose role matches the caller's, whose role is
    // VIEWER, or whose search is INACTIVE - the predicate that belongs in
    // recommendations, where the scorer applies it - would create a state with
    // no way out here: this query is the only source of the favourites list,
    // the un-favourite star lives on the card it renders, and
    // `buildCandidateWhere` narrows the explore map to compatible roles too.
    // Applying that filter would make the person vanish from every surface
    // while their `_Favorites` row persists, unreachable and unremovable.
    //
    // Roles change between co-op cycles and searches get paused, so a
    // favourite who cannot be carpooled with today is an ordinary state rather
    // than one to hide. `carpoolUnavailableExplanation` is what the card shows
    // on those entries, and `connectAction` is what refuses to open the
    // Connect modal for them - the same division as for requests.
    //
    // The converter must stay `convertCarpoolSearchToPublic`: returning more
    // rows must not also widen what each row discloses. A favourite is not a
    // counterpart, so no exact home coordinate and no email.
    return favoriteCarpoolSearches.map(convertCarpoolSearchToPublic);
  }),
  edit: protectedRouter
    .input(
      z
        .object({
          // The owning user is deliberately absent from this input. A
          // client-supplied `userId` passed straight to `where` would let any
          // signed-in caller edit anyone else's favorites, so the owner comes
          // from the session and cannot be influenced by the client;
          // `.strict()` makes a re-added `userId` a BAD_REQUEST rather than a
          // silently ignored field.
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

      // Favouriting yourself is not something the UI can ask for - `UserCard`
      // only ever sends another user's id - but a hand-rolled call could still
      // do it, and the row it writes would show up in `favorites.me` as the
      // caller favouriting themselves.
      //
      // `assertNotBlocked` below does not catch it: a self pair has no `Block`
      // row to find, because `applyBlock` refuses to create one. `BAD_REQUEST`
      // matches the two other self-target refusals in this API, `blocks.block`
      // and `reports.create`.
      if (input.favoriteId === userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot favorite yourself.",
        });
      }

      // Adding a favourite is reaching toward someone, so a block either way
      // refuses it. Removing one is not, and stays open: a user can always
      // take someone off their own list.
      if (input.add) {
        // A `favoriteId` that names nobody would otherwise reach Prisma, where
        // `connect` cannot resolve the row and throws `P2025` - not a
        // `TRPCError`, so the client would get a masked 500 for what is an
        // ordinary bad id. Checked here rather than caught below so the answer
        // does not depend on which half of the write failed.
        //
        // Only on the add path: `disconnect` of an id that was never
        // favourited is a no-op under an implicit many-to-many, so a remove
        // stays open even if the other account has since been deleted.
        const favorite = await ctx.prisma.user.findUnique({
          where: { id: input.favoriteId },
          select: { id: true },
        });

        if (!favorite) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "User not found.",
          });
        }

        await assertNotBlocked(ctx.prisma, userId, input.favoriteId);
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
