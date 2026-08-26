import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedRouter } from "../createRouter";
import _ from "lodash";
import { Role, CarpoolGroup, RequestStatus, User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { convertCarpoolSearchToPublicWithExactHome } from "../../../utils/publicUser";
import { NO_SEATS_MESSAGE, clampSeats } from "../../../utils/carpoolSeats";

/**
 * Carpool group authorization (SCRUM-220).
 *
 * Every mutation here is `protectedRouter`, but that only proves a session
 * exists — and every NUCarpool user has one. Group and user ids arrived
 * straight from client input, so any signed-in student could dissolve other
 * people's groups, evict riders, insert users, or rewrite a driver's message.
 *
 * The rules below are not invented: they are what the UI already enforces by
 * showing or hiding buttons, now enforced on the server as well.
 *
 * | Action                  | Who may do it                                          | UI evidence                                            |
 * | ----------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
 * | `create`                | either named party, and only with a request between them | `initiateGroup` runs from an accepted request          |
 * | `edit` (add a rider)    | the group's driver, or the rider adding themselves       | same accept flow; a rider joins the driver's group     |
 * | `edit` (remove a rider) | the driver removes anyone; a rider removes only themselves | "Remove" is driver-only; riders get "Leave Group"    |
 * | `delete`                | the group's driver                                       | "Delete Group" renders only when `role === DRIVER`     |
 * | `updateMessage`         | the group's driver                                       | `handleMessageSubmit` is gated on `role === "DRIVER"`  |
 *
 * "The group's driver" means a `CarpoolSearch` whose `carpoolId` is the group
 * and whose `role` is DRIVER — `CarpoolGroup` itself stores no owner.
 *
 * Adding requires a `Request` between the two users because that request *is*
 * the invitation; without it a rider could self-join any stranger's group.
 * Requests are resolved rather than deleted on acceptance (SCRUM-228), so the
 * row this check depends on is still there afterwards — which is also what lets
 * `markRequestAccepted` run inside the same transaction as the membership.
 */

/** Just the Prisma surface these helpers touch, so they are easy to test. */
type PrismaClientLike = Pick<PrismaClient, "carpoolSearch" | "request">;

const forbidden = (message: string) =>
  new TRPCError({ code: "FORBIDDEN", message });

const requireCallerId = (userId: string | undefined): string => {
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User not authenticated.",
    });
  }
  return userId;
};

/** The caller's own membership row for `groupId`, or null if not a member. */
const membershipOf = async (
  prisma: PrismaClientLike,
  userId: string,
  groupId: string,
) =>
  prisma.carpoolSearch.findFirst({
    where: { userId, carpoolId: groupId },
    select: { id: true, role: true },
  });

/** Throws unless the caller is the DRIVER of `groupId`. */
const requireGroupDriver = async (
  prisma: PrismaClientLike,
  callerId: string,
  groupId: string,
) => {
  const membership = await membershipOf(prisma, callerId, groupId);

  if (!membership) {
    throw forbidden("You are not a member of this carpool group.");
  }
  if (membership.role !== Role.DRIVER) {
    throw forbidden("Only the group's driver can perform this action.");
  }
  return membership;
};

/** Throws unless a request exists between the two users, in either direction. */
const requireRequestBetween = async (
  prisma: PrismaClientLike,
  driverId: string,
  riderId: string,
) => {
  const request = await prisma.request.findFirst({
    where: {
      OR: [
        { fromUserId: driverId, toUserId: riderId },
        { fromUserId: riderId, toUserId: driverId },
      ],
    },
    select: { id: true },
  });

  if (!request) {
    throw forbidden(
      "A carpool request between these users is required before they can share a group.",
    );
  }
};

/**
 * Resolves the request that led to this membership (SCRUM-228).
 *
 * Accepting used to build the group and leave the `Request` untouched, so it
 * stayed pending forever in both users' Requests tab and the duplicate guard in
 * `requests.create` blocked the pair from ever requesting each other again.
 *
 * Called inside the same transaction as the membership write, so group state
 * and request state cannot disagree: either both land or neither does.
 * `updateMany` over the pair rather than an id captured earlier, so the write is
 * idempotent and does not depend on a read taken before the transaction opened.
 */
const markRequestAccepted = async (
  prisma: PrismaClientLike,
  driverId: string,
  riderId: string,
) => {
  await prisma.request.updateMany({
    where: {
      OR: [
        { fromUserId: driverId, toUserId: riderId },
        { fromUserId: riderId, toUserId: driverId },
      ],
    },
    data: { status: RequestStatus.ACCEPTED },
  });
};

