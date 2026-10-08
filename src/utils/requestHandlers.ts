import { User, EnhancedPublicUser } from "../utils/types";
import { Request, Role } from "@prisma/client";

/**
 * The two request fields the handlers read. The parameters are typed as this
 * rather than as the whole Prisma row, because callers hold what
 * `user.requests.me` returns, typed by `utils/types.ts`, not a database row.
 * The two stopped matching when the row gained a column that type does not
 * declare.
 */
type RequestRef = Pick<Request, "id" | "fromUserId">;
import { trpc } from "./trpc";
import { toast } from "react-toastify/unstyled";
import { requestUnavailableExplanation } from "./roleCompatibility";
import { hasSeatAvailable } from "./carpoolSeats";
import { invalidateMembershipCaches } from "./groups/invalidateMembershipCaches";

interface RequestHandlers {
  /**
   * Resolves `true` only when the request was actually accepted.
   *
   * The caller sends the acceptance email and closes the conversation, and both
   * are things that must not happen for an accept that was refused - the
   * notification endpoint is deliberately not rate limited, so a spurious call
   * is a real email to a real person.
   */
  handleAcceptRequest: (
    user: User,
    otherUser: EnhancedPublicUser,
    request: RequestRef,
  ) => Promise<boolean>;
  handleRejectRequest: (
    user: User,
    otherUser: EnhancedPublicUser,
    request: RequestRef,
  ) => Promise<void>;
  /**
   * True while any of the three mutations is in flight, so the buttons that
   * trigger them can be disabled. Matches `useGroupMembership`'s flag of the
   * same name.
   */
  isMutating: boolean;
}

