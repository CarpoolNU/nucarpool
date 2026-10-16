import { TRPCError } from "@trpc/server";
import { protectedRouter, router } from "../createRouter";
import { pairingRetentionCutoff } from "../../db/carpoolPairing";
import { contactRetentionCutoff } from "../../db/messageContact";

/**
 * The people the caller used to be connected to, and can still report or
 * block.
 *
 * Read-only, and the counterpart to the two modules that write these rows:
 * `src/server/db/carpoolPairing.ts` records a pair who travelled together
 * (SCRUM-636), and `src/server/db/messageContact.ts` records a pair who only
 * ever corresponded (SCRUM-676). SCRUM-623 built the surface over the first;
 * this is the same surface over both.
 *
 * **Why both are read here rather than in the component.** The two records are
 * separate tables for good reasons the schema explains, but to a reader they
 * are one question — "who have I been connected to?" — and the rule that
 * answers it, when somebody appears in both, is a policy rather than a
 * rendering detail. Merging here gives that rule one home where it can be
 * asserted without rendering anything, and leaves `PastConnectionsSection`
 * with one query, one loading state and one error state.
 *
 * **There is deliberately no `take`.** The read is bounded by the retention
 * windows rather than by a row cap, and a cap would be the wrong tool: a limit
 * applied to rows could silently drop whole people from a list whose entire
 * purpose is that nobody falls off it. The windows do the bounding, and the
 * shape of the data keeps it small — a user holds one `CarpoolSearch` and so
 * one `carpoolId` at a time, and `MessageContact` carries one row per pair by
 * unique index. That is a bound from the data model, not a measurement: there
 * is not yet production data to measure. If that reasoning stops holding, the
 * fix is to page this list, not to truncate it.
 */

/** What kind of connection a row records. Rendered as the row's label. */
export type PastConnectionKind = "CARPOOLED" | "MESSAGED";

type PastConnection = {
  userId: string;
  name: string;
  endedAt: Date;
  kind: PastConnectionKind;
};

export const pastConnectionsRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;
    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    const now = new Date();

    // Two reads rather than one, because they are two tables - but issued
    // together, so the list costs one round trip's latency rather than two.
    // Each computes its own cutoff from its own constant: the two windows are
    // both twelve months today because SCRUM-676 chose not to diverge from
    // SCRUM-636, and keeping them separate is what stops a later decision to
    // shorten one from silently shortening the other.
    const [pairingRows, contactRows] = await Promise.all([
      ctx.prisma.carpoolPairing.findMany({
        where: {
          OR: [{ userAId: userId }, { userBId: userId }],
          endedAt: { gte: pairingRetentionCutoff(now) },
        },
        // `id` tie-breaks because one dissolution of a group of three writes
        // three rows sharing an instant, so `endedAt` alone is not a total
        // order here.
        orderBy: [{ endedAt: "desc" }, { id: "desc" }],
        select: { userAId: true, userBId: true, endedAt: true },
      }),
      ctx.prisma.messageContact.findMany({
        where: {
          OR: [{ userAId: userId }, { userBId: userId }],
          endedAt: { gte: contactRetentionCutoff(now) },
        },
        // No tie-break needed: `@@unique([userAId, userBId])` means one row
        // per pair, so a caller's rows already have distinct counterparts.
        orderBy: [{ endedAt: "desc" }],
        select: { userAId: true, userBId: true, endedAt: true },
      }),
    ]);

    const counterpartOf = (row: { userAId: string; userBId: string }) =>
      row.userAId === userId ? row.userBId : row.userAId;

    // One entry per counterpart, and **a carpool entry always wins over a
    // messaged one** - regardless of which is more recent, and carrying the
    // carpool's own date.
    //
    // Two people who messaged and then carpooled are, to the reader, people
    // they carpooled with. Picking by recency instead would let the label flip
    // to "Messaged until" the day either party cleared an old request, which
    // changes what the row claims about a shared ride because of something the
    // reader never did.
    //
    // The pairing rows are walked first and keep the first row seen for each
    // counterpart, which the `orderBy` above makes their most recent pairing -
    // the same two people can carpool more than once, and a dissolution of a
    // group of three writes a row per pair, so a counterpart can arrive
    // several times over. The contact rows are then added only where the
    // counterpart is not already present.
    const byCounterpart = new Map<
      string,
      { endedAt: Date; kind: PastConnectionKind }
    >();

    for (const row of pairingRows) {
      const counterpartId = counterpartOf(row);
      if (!byCounterpart.has(counterpartId)) {
        byCounterpart.set(counterpartId, {
          endedAt: row.endedAt,
          kind: "CARPOOLED",
        });
      }
    }

    for (const row of contactRows) {
      const counterpartId = counterpartOf(row);
      if (!byCounterpart.has(counterpartId)) {
        byCounterpart.set(counterpartId, {
          endedAt: row.endedAt,
          kind: "MESSAGED",
        });
      }
    }

    // One lookup for the merged set of ids, rather than one per record: a
    // counterpart who appears in both would otherwise be resolved twice.
    const users = await ctx.prisma.user.findMany({
      where: { id: { in: [...byCounterpart.keys()] } },
      select: { id: true, preferredName: true, name: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    // A counterpart with no `User` row is dropped, not rendered as "Unknown
    // user". The ids here are plain columns, so one can outlive the account
    // it names - and both controls the row exists to offer would then fail,
    // since `reports.create` and `applyBlock` each look the target up and
    // throw NOT_FOUND. The remaining fallback is for a live user whose
    // display names are both empty, which is a different case.
    const connections: PastConnection[] = [...byCounterpart.entries()].flatMap(
      ([counterpartId, entry]) => {
        const user = usersById.get(counterpartId);
        if (!user) {
          return [];
        }
        return [
          {
            userId: counterpartId,
            name: user.preferredName || user.name || "Unknown user",
            endedAt: entry.endedAt,
            kind: entry.kind,
          },
        ];
      },
    );

    // Sorted after the merge, not before: each record arrived ordered within
    // itself, and interleaving two already-sorted lists still needs one pass
    // for the result to read as a single history.
    return connections.sort(
      (a, b) => b.endedAt.getTime() - a.endedAt.getTime(),
    );
  }),
});
