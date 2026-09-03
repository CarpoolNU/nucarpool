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
