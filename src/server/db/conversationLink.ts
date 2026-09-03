import type { Conversation } from "@prisma/client";
import type { TransactionClient } from "./client";

/**
 * Returns the conversation for a request, creating and linking it if it does
 * not exist yet.
 *
 * **Why this needs to exist at all.** The request-to-conversation link is
 * stored twice — `Conversation.requestId`, which is `@unique`, and
 * `Request.conversationId`, which is not — and nothing in the schema keeps the
 * two in agreement. `relationMode = "prisma"` means there are no real foreign
 * keys to lean on either. So repairing a missing link takes two statements in a
 * fixed order, and getting that order or that key wrong has already caused one
 * bug in each of the two places that do it.
 *
 * **The lookup is keyed on `Conversation.requestId`, deliberately.** That is
 * the authoritative side. Reading `Request.conversationId` instead — which is
 * what `requests.create`'s reopen branch used to do — answers a subtly
 * different question: it tells you whether *this row* knows about a
 * conversation, not whether one exists. When the two disagree, keying off the
 * request row would try to create a second `Conversation` for the same
 * `requestId` and hit the unique constraint, turning a recoverable state into a
 * failed write.
 *
 * **A null link is a legitimate state, not corruption.** The `Conversation`
 * model arrived in migration `20240910182030_conversationmodel`; every request
 * older than it has `conversationId = NULL`, which was 462 of 477 rows on
 * production-derived staging when SCRUM-350 was filed. Those rows are repaired
 * lazily, on the first write that needs a conversation, rather than backfilled
 * — 462 empty conversations would be rows nobody reads, and would add to the
 * orphan problem SCRUM-295 covers.
 *
 * **Callers must already be inside a transaction.** The parameter type says so:
 * `TransactionClient` is a `PrismaClient` minus `$transaction`, so this cannot
 * be handed the base client by accident. Both writes have to commit with
 * whatever the caller writes next, or the link can be created without the
 * message the user typed — which is the failure this helper exists to prevent.
 */
export const findOrCreateConversation = async (
  tx: TransactionClient,
  requestId: string,
): Promise<Conversation> => {
  const existing = await tx.conversation.findUnique({ where: { requestId } });

  if (existing) {
    return existing;
  }

  const conversation = await tx.conversation.create({ data: { requestId } });

  // The other half of the link. Without it the conversation exists but the
  // request does not point at it, and `user.requests.me` reaches messages
  // *through* the request — so the thread would be invisible from the side the
  // UI actually reads.
  await tx.request.update({
    where: { id: requestId },
    data: { conversationId: conversation.id },
  });

  return conversation;
};

/**
 * The conversation ids to remove when a request is deleted.
 *
 * Both links, because the schema stores the relationship twice and nothing
 * keeps the two in agreement — the problem this module's header describes.
 * Keying only on `Conversation.requestId` would be right in every consistent
 * case and would leave a row behind in exactly the inconsistent one that
 * `findOrCreateConversation` exists to survive.
 *
 * Built as a filter list rather than an id list because `Conversation.requestId`
 * identifies a row without being its primary key. Returned non-empty always, so
 * the caller cannot hand Prisma `{ OR: [] }`, and never containing
 * `{ id: undefined }`, which `deleteMany` would read as "no filter" and apply
 * to every row in the table.
 */
export const conversationsToDeleteWith = (request: {
  id: string;
  conversationId: string | null;
}): ({ id: string } | { requestId: string })[] => [
  { requestId: request.id },
  ...(request.conversationId ? [{ id: request.conversationId }] : []),
];

/**
 * Conversation rows whose `requestId` points at a `Request` that is gone.
 *
 * **This tests one of the two links, and unreachability needs both.** Two of
 * the three read paths reach a conversation through `Request.conversationId`
 * rather than through `Conversation.requestId`: `requests.me` includes
 * `sentRequests/receivedRequests → conversation → messages`, and the unread
 * count joins `conversation.request.some(...)`, the back-relation on that same
 * column. `Request.conversationId` is not unique and `Conversation.request` is
 * a `Request[]`, so nothing in the schema stops a live request pointing at a
 * row this function calls an orphan.
 *
 * No current write path creates that state — `findOrCreateConversation` and
 * both branches of `requests.create` only ever link a conversation to the
 * request it was keyed on — and production held **zero** such rows when both
 * links were measured read-only on 2026-09-03, against **620** that fail both.
 * So the returned set was exactly the unreachable set there. It is not
 * guaranteed to be, which is why `cleanup-orphan-conversations.ts` re-checks
 * *both* links immediately before each delete rather than trusting this plan.
 * SCRUM-364 tracks closing the gap.
 *
 * `getConversationMessages` is settled by this link alone: it looks the request
 * up first and throws NOT_FOUND without it, so no participant check ever
 * passes. What counts orphans regardless is `admin.getDashboardStats`, whose
 * `conversation.count()` and `message.groupBy` both include them, which is why
 * the dashboard's conversation figure and its messages-per-conversation average
 * drift upward and cannot be reconciled afterwards.
 *
 * Nothing creates these any more — `requests.delete` removes the conversation
 * with the request — but every decline, withdrawal and "Leave Conversation"
 * before that fix left one behind, holding whatever the pair had typed. Kept
 * as a pure function for the same reason as `findOrphanLocationIds`: the set
 * arithmetic is what is worth testing, and the reads and deletes live in
 * `scripts/cleanup-orphan-conversations.ts`.
 *
 * A null `requestId` is not possible — the column is non-nullable — so unlike
 * the Location case there is no "never linked" state to exclude. Every
 * conversation claims a request; the only question is whether that request
 * still exists.
 */
export const findOrphanConversationIds = (
  conversations: readonly { id: string; requestId: string }[],
  liveRequestIds: readonly string[],
): string[] => {
  const live = new Set(liveRequestIds);
  return conversations
    .filter((conversation) => !live.has(conversation.requestId))
    .map((conversation) => conversation.id);
};
