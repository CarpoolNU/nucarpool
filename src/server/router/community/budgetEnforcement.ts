import { TRPCError } from "@trpc/server";
import type { BudgetClaim } from "../../community/budget/ports";
import { DomainError, RateLimitedError } from "../../community/shared/errors";

/**
 * The charge/refund policy, extracted so it is tested as a pure function
 * rather than through a procedure — the precedent `actorResolution.ts` sets.
 *
 * **The rule: charge for what the caller did, refund what the server broke.**
 *
 * This is forced by parent spec §8.2, not chosen freely. The `HANDLE_CLAIM`
 * limit is justified there as bounding handle enumeration *through failed
 * claims*, so a `HANDLE_TAKEN` refusal must keep its charge or the limit bounds
 * nothing. The same reasoning covers `CONTENT_UNAVAILABLE`: §7.2 makes deleted,
 * hidden and blocked-author content indistinguishable precisely so content
 * cannot be probed, and refunding every probe would restore the enumeration
 * channel the error code was shaped to close.
 *
 * A Zod validation failure is the caller's doing and is therefore charged. The
 * cost of that is that a buggy client can spend a user's budget on malformed
 * requests; it is still the right trade, because a refunded validation error is
 * an unbounded free channel and a buggy client is a bug to fix.
 */

/**
 * Whether this failure is the server's fault rather than the caller's.
 *
 * Three arms, and the third is the one that is not in spec §5:
 *
 *   - A `DomainError` is a refusal the caller earned. Kept.
 *   - A `TRPCError` is a server fault only at INTERNAL_SERVER_ERROR; every
 *     client code — BAD_REQUEST, NOT_FOUND, CONFLICT, FORBIDDEN — is a refusal
 *     and keeps its charge.
 *   - **A `TRPCError` whose `cause` is a `DomainError` is a refusal too**, at
 *     any code. Spec §5 keeps an explicit `DomainError` arm as belt-and-braces
 *     for a future procedure that forgets `mapDomainErrors`, and that arm alone
 *     cannot fire: tRPC runs everything thrown out of a handler through
 *     `getTRPCErrorFromUnknown`, which wraps a non-`TRPCError` as
 *     INTERNAL_SERVER_ERROR and hangs the original off `cause`. So the exact
 *     case the arm was written for arrives here looking like a server fault,
 *     and would be silently refunded — the failure mode §5 names. Reading
 *     `cause` is what makes the policy hold whether or not the mapping ran.
 *
 * Anything else — a string, `undefined`, a rejected promise with no value — is
 * a server fault, and is checked without assuming it is an object at all.
 */
export const isServerFault = (error: unknown): boolean => {
  if (error instanceof DomainError) return false;
  if (error instanceof TRPCError) {
    if (error.cause instanceof DomainError) return false;
    return error.code === "INTERNAL_SERVER_ERROR";
  }
  return true;
};

/**
 * Runs `run` against a claim, refusing if it was not granted and refunding only
 * what the server broke.
 *
 * It throws `RateLimitedError` — a domain error — rather than a `TRPCError`, so
 * this file stays free of transport policy and testable without tRPC. The
 * middleware that calls it maps the refusal at the boundary, as every other
 * domain error in this module is mapped.
 *
 * **The body must reject on failure.** A tRPC middleware's `next()` does not:
 * it catches whatever the handler threw and resolves `{ ok: false, error }`.
 * The caller is responsible for turning that back into a rejection — see
 * `procedures.ts` — because a `runWithClaim` that silently accepted a failed
 * result would refund nothing and look exactly like one that worked.
 */
export const runWithClaim = async <T>(
  claim: BudgetClaim,
  run: () => Promise<T>,
): Promise<T> => {
  if (!claim.claimed) {
    throw new RateLimitedError();
  }

  try {
    return await run();
  } catch (error) {
    if (isServerFault(error)) {
      await claim.refund();
    }
    throw error;
  }
};
