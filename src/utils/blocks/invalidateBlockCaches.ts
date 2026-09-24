import type { trpc } from "../trpc";

/**
 * Everything a block or an unblock changes on the reader's screen (SCRUM-554).
 *
 * The server hides a blocked pair from each other in all of these, so after
 * either mutation each one has to be read again. One function rather than a
 * list beside each mutation, because `requestHandlers.ts` records how two
 * copies of such a list drifted apart (SCRUM-510), and `utils/trpc.ts` turns
 * off refetch on mount and on focus, so nothing else would refresh them.
 *
 * `messages.conversation` is invalidated with no input, so every cached thread
 * is refetched, and the one with the blocked person comes back FORBIDDEN.
 */
export const invalidateBlockCaches = async (
  utils: ReturnType<typeof trpc.useUtils>,
): Promise<void> => {
  await Promise.all([
    utils.user.blocks.me.invalidate(),
    utils.user.recommendations.me.invalidate(),
    utils.mapbox.geoJsonUserList.invalidate(),
    utils.user.favorites.me.invalidate(),
    utils.user.requests.me.invalidate(),
    utils.user.messages.getUnreadMessageCount.invalidate(),
    utils.user.messages.conversation.invalidate(),
  ]);
};
