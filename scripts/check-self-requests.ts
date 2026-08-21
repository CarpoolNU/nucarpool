/**
 * Report `Request` rows whose two ends are the same user (SCRUM-278).
 *
 * `user.requests.create` used to accept `toId === ctx.session.user.id`. The
 * duplicate guard could not catch it — for a self-request both halves of its
 * `OR` are the same pair, so the first attempt always passed — and the UI never
 * produced one, so any such row came from a direct API call. The guard now
 * rejects them, which makes this a one-off check of what already exists rather
 * than something to run on a schedule.
 *
 * **Read-only. This script deletes nothing.**
 *
 * That is deliberate. Its sibling `cleanup-orphan-locations.ts` does support
 * `--apply`, because orphaned Locations accumulated on every address change
 * since the feature existed and the population is unbounded. Here the expected
 * count is zero: producing one takes a deliberate API call. Shipping a
 * destructive tool for an expected-empty set is worse than not having it, so if
 * anything does turn up, remove it by hand using the report below.
 *
 * Removal is three deletes, not one. `user.requests.delete` removes only the
 * `Request` row, so deleting a self-request that way strands its `Conversation`
 * and the initial `Message` — hence the counts printed per row.
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
      `\n✖ Remove each of these by deleting its messages, then its ` +
        `conversation, then the request — in that order. Deleting only the ` +
        `request leaves the other two behind.`,
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
