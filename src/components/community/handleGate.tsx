/**
 * The handle gate.
 *
 * **Shown when a student reaches a write surface**, which is the moment the
 * handle first means anything to them. Asking for one at sign-in would be a
 * form standing between a reader and the thing they came to read, for a name
 * they cannot yet see the purpose of.
 *
 * It states the two facts a person needs before choosing: the handle is
 * permanent, and it is a pseudonym rather than anonymity. Spec §13.5 requires
 * the second to be said plainly — the wording here is a first draft and §17
 * lists it as needing review before any real-user rollout.
 *
 * **It validates the shape before it asks the server.** `parseHandle` is pure
 * and is the same function the service runs, imported the way the composer
 * already imports `textLimits` — so the client and the server cannot drift
 * apart about what a handle is, which `profiles.ts` claims and this is what
 * makes true. The reason is the rate limit: `HANDLE_CLAIM` allows five
 * attempts a day and a malformed handle is charged like any other caller
 * error, so without this a newcomer who mistypes a hyphen, a space and a
 * reserved word has spent their day's budget on five attempts that never
 * probed anything — locked out of a gate that is the entry point to every
 * write path, with no self-service recovery. A shape error costs nothing
 * because it never leaves the browser; a `HANDLE_TAKEN` still costs its
 * charge, which is the refusal the limit exists to bound.
 *
 * Product UI — merges into NUCarpool.
 */
import { useState } from "react";
import { parseHandle } from "../../server/community/identity/domain/handle";
import { DomainError } from "../../server/community/shared/errors";
import { trpc } from "../../utils/trpc";
import { ErrorNote } from "./shell";

export const HandleGate = ({
  reason,
  onClaimed,
}: {
  /** What the person was trying to do, so the gate reads as a step not a wall. */
  reason: string;
  onClaimed: () => Promise<unknown> | void;
}) => {
  const [handle, setHandle] = useState("");
  // A shape refusal raised here rather than by the server. Cleared on every
  // keystroke, so it never outlives the text that caused it.
  const [shapeError, setShapeError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const claim = trpc.community.profiles.create.useMutation({
    onSuccess: async () => {
      setHandle("");
      setShapeError(null);
      await utils.community.profiles.me.invalidate();
      await onClaimed();
    },
  });

  return (
    <section className="rounded-lg border border-gray-200 p-5">
      <h2 className="font-montserrat text-base font-bold">
        Choose a handle to {reason}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-gray-600">
        Your handle is the only name other students see here — not your real
        name, and nothing from your carpool profile. You cannot change it later,
        so pick one you are happy to keep.
      </p>
      <p className="mt-2 max-w-prose text-sm text-gray-600">
        A handle is a pseudonym, not anonymity. Northeastern staff can still
        link it to your account when they investigate a report.
      </p>

      <form
        className="mt-4 flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            parseHandle(handle);
          } catch (error) {
            // Only a shape refusal is ours to answer. Anything else is not a
            // verdict on the handle, so it goes to the server as before rather
            // than being swallowed here.
            if (error instanceof DomainError) {
              setShapeError(error.message);
              return;
            }
            throw error;
          }
          setShapeError(null);
          claim.mutate({ handle });
        }}
      >
        <label htmlFor="handle" className="sr-only">
          Handle
        </label>
        <input
          id="handle"
          value={handle}
          onChange={(event) => {
            setHandle(event.target.value);
            setShapeError(null);
          }}
          placeholder="husky_commuter"
          autoComplete="off"
          className="focus:border-northeastern-red min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none"
        />
        <button
          type="submit"
          disabled={claim.isPending || handle.trim().length === 0}
          className="bg-northeastern-red font-montserrat rounded-md px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#a60d26] disabled:opacity-40"
        >
          {claim.isPending ? "Claiming…" : "Claim handle"}
        </button>
      </form>
      {/* The local refusal wins: it is the newer of the two, since typing
          clears it and a stale server error from a previous attempt is still
          on the mutation. */}
      {shapeError ? <ErrorNote>{shapeError}</ErrorNote> : null}
      {!shapeError && claim.error ? (
        <ErrorNote>{claim.error.message}</ErrorNote>
      ) : null}
    </section>
  );
};
