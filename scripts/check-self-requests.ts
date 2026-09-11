/**
 * Report `Request` rows whose two ends are the same user.
 *
 * `user.requests.create` used to accept `toId === ctx.session.user.id`. The
 * duplicate guard could not catch it — for a self-request both halves of its
 * `OR` are the same pair, so the first attempt always passed — and the UI never
 * produced one, so any such row came from a direct API call. The guard now
 * rejects them, which makes this a one-off check of what already exists rather
 * than something to run on a schedule.
 *
 * **Read-only. This script deletes nothing**, and that stays true: keeping the
 * four `check-*` scripts uniformly read-only is worth more than saving a file.
 *
 * **The repair now lives in `cleanup-self-requests.ts`.** This header used to
 * say the expected count was zero and that anything turning up should be
 * removed by hand — reasonable while the set was empty, and it is not: a later check
 * found **2** rows in production on 2026-09-09, against 0 on staging. Two rows
 * are still few enough to remove by hand and that is exactly the argument for
 * not doing it by hand, because an ad-hoc delete leaves no dry run, no
 * per-row log and no run-state entry.
 *
 * Removal is three deletes, not one — the request, its conversation, and the
 * messages inside it — which is why the counts below are printed per row.
 * `user.requests.delete` has done all three in one transaction;
 * before that it removed only the `Request` row and stranded the other two,
 * which is where production's 620 orphan conversations came from.
 *
 * `relationMode = "prisma"` means MySQL cannot compare two columns for us
 * through a relation filter, and Prisma 4's field references are not relied on
 * here, so rows are read and compared in memory. The table holds one row per
 * user pair, so that is cheap.
 *
 * Usage:
 *   npx ts-node scripts/check-self-requests.ts
 *
 * Exits 0 when there are none, 1 when there are, so it can gate a follow-up.
 * Today it exits 1 against production, and will until the cleanup has run.
 */

import { PrismaClient } from "@prisma/client";

/** Rows whose sender and recipient are the same user. */
export const findSelfRequestIds = (
  requests: readonly { id: string; fromUserId: string; toUserId: string }[],
): string[] =>
  requests
    .filter((request) => request.fromUserId === request.toUserId)
    .map((request) => request.id);

const main = async () => {
  if (process.argv.length > 2) {
    throw new Error(
      `unexpected argument(s): ${process.argv.slice(2).join(", ")}. ` +
        `This script takes none and only reads.`,
    );
  }

  const prisma = new PrismaClient();

  try {
    const requests = await prisma.request.findMany({
      select: {
        id: true,
        fromUserId: true,
        toUserId: true,
        conversationId: true,
        dateCreated: true,
      },
    });

    const selfIds = new Set(findSelfRequestIds(requests));

    console.log(`${requests.length} request row(s)`);
    console.log(`${selfIds.size} self-request row(s)`);

    if (selfIds.size === 0) {
      console.log("\n✓ no request has the same user on both ends.");
      return;
    }

    for (const request of requests.filter((r) => selfIds.has(r.id))) {
      const messages = request.conversationId
        ? await prisma.message.count({
            where: { conversationId: request.conversationId },
          })
        : 0;

      console.log(
        `\n    request      ${request.id}` +
          `\n    user         ${request.fromUserId}` +
          `\n    created      ${request.dateCreated.toISOString()}` +
          `\n    conversation ${request.conversationId ?? "(none)"}` +
          `\n    messages     ${messages}`,
      );
    }

    console.log(
      `\n✖ Remove these with scripts/cleanup-self-requests.ts, which deletes ` +
        `each request together with its conversation and messages in one ` +
        `transaction. It is a dry run unless given --apply.`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import findSelfRequestIds without opening a database
// connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
