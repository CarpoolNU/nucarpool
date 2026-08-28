import { User, EnhancedPublicUser } from "../utils/types";
import { Request, Role } from "@prisma/client";
import { trpc } from "./trpc";
import { toast } from "react-toastify";
import { roleMismatchExplanation } from "./roleCompatibility";

interface RequestHandlers {
  /**
   * Resolves `true` only when the request was actually accepted (SCRUM-293).
   *
   * The caller sends the acceptance email and closes the conversation, and both
   * are things that must not happen for an accept that was refused - the
   * notification endpoint is deliberately not rate limited, so a spurious call
   * is a real email to a real person.
   */
  handleAcceptRequest: (
    user: User,
    otherUser: EnhancedPublicUser,
    request: Request,
  ) => Promise<boolean>;
  handleRejectRequest: (
    user: User,
    otherUser: EnhancedPublicUser,
    request: Request,
  ) => Promise<void>;
  /**
   * True while any of the three mutations is in flight, so the buttons that
   * trigger them can be disabled. Matches `useGroupMembership`'s flag of the
   * same name (SCRUM-293).
   */
  isMutating: boolean;
}

// Function to create the handlers
export const createRequestHandlers = (
  utils: ReturnType<typeof trpc.useContext>,
): RequestHandlers => {
  const { mutateAsync: deleteRequestAsync, isLoading: isDeleting } =
    trpc.user.requests.delete.useMutation({
      onError: (error: any) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      onSuccess: () => {
        utils.user.requests.me.invalidate();
        utils.user.recommendations.me.invalidate();
      },
    });

  // Neither of these reports its own failure. `handleAcceptRequest` below
  // catches it instead, because the interesting failures here are the server's
  // membership refusals, and "Something went wrong: ..." framed a rule the user
  // can act on as if the app had broken (SCRUM-291).
  const { mutateAsync: editGroupAsync, isLoading: isEditingGroup } =
    trpc.user.groups.edit.useMutation({
      onSuccess: () => {
        utils.user.requests.me.invalidate();
        utils.user.me.invalidate();
      },
    });

  const { mutateAsync: createGroupAsync, isLoading: isCreatingGroup } =
    trpc.user.groups.create.useMutation({
      onSuccess: () => {
        utils.user.requests.me.invalidate();
        utils.user.me.invalidate();
      },
    });

  const handleDelete = async (requestId: string) => {
    await deleteRequestAsync({
      invitationId: requestId,
    });
  };

  /**
   * A fast pre-check, no longer the thing that enforces these rules.
   *
   * It reads `requests.me` data that can be stale - the whole of failure
   * scenario A in SCRUM-291 is a driver whose cache predates the rider joining
   * somebody else's group - so `groups.create` and `groups.edit` now establish
   * the same invariants inside the transaction that reserves the seat. This
   * stays because it is instant and can name the other user, which a server
   * message cannot.
   */
  const validateRequestAcceptance = (
    user: User,
    otherUser: EnhancedPublicUser,
  ): boolean => {
    // A request whose two parties can no longer carpool now reaches this
    // button: `requests.me` stopped hiding those, because hiding one did not
    // stop it blocking new requests (SCRUM-296). It cannot be accepted - the
    // group it would build has two drivers or no driver - and the branches
    // below would misread it, because each treats "I am not a DRIVER" as
    // "they are".
    //
    // Refused here so the message can name whose role moved and what would fix
    // it. `groups.create` and `groups.edit` refuse it too; that is the half
    // that holds when this cache is stale.
    const mismatch = roleMismatchExplanation(
      user.role,
      otherUser.role,
      otherUser.preferredName,
    );
    if (mismatch) {
      toast.error(mismatch);
      return false;
    }

    if (user.role === "DRIVER") {
      if (user.seatAvail === 0) {
        toast.error(
          `You do not have any space in your car to accept ${otherUser.preferredName}.`,
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
   * `request` is unused, and deliberately so (SCRUM-228).
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
    request: Request,
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
      // the rejection escaping as an unhandled one (SCRUM-291).
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
    request: Request,
  ) => {
    try {
      await handleDelete(request.id);
    } catch {
      // `deleteRequest` already raised the toast. Swallowed here so a failed
      // delete does not also claim success below, and does not escape as an
      // unhandled rejection (SCRUM-293).
      return;
    }

    toast.success(
      `${otherUser.preferredName}'s request to carpool with you has been deleted.`,
    );
  };

  return {
    handleAcceptRequest,
    handleRejectRequest,
    isMutating: isDeleting || isEditingGroup || isCreatingGroup,
  };
};