// Function to create the handlers
export const createRequestHandlers = (
  utils: ReturnType<typeof trpc.useUtils>,
): RequestHandlers => {
  const { mutateAsync: deleteRequestAsync, isPending: isDeleting } =
    trpc.user.requests.delete.useMutation({
      onError: (error: any) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      onSuccess: () => {
        utils.user.requests.me.invalidate();
        utils.user.recommendations.me.invalidate();
      },
    });

  /**
   * What an accepted request has just made stale, whichever shape the group
   * write took.
   *
   * Lives in exactly one place (`invalidateMembershipCaches`) for all three
   * call sites that need it, rather than written out separately beside each -
   * a list repeated at each call site is a list that can disagree with
   * itself. This wrapper exists only because both mutations below name it as
   * their `onSuccess`, and `invalidateMembershipCaches` takes `utils`.
   */
  const invalidateAcceptedRequestCaches = () =>
    invalidateMembershipCaches(utils);

  // Neither of these reports its own failure. `handleAcceptRequest` below
  // catches it instead, because the interesting failures here are the server's
  // membership refusals, and "Something went wrong: ..." framed a rule the user
  // can act on as if the app had broken.
  const { mutateAsync: editGroupAsync, isPending: isEditingGroup } =
    trpc.user.groups.edit.useMutation({
      onSuccess: invalidateAcceptedRequestCaches,
    });

  const { mutateAsync: createGroupAsync, isPending: isCreatingGroup } =
    trpc.user.groups.create.useMutation({
      onSuccess: invalidateAcceptedRequestCaches,
    });

  const handleDelete = async (requestId: string) => {
    await deleteRequestAsync({
      invitationId: requestId,
    });
  };

  /**
   * A fast pre-check, not what enforces these rules.
   *
   * It reads `requests.me` data that can be stale - the worst case being a
   * driver whose cache predates the rider joining somebody else's group - so
   * `groups.create` and `groups.edit` establish the same invariants inside the
   * transaction that reserves the seat. This stays because it is instant and
   * can name the other user, which a server message cannot.
   */
  const validateRequestAcceptance = (
    user: User,
    otherUser: EnhancedPublicUser,
  ): boolean => {
    // A request whose two parties cannot carpool can reach this button:
    // `requests.me` does not hide those, because hiding one would not stop it
    // blocking new requests. It cannot be accepted - the
    // group it would build has two drivers or no driver - and the branches
    // below would misread it, because each treats "I am not a DRIVER" as
    // "they are".
    //
    // Status is part of that question, not just role. `requests.me` does not
    // hide a request whose counterpart has *paused* their search, for the
    // same reason it does not hide a role change, so the Accept button
    // reaches those too. A paused counterpart is not looking for a carpool,
    // and their roles may well still fit — which is exactly the case a
    // role-only check waves through.
    //
    // Refused here so the message can name what changed and what would fix
    // it. `groups.create` and `groups.edit` refuse both halves too; that is
    // the half that holds when this cache is stale.
    const unavailable = requestUnavailableExplanation(user.role, otherUser);
    if (unavailable) {
      toast.error(unavailable);
      return false;
    }

    if (user.role === "DRIVER") {
      // `!hasSeatAvailable` rather than `=== 0`: a driver stuck at a negative
      // count would otherwise be told to go ahead and then refused by
      // `reserveSeat`, whose NO_SEATS_MESSAGE describes the driver in the
      // third person and reads oddly when the driver is the one seeing it.
      if (!hasSeatAvailable(user.seatAvail)) {
        // Says what happens next, because the request is not dead: nothing
        // here rejects or hides it, so it is still theirs to accept when a
        // seat frees. New requests to a full driver are refused at the card
        // instead; this is the explanation for one already sent before that
        // applied. Both routes to a seat are named, since a count of 0 may
        // mean the car is full *or* that they never entered one.
        toast.error(
          `You have no seats free right now, so you cannot accept ` +
            `${otherUser.preferredName} yet. Their request stays in your ` +
            `list — accept it once a seat opens up, or raise your seat count ` +
            `in your profile.`,
        );
        return false;
      }
      if (otherUser.carpoolId) {
        toast.error(
          `${otherUser.preferredName} is already in an existing carpool group. Ask them to leave that group before attempting to join yours.`,
        );
        return false;
      }
      return true;
    } else {
      if (user.carpoolId) {
        toast.error(
          `You cannot join ${otherUser.preferredName}'s group until leaving your current carpool group.`,
        );
        return false;
      }
      return true;
    }
  };

  const initiateGroup = async (user: User, otherUser: EnhancedPublicUser) => {
    if (user.role === Role.DRIVER) {
      if (user.carpoolId) {
        await editGroupAsync({
          driverId: user.id,
          riderId: otherUser.id,
          add: true,
          groupId: user.carpoolId,
        });
      } else {
        await createGroupAsync({
          driverId: user.id,
          riderId: otherUser.id,
        });
      }
    } else {
      if (otherUser.carpoolId) {
        await editGroupAsync({
          driverId: otherUser.id,
          riderId: user.id,
          add: true,
          groupId: otherUser.carpoolId,
        });
      } else {
        await createGroupAsync({
          driverId: otherUser.id,
          riderId: user.id,
        });
      }
    }
  };

  /**
   * `request` is unused, and deliberately so.
   *
   * Resolving the request is not the client's job: `groups.create` and
   * `groups.edit` mark it accepted inside the same transaction that writes the
   * membership, so the two cannot disagree. Doing it here as a second mutation
   * would reintroduce exactly that gap. The parameter stays for symmetry with
   * `handleRejectRequest`, which does need the id.
   */
  const handleAcceptRequest = async (
    user: User,
    otherUser: EnhancedPublicUser,
    request: RequestRef,
  ) => {
    if (!validateRequestAcceptance(user, otherUser)) {
      return false;
    }

    try {
      await initiateGroup(user, otherUser);
    } catch (error) {
      // The server is the authority on whether this join is legal, so its
      // refusal is shown as written rather than relabelled. Catching here also
      // stops the success toast below from firing on a failed accept, and stops
      // the rejection escaping as an unhandled one.
      toast.error(
        error instanceof Error
          ? error.message
          : "That request could not be accepted. Please try again.",
      );
      return false;
    }

    toast.success(
      `${otherUser.preferredName}'s request to carpool with you has been accepted.`,
    );

    return true;
  };

  const handleRejectRequest = async (
    user: User,
    otherUser: EnhancedPublicUser,
    request: RequestRef,
  ) => {
    try {
      await handleDelete(request.id);
    } catch {
      // `deleteRequest` already raised the toast. Swallowed here so a failed
      // delete does not also claim success below, and does not escape as an
      // unhandled rejection.
      return;
    }

    // Which way the request pointed decides the sentence: withdrawing your
    // own request and having yours withdrawn are different events, and one
    // string for both would name the wrong person and the wrong direction.
    //
    // Both buttons that reach here are in `MessageHeader`, labelled Reject and
    // Withdraw Request, and both call the same handler.
    toast.success(
      request.fromUserId === user.id
        ? `Your carpool request to ${otherUser.preferredName} has been withdrawn.`
        : `${otherUser.preferredName}'s request to carpool with you has been deleted.`,
    );
  };

  return {
    handleAcceptRequest,
    handleRejectRequest,
    isMutating: isDeleting || isEditingGroup || isCreatingGroup,
  };
};