/**
 * Takes one seat from the driver, atomically (SCRUM-229).
 *
 * The `seatsAvail: { gt: 0 }` in the filter makes this a compare-and-swap: the
 * database decrements only if a seat is actually free, and `count` tells us
 * whether it did. The old shape — read the row, compare in JS, then decrement —
 * could not go below zero only by luck of timing, and `create` skipped the
 * comparison entirely, so the first rider added to a full driver left
 * `seatsAvail` at -1. Two riders accepting at the same instant could do the
 * same even where the check existed.
 */
const reserveSeat = async (prisma: PrismaClientLike, driverUserId: string) => {
  const reserved = await prisma.carpoolSearch.updateMany({
    where: { userId: driverUserId, seatsAvail: { gt: 0 } },
    data: { seatsAvail: { decrement: 1 } },
  });

  if (reserved.count === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: NO_SEATS_MESSAGE });
  }
};

/**
 * Gives seats back to a driver, never exceeding the maximum. Read-modify-write
 * rather than an atomic `increment`, because the value has to be clamped and
 * Prisma cannot express that in one statement. Over-crediting under concurrent
 * removals is bounded by the clamp.
 */
const releaseSeats = async (
  prisma: PrismaClientLike,
  carpoolSearchId: string,
  currentSeats: number,
  seatsToRelease: number,
) => {
  await prisma.carpoolSearch.update({
    where: { id: carpoolSearchId },
    data: { seatsAvail: clampSeats(currentSeats + seatsToRelease) },
  });
};

