import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { pairingRetentionCutoff } from "../../db/carpoolPairing";

/**
 * The people the caller used to carpool with.
 *
 * Read-only, and the counterpart to `src/server/db/carpoolPairing.ts`, which
 * writes these rows. SCRUM-636 built the record; this is SCRUM-623, the
 * surface that makes it reachable.
 *
 * **There is deliberately no `take`.** The read is bounded by the retention
 * window rather than by a row cap, and a cap would be the wrong tool here:
 * the dedupe below collapses rows to counterparts, so a limit applied to rows
 * could silently drop whole people from a list whose entire purpose is that
 * nobody falls off it. The window does the bounding, and the shape of the
 * data keeps it small - a user holds one `CarpoolSearch` and so one
 * `carpoolId` at a time, so their rows are "groups joined in the last twelve
 * months" times "people in each", which is single digits for any plausible
 * user. That is a bound from the data model, not a measurement: the model
 * shipped on 2026-10-14 and there is not yet production data to measure. If
 * that reasoning ever stops holding, the fix is to page this list, not to
 * truncate it.
 */

export const carpoolPairingsRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;
    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    const rows = await ctx.prisma.carpoolPairing.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
        endedAt: { gte: pairingRetentionCutoff(new Date()) },
      },
      orderBy: [{ endedAt: "desc" }, { id: "desc" }],
      select: { userAId: true, userBId: true, endedAt: true },
    });

    // One entry per counterpart, keeping the first row seen for them. The
    // query returns newest first, so that is their most recent pairing - the
    // same two people can carpool more than once, and a dissolution of a
    // group of three writes a row per pair, so a counterpart can arrive
    // several times over.
    const mostRecentByCounterpart = new Map<string, Date>();
    for (const row of rows) {
      const counterpartId = row.userAId === userId ? row.userBId : row.userAId;
      if (!mostRecentByCounterpart.has(counterpartId)) {
        mostRecentByCounterpart.set(counterpartId, row.endedAt);
      }
    }

    const users = await ctx.prisma.user.findMany({
      where: { id: { in: [...mostRecentByCounterpart.keys()] } },
      select: { id: true, preferredName: true, name: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    // A counterpart with no `User` row is dropped, not rendered as "Unknown
    // user". The ids here are plain columns, so one can outlive the account
    // it names - and both controls the row exists to offer would then fail,
    // since `reports.create` and `applyBlock` each look the target up and
    // throw NOT_FOUND. The remaining fallback is for a live user whose
    // display names are both empty, which is a different case.
    return [...mostRecentByCounterpart.entries()].flatMap(
      ([counterpartId, endedAt]) => {
        const user = usersById.get(counterpartId);
        if (!user) {
          return [];
        }
        return [
          {
            userId: counterpartId,
            name: user.preferredName || user.name || "Unknown user",
            endedAt,
          },
        ];
      },
    );
  }),
});