// use this router to create and manage groups
export const groupsRouter = router({
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = ctx.session.user?.id;

    if (!userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    const carpoolSearch = await ctx.prisma.carpoolSearch.findFirst({
      where: { userId },
    });

    // Not being in a group is an ordinary state, not a failure, and so is not
    // having a CarpoolSearch row yet - a VIEWER or a half-finished onboarding
    // has neither. This used to throw BAD_REQUEST and NOT_FOUND respectively,
    // which the client could not tell apart from the server being broken, and
    // which React Query then retried three times on the way to an error state
    // (SCRUM-241).
    if (!carpoolSearch?.carpoolId) {
      return null;
    }

    const group = await ctx.prisma.carpoolGroup.findUnique({
      where: {
        id: carpoolSearch.carpoolId,
      },
    });

    // The membership points at a group row that is gone. Returning early rather
    // than falling through: the code below spread this value, so a null group
    // produced `{ users: [...] }` with no id and no message - an object shaped
    // enough like a group to pass type checks and then misbehave.
    if (!group) {
      return null;
    }

    // get all CarpoolSearches that reference this group
    const memberCarpoolSearches = await ctx.prisma.carpoolSearch.findMany({
      where: {
        carpoolId: carpoolSearch.carpoolId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            bio: true,
            preferredName: true,
            pronouns: true,
          },
        },
        homeLocation: true,
        companyLocation: true,
      },
    });

    const updatedGroup = {
      ...group,
      // Group members are counterparts: they have agreed to carpool together and
      // the group route is drawn from their home coordinates, so these keep full
      // precision (SCRUM-226).
      users: memberCarpoolSearches.map(
        convertCarpoolSearchToPublicWithExactHome,
      ),
    };
    return updatedGroup;
  }),
  create: protectedRouter
    .input(
      z.object({
        driverId: z.string(),
        riderId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const callerId = requireCallerId(ctx.session.user?.id);

      // The caller has to be one of the two people being put in the group, and
      // the pair has to have an actual request between them.
      if (callerId !== input.driverId && callerId !== input.riderId) {
        throw forbidden(
          "You can only create a carpool group that you are part of.",
        );
      }
      await requireRequestBetween(ctx.prisma, input.driverId, input.riderId);

      const driverSearch = await ctx.prisma.carpoolSearch.findFirst({
        where: { userId: input.driverId },
      });

      if (!driverSearch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Driver not found",
        });
      }

      // Seat, group and both memberships commit together (SCRUM-233).
      //
      // Reserving first is still right — the compare-and-swap is the step that
      // can legitimately fail, so it should fail before anything is built — but
      // untransactioned that ordering only moved the damage: a failure after
      // the decrement took a seat from the driver and created no group, with
      // nothing to give it back. Both halves of that trade are gone now.
      return await ctx.prisma.$transaction(async (tx) => {
        await reserveSeat(tx, input.driverId);

        const group = await tx.carpoolGroup.create({
          data: {
            message: driverSearch.groupMessage || "",
          },
        });

        // update driver's CarpoolSearch
        await tx.carpoolSearch.updateMany({
          where: { userId: input.driverId },
          data: { carpoolId: group.id },
        });

        // update rider's CarpoolSearch
        await tx.carpoolSearch.updateMany({
          where: { userId: input.riderId },
          data: { carpoolId: group.id },
        });

        await markRequestAccepted(tx, input.driverId, input.riderId);

        return group;
      });
    }),
  delete: protectedRouter
    .input(
      z.object({
        groupId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Dissolving the group is the driver's call; a rider leaves instead.
      const callerId = requireCallerId(ctx.session.user?.id);
      await requireGroupDriver(ctx.prisma, callerId, input.groupId);

      // Detaching the members, crediting the driver and deleting the group
      // commit together (SCRUM-233).
      //
      // This was the worst of the untransactioned sequences. Members are
      // detached before the group row is deleted, so a failure in between left
      // a group nobody pointed at — and it could not be cleaned up through the
      // app at all: retrying reaches `requireGroupDriver` above, whose
      // membership lookup is `{ userId, carpoolId: groupId }`, which now
      // matches nothing, so the driver is told they are not a member of their
      // own group. Only manual SQL could clear it. The guard in `me` above
      // ("the membership points at a group row that is gone", SCRUM-241) is
      // what this class of orphan looked like from the read side.
      return await ctx.prisma.$transaction(async (tx) => {
        // Find all CarpoolSearches that reference this group
        const memberCarpoolSearches = await tx.carpoolSearch.findMany({
          where: { carpoolId: input.groupId },
          include: { user: true },
        });

        const driver = memberCarpoolSearches.find(
          (member) => member.role === Role.DRIVER,
        );

        // clear carpoolId for all group members
        await tx.carpoolSearch.updateMany({
          where: {
            carpoolId: input.groupId,
          },
          data: { carpoolId: null },
        });

        // The seats belong to the driver, whoever pressed the button. This used
        // to read and write the *session user's* row, so a rider deleting the
        // group took the seats and the driver never got them back (SCRUM-229).
        // The driver is taken from the membership captured above, before the
        // carpoolIds were cleared.
        if (driver) {
          // Every member other than the driver was occupying a seat.
          const releasedSeats = memberCarpoolSearches.length - 1;
          await releaseSeats(tx, driver.id, driver.seatsAvail, releasedSeats);
        }

        return await tx.carpoolGroup.delete({
          where: {
            id: input.groupId,
          },
        });
      });
    }),
  edit: protectedRouter
    .input(
      z.object({
        driverId: z.string(),
        riderId: z.string(),
        groupId: z.string(),
        add: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const callerId = requireCallerId(ctx.session.user?.id);

      if (input.add) {
        // Joining: either the driver brings a rider in, or a rider joins the
        // driver's group themselves. Both come out of accepting a request, so
        // one has to exist; otherwise a rider could join any stranger's group.
        if (callerId !== input.driverId && callerId !== input.riderId) {
          throw forbidden(
            "You can only add someone to your own carpool group.",
          );
        }
        if (callerId !== input.driverId && input.riderId !== callerId) {
          throw forbidden("You can only add yourself to a carpool group.");
        }
        await requireRequestBetween(ctx.prisma, input.driverId, input.riderId);

        // The target group must actually be the named driver's group.
        const driverMembership = await membershipOf(
          ctx.prisma,
          input.driverId,
          input.groupId,
        );
        if (!driverMembership || driverMembership.role !== Role.DRIVER) {
          throw forbidden("That carpool group does not belong to this driver.");
        }
      } else {
        // Leaving or evicting: the caller must be in the group, and unless
        // they are its driver they may only remove themselves.
        const callerMembership = await membershipOf(
          ctx.prisma,
          callerId,
          input.groupId,
        );
        if (!callerMembership) {
          throw forbidden("You are not a member of this carpool group.");
        }
        if (
          callerMembership.role !== Role.DRIVER &&
          input.riderId !== callerId
        ) {
          throw forbidden("Only the group's driver can remove another member.");
        }

        const targetMembership = await membershipOf(
          ctx.prisma,
          input.riderId,
          input.groupId,
        );
        if (!targetMembership) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That user is not a member of this carpool group.",
          });
        }
      }

      // Membership change, group dissolution and seat accounting commit
      // together (SCRUM-233). Untransactioned, adding could take a seat without
      // linking the rider, and removing could detach the rider without ever
      // giving the seat back — an under-count with nothing to correct it.
      //
      // The boundary stops before the trailing read. Reads cannot leave partial
      // state, so they gain nothing from being inside it, and keeping the read
      // out means a group this procedure legitimately dissolved is never
      // resurrected by a rollback (SCRUM-281).
      const dissolved = await ctx.prisma.$transaction(async (tx) => {
        if (input.add) {
          // Reserve the seat before linking the rider: the compare-and-swap
          // both rejects a full driver and prevents two simultaneous accepts
          // from taking the same seat. Replaces a read-compare-then-decrement
          // that could do neither reliably (SCRUM-229).
          await reserveSeat(tx, input.driverId);

          // when adding rider, set carpoolId for the rider
          await tx.carpoolSearch.updateMany({
            where: { userId: input.riderId },
            data: { carpoolId: input.groupId },
          });

          await markRequestAccepted(tx, input.driverId, input.riderId);
        } else {
          // when removing rider, clear carpoolId for the rider
          await tx.carpoolSearch.updateMany({
            where: { userId: input.riderId },
            data: { carpoolId: null },
          });
        }

        // Check if group should be deleted (only 1 member left)
        const remainingMembers = await tx.carpoolSearch.findMany({
          where: { carpoolId: input.groupId },
        });

        // A carpool of one is not a carpool, so the group goes. Reported out of
        // the transaction rather than re-derived after it, because a later read
        // cannot tell "this procedure just dissolved it" from "it is missing for
        // some other reason" — and it used to report both as an error
        // (SCRUM-281).
        const groupDissolved = remainingMembers.length === 1;

        if (groupDissolved) {
          // The last member is detached explicitly, the way `delete` above does
          // it. Relying on the emulated `SetNull` of `relationMode = "prisma"`
          // would leave the outcome depending on a referential action rather
          // than on this procedure, and a membership pointing at a deleted
          // group is exactly what `me` above has to guard against.
          await tx.carpoolSearch.updateMany({
            where: { carpoolId: input.groupId },
            data: { carpoolId: null },
          });

          await tx.carpoolGroup.delete({
            where: { id: input.groupId },
          });
        }

        // Adding already took its seat above. Removing gives one back, to the
        // driver named on the request, clamped to the shared maximum.
        if (!input.add) {
          const driverSearch = await tx.carpoolSearch.findFirst({
            where: { userId: input.driverId },
            select: { id: true, seatsAvail: true },
          });

          if (!driverSearch) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Driver not found",
            });
          }

          await releaseSeats(tx, driverSearch.id, driverSearch.seatsAvail, 1);
        }

        return groupDissolved;
      });

      // Dissolving the group is the requested outcome, not a failure. This used
      // to fall through to the read below, which found nothing — because this
      // procedure had just deleted it — and threw BAD_REQUEST "Group does not
      // exist". Every caller routes a rejection to "Something went wrong", so
      // leaving a two-person carpool reported failure after succeeding, and the
      // `onSuccess` handlers never ran: no confirmation, the modal stayed open,
      // and the React Query invalidations were skipped, leaving stale
      // membership on screen (SCRUM-281).
      //
      // `null` for "there is no group any more" matches `me` above, which
      // returns it for the same situation.
      if (dissolved) {
        return null;
      }

      const group = await ctx.prisma.carpoolGroup.findUnique({
        where: { id: input.groupId },
      });

      // Still reachable, but only as a race: an id that never existed fails the
      // membership checks above long before this, so getting here means the
      // group was removed by another request in between. That is a genuine bad
      // request rather than this procedure reporting its own work as a failure.
      if (!group) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Group does not exist",
        });
      }

      // Get all members via CarpoolSearch
      const memberCarpoolSearches = await ctx.prisma.carpoolSearch.findMany({
        where: { carpoolId: input.groupId },
        include: { user: true },
      });

      const updatedGroup = {
        ...group,
        users: memberCarpoolSearches.map((cs) => cs.user),
      };

      return updatedGroup;
    }),
  updateMessage: protectedRouter
    .input(
      z.object({
        groupId: z.string(),
        message: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The group message is the driver's; riders only read it.
      const callerId = requireCallerId(ctx.session.user?.id);
      await requireGroupDriver(ctx.prisma, callerId, input.groupId);

      const updatedGroup = await ctx.prisma.carpoolGroup.update({
        where: { id: input.groupId },
        data: {
          message: input.message,
        },
      });
      return updatedGroup;
    }),
  updateUserMessage: protectedRouter
    .input(
      z.object({
        message: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;

      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated",
        });
      }

      // update groupMessage in CarpoolSearch
      const updatedSearch = await ctx.prisma.carpoolSearch.findFirst({
        where: { userId },
      });

      if (updatedSearch) {
        await ctx.prisma.carpoolSearch.update({
          where: { id: updatedSearch.id },
          data: {
            groupMessage: input.message,
          },
        });
      }

      // return user for backward compatibility
      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      return user;
    }),
});
