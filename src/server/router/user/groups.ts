import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedRouter } from "../createRouter";
import _ from "lodash";
import { Role, RequestStatus, Status } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { convertCarpoolSearchToPublicWithExactHome } from "../../publicUser";
import {
  NO_SEATS_MESSAGE,
  MAX_SEATS_AVAILABLE,
} from "../../../utils/carpoolSeats";
import {
  GROUP_NOTES_MAX_LENGTH,
  GROUP_OPTION_MAX_LENGTH,
} from "../../../utils/textLimits";
import { assertNotBlocked, assertNotBlockedForUpdate } from "../../db/blocks";

/**
 * Carpool group authorization.
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
 * | `create`                | the party a **pending** request was **sent to**           | `handleAccept` reads `incomingRequest`, gated on PENDING |
 * | `edit` (add a rider)    | the party a **pending** request was **sent to**           | same accept flow; a rider joins the driver's group     |
 * | `edit` (remove a rider) | the driver removes anyone; a rider removes only themselves | "Remove" is driver-only; riders get "Leave Group"    |
 * | `delete`                | the group's driver                                       | "Delete Group" renders only when `role === DRIVER`     |
 * | `updatePreferences`     | any user, on their own search only                       | the form renders only for a DRIVER, but the write is self-scoped |
 *
 * "The group's driver" means a `CarpoolSearch` whose `carpoolId` is the group
 * and whose `role` is DRIVER — `CarpoolGroup` itself stores no owner.
 *
 * Adding requires a `Request` between the two users because that request *is*
 * the invitation; without it a rider could self-join any stranger's group. Two
 * things beyond existence are required: the caller has to be the person it was
 * addressed to — anyone can create a request, so existence alone proves
 * nothing — and it has to be **unused**.
 * `requireAcceptableRequest` is where both are enforced and why.
 *
 * Requests are resolved rather than deleted on acceptance, so the row this
 * check depends on is still there afterwards — which is also what lets
 * `markRequestAccepted` run inside the same transaction as the membership. The
 * cost of keeping it is that a resolved row is indistinguishable from a live
 * invitation unless `status` is read, so `requireAcceptableRequest` checks
 * `status` rather than merely existence.
 *
 * Neither join path admits a pair with a block between them, and
 * `edit` checks the joining rider against every member rather than the driver
 * alone. The remove path and `delete` deliberately ignore blocks, because
 * leaving must always work.
 */

/** Just the Prisma surface these helpers touch, so they are easy to test. */
type PrismaClientLike = Pick<
  PrismaClient,
  "carpoolSearch" | "request" | "$executeRaw"
>;

const forbidden = (message: string) =>
  new TRPCError({ code: "FORBIDDEN", message });

/**
 * A group membership the requested change would contradict.
 *
 * `CONFLICT` rather than `BAD_REQUEST`: the input is well formed and the caller
 * is allowed to ask, but the current state of the data says no. It is also in
 * `NON_RETRYABLE_CODES`, so the client shows it instead of retrying into the
 * same answer three times.
 */
const membershipConflict = (message: string) =>
  new TRPCError({ code: "CONFLICT", message });

/**
 * Prisma's "the row this operation needed is not there any more".
 *
 * Matched on `code` rather than with `instanceof`, because the generated client
 * is re-created by `prisma generate` and a worktree running an older one hands
 * back an error whose prototype is a different class object with the same
 * name - `instanceof` is false, the branch is skipped, and the 500 this exists
 * to remove comes back. The code string is part of Prisma's documented API.
 */
const isMissingRecordError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2025";

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
    select: { id: true, role: true, status: true },
  });

/**
 * Throws unless the caller is the DRIVER of `groupId`.
 *
 * This reads the caller's own role and nothing else, which is sound only while
 * a group can hold one DRIVER. Nothing else can say which of two is the real
 * one, because `CarpoolGroup` stores no owner. Two things keep it at one:
 * `create` and `edit` refuse anyone but a RIDER in the rider slot, and
 * `user.edit` - the only procedure that writes `role` - refuses every role
 * change while the caller is in a group, not only a driver leaving the role:
 * narrower than that would let a grouped rider promote themselves and pass
 * this check. A new path that writes `role` has to keep the
 * same rule, or this check stops meaning anything.
 */
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

/**
 * Throws unless there is a carpool request between these two users that
 * `callerId` is the one entitled to accept.
 *
 * **Existence is not consent.** Checking only that some request existed
 * between the pair, in either direction, with no condition on who is calling,
 * would not be enough: `user.requests.create` lets any signed-in user create a
 * request to any other user unilaterally, so the caller could manufacture the
 * very thing taken as proof by sending a request and then "accepting" it
 * themselves. A rider could walk into any driver's group — and a
 * driver could pull in any rider — spending a seat and, through `groups.me`,
 * disclosing the other person's exact home coordinates and email address, which
 * `convertCarpoolSearchToPublicWithExactHome` releases to group members.
 *
 * The invariant is direction. A `Request` records who asked
 * (`fromUserId`) and who was asked (`toUserId`), and **only the person it was
 * addressed to has agreed to anything**. So the rule is simply that the caller
 * must be `toUserId`. Both legitimate flows satisfy it, because the accepter is
 * always the recipient:
 *
 *   - a rider asks a driver, the driver accepts   -> caller is the driver, `toUserId` is the driver
 *   - a driver asks a rider, the rider accepts    -> caller is the rider, `toUserId` is the rider
 *
 * The UI works this way already and is where the rule comes from:
 * `MessagePanel.handleAccept` reads `selectedUser.incomingRequest`, and
 * `MessageHeader` only renders Accept for an *incoming* request. `incomingRequest`
 * is built in `index.tsx` from `requests.received`, which is exactly
 * `toUserId === me`. This check is what makes the rule hold on the server too.
 *
 * The either-direction lookup stays. Direction of the *request* is not the
 * constraint — a request may travel either way — direction relative to the
 * *caller* is.
 *
 * **The request must also still be outstanding.** Established elsewhere is *who*
 * may accept; this is *how long* an acceptance stays valid, and the answer is
 * "until it is used". `markRequestAccepted` resolves the row rather than
 * deleting it, so an `ACCEPTED` request outlives the group it created — and
 * without this check it went on satisfying every condition above forever. A
 * driver whose rider left could put them straight back with no fresh
 * agreement, repeatedly, and nothing would tell the rider: group mutations
 * send no email and fire no Pusher event.
 *
 * Requiring `PENDING` is not circular, though requiring `ACCEPTED` would be:
 * accepting is what *sets* `ACCEPTED`, in the transaction that follows this
 * check, so at this point a live invitation is always still `PENDING`.
 *
 * The way back is already built. `requests.create` finds a resolved row and
 * reopens it — `status: PENDING`, with `fromUserId`/`toUserId` rewritten so
 * whoever is asking now is the sender — which makes the *other* party the
 * accepter, exactly as a first request does. So a pair who once carpooled can
 * carpool again; they just have to ask again. That is the point.
 */
const requireAcceptableRequest = async (
  prisma: PrismaClientLike,
  callerId: string,
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
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      status: true,
    },
  });

  if (!request) {
    throw forbidden(
      "A carpool request between these users is required before they can share a group.",
    );
  }

  if (request.toUserId !== callerId) {
    throw forbidden(
      "Only the person a carpool request was sent to can accept it.",
    );
  }

  // Distinguished from "no request exists" above on purpose: the two refusals
  // call for different things from the user, and collapsing them into one
  // message would tell someone whose invitation is merely spent that they have
  // no relationship with the other person at all.
  if (request.status !== RequestStatus.PENDING) {
    throw forbidden(
      "That carpool request has already been used. Send a new request to " +
        "carpool with this person again.",
    );
  }

  return request;
};

/**
 * Resolves the request that led to this membership.
 *
 * Building the group without also resolving the `Request` would leave it
 * pending forever in both users' Requests tab, and the duplicate guard in
 * `requests.create` would block the pair from ever requesting each other
 * again — which is why this runs as part of accepting.
 *
 * Called inside the same transaction as the membership write, so group state
 * and request state cannot disagree: either both land or neither does. Matched
 * on the pair rather than an id captured earlier, so it does not depend on a
 * read taken before the transaction opened.
 *
 * **`status = PENDING` in the WHERE is the guard, and the match count is
 * checked.** A bare `request.updateMany` whose result is discarded would make
 * `requireAcceptableRequest`'s PENDING check merely advisory: that check runs
 * *outside* the transaction, so between it and this write the rider can
 * withdraw (`requests.delete`) or a concurrent accept can resolve the same
 * request. Discarding the result would let such a write match nothing, say
 * nothing, and the transaction commit anyway - a carpool group existing with
 * no request behind it, and a seat spent on an invitation that had been taken
 * back. Checking the predicate here makes it a real compare-and-swap:
 * whichever transaction flips `PENDING` wins, and the loser rolls the group
 * and the seat back with it.
 *
 * A raw `UPDATE`, not `request.updateMany`, for the same reason as the seat
 * and membership claims above: verified against a real MySQL, `updateMany`'s
 * WHERE matched this transaction's own REPEATABLE READ snapshot rather than
 * the current committed row, so a row another transaction had already
 * resolved - or deleted - still looked `PENDING` to it.
 *
 * Also marks the acceptance email as owed, in the same statement that flips
 * `status`: `acceptanceNotificationPendingSince`. Because the flip is
 * exclusive, this write is always a genuine new acceptance, never a repeat of
 * one already recorded. `sendAcceptanceNotification` clears the marker in one
 * conditional `UPDATE` before it sends, the same primitive
 * `sendRequestNotification` and `sendMessageNotification` use.
 *
 * The timestamp is a parameter rather than SQL's `NOW(3)` so it stays the
 * application clock's value, which is what the column has always held and what
 * `sendAcceptanceNotification` reads back and restores on a send failure.
 * Identifiers are backtick-quoted to match `email.ts`'s raw statements against
 * this same table.
 */
const markRequestAccepted = async (
  prisma: PrismaClientLike,
  driverId: string,
  riderId: string,
) => {
  const accepted = await prisma.$executeRaw`
    UPDATE \`request\`
    SET \`status\` = ${RequestStatus.ACCEPTED},
        \`acceptanceNotificationPendingSince\` = ${new Date()}
    WHERE \`status\` = ${RequestStatus.PENDING}
      AND ((\`fromUserId\` = ${driverId} AND \`toUserId\` = ${riderId})
        OR (\`fromUserId\` = ${riderId} AND \`toUserId\` = ${driverId}))
  `;

  if (accepted === 0) {
    throw membershipConflict(
      "That carpool request was withdrawn or already accepted while this " +
        "request was being processed. Ask them to send a new request.",
    );
  }
};

/**
 * Takes one seat from the driver, atomically.
 *
 * A raw `UPDATE`, not `carpoolSearch.updateMany`, for the same reason as the
 * rider-linking compare-and-swaps below, which use the identical primitive:
 * verified against a real MySQL, `updateMany`'s `WHERE` matches a concurrent
 * transaction's own REPEATABLE READ snapshot rather than the row's current
 * committed state, so two riders accepted at the same instant could both see
 * a seat free and both decrement.
 *
 * `> 0` has to keep meaning what `SEAT_AVAILABLE_FILTER` (`{ gt: 0 }`, in
 * `carpoolSeats.ts`) means, the same way that filter already has to agree
 * with `hasSeatAvailable` - there is no Prisma filter object left to import
 * once the query is raw SQL, so this is the one site that predicate has to be
 * re-stated rather than shared.
 *
 * `seats_avail`, not `seatsAvail`: raw SQL bypasses Prisma's field mapping, and
 * this column has one (`@map("seats_avail")`) where `userId` and `carpoolId`
 * on the sibling raw queries below do not.
 */
const reserveSeat = async (prisma: PrismaClientLike, driverUserId: string) => {
  const reserved = await prisma.$executeRaw`
    UPDATE carpool_search
    SET seats_avail = seats_avail - 1
    WHERE userId = ${driverUserId} AND seats_avail > 0
  `;

  if (reserved === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: NO_SEATS_MESSAGE });
  }
};

/**
 * Gives seats back to a driver, atomically. The mirror of `reserveSeat`.
 *
 * A read-modify-write shape here - `clampSeats(currentSeats + n)` using a
 * `currentSeats` read earlier in the same transaction - would be unsafe: the
 * clamp caps the *result* at the maximum, but does nothing about the *input*
 * being stale. Under MySQL REPEATABLE READ that earlier read is a snapshot,
 * so a `reserveSeat` committed in between would simply be overwritten by the
 * absolute write: a driver with one free seat whose rider leaves while
 * another rider is being accepted would end up advertising two, and the car
 * would be overbooked by one.
 *
 * So there is no read of the current value at all - the increment happens
 * where the truth is, inside the one statement, exactly as `reserveSeat`'s
 * decrement does.
 *
 * `GREATEST(0, LEAST(seats_avail + n, MAX))` is `clampSeats` expressed in SQL.
 * A bare `LEAST` would bound the result to (-inf, MAX] rather than [0, MAX],
 * which would treat the out-of-range rows left by past accounting bugs
 * differently - see `isSeatCountInRange` in `carpoolSeats.ts` and
 * `scripts/repair-seat-residue.ts`, which own repairing those. This function
 * credits them to 0 the way `clampSeats` does, rather than changing what a
 * release does to a corrupted row.
 *
 * `date_modified` is assigned explicitly because raw SQL bypasses Prisma's
 * `@updatedAt`; there is no `carpoolSearch.update` call here to maintain the
 * column otherwise.
 *
 * `seats_avail`, not `seatsAvail` - see `reserveSeat` above on the field
 * mapping raw SQL does not get.
 */
const releaseSeats = async (
  prisma: PrismaClientLike,
  carpoolSearchId: string,
  seatsToRelease: number,
) => {
  await prisma.$executeRaw`
    UPDATE carpool_search
    SET seats_avail = GREATEST(0, LEAST(seats_avail + ${seatsToRelease}, ${MAX_SEATS_AVAILABLE})),
        date_modified = NOW(3)
    WHERE id = ${carpoolSearchId}
  `;
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
    // has neither. Returning null rather than throwing BAD_REQUEST or NOT_FOUND
    // keeps the client from confusing this with the server being broken, which
    // would otherwise send React Query into three retries on the way to an
    // error state.
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

    // Preferences belong to the driver's own search and are read through the
    // group rather than copied into it. Riders see the driver's values.
    const driverSearch = memberCarpoolSearches.find(
      (search) => search.role === Role.DRIVER,
    );

    // A group with no DRIVER member is not an ordinary state - it is the
    // driverless failure, which `user.edit` and `edit` both refuse to create.
    // Rows that predate those guards can still be in this state, and without
    // this flag they would be indistinguishable from a driver who simply
    // saved no preferences: both produce four nulls. Saying so explicitly is
    // what lets the group page explain itself rather than quietly showing
    // blank notes.
    const hasDriver = driverSearch !== undefined;

    const updatedGroup = {
      ...group,
      hasDriver,
      preferences: {
        groupNotes: driverSearch?.groupNotes ?? null,
        groupMusicPreference: driverSearch?.groupMusicPreference ?? null,
        groupConversationStyle: driverSearch?.groupConversationStyle ?? null,
      },
      // Group members are counterparts: they have agreed to carpool together and
      // the group route is drawn from their home coordinates, so these keep full
      // precision.
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
      await requireAcceptableRequest(
        ctx.prisma,
        callerId,
        input.driverId,
        input.riderId,
      );

      // Seat, group and both memberships commit together.
      //
      // Reserving first is still right — the compare-and-swap is the step that
      // can legitimately fail, so it should fail before anything is built.
      // Doing this outside a transaction would only move the damage: a failure
      // after the decrement would take a seat from the driver and create no
      // group, with nothing to give it back.
      return await ctx.prisma.$transaction(async (tx) => {
        // Two invariants that were only ever enforced in the client, read
        // inside the transaction so two accepts racing for the same rider
        // cannot both see "not in a group" and then both write one. Sequential
        // rather than `Promise.all`: an interactive transaction is one
        // connection, and Prisma does not promise parallel queries on it.
        const driverSearch = await tx.carpoolSearch.findFirst({
          where: { userId: input.driverId },
          select: { role: true, status: true, carpoolId: true },
        });

        if (!driverSearch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Driver not found",
          });
        }

        const riderSearch = await tx.carpoolSearch.findFirst({
          where: { userId: input.riderId },
          select: { role: true, status: true, carpoolId: true },
        });

        if (!riderSearch) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Rider not found",
          });
        }

        // Without this check, two riders with a request between them could
        // name one of themselves and create a group with no DRIVER in it -
        // the driverless state, which no member can manage or dissolve.
        // `reserveSeat` below would not catch it either: `user.edit` accepts
        // `seatAvail` for any role and only the client zeroes it for a rider,
        // so a rider can carry seats.
        if (driverSearch.role !== Role.DRIVER) {
          throw forbidden(
            "Only a driver can be the driver of a carpool group.",
          );
        }

        // And symmetrically, the rider slot has to hold a RIDER. The check
        // above only closes the driver slot, leaving the mirror image open:
        // two DRIVERs with a request between them, whichever of them accepts,
        // would name the other as the rider. That would pass every check here
        // - it would spend one of the accepter's seats on somebody who is not
        // riding with them, and leave a group whose two members both believe
        // they are driving.
        //
        // Reachable because `user.requests.me` does not hide a request whose
        // pair changed role, so the Accept button can appear for one. The
        // client refuses it first (`roleMismatchExplanation`), for a message
        // that can name whose role moved; this is the half that a stale cache
        // or a direct call cannot get around.
        if (riderSearch.role !== Role.RIDER) {
          throw forbidden("Only a rider can join a carpool group as a rider.");
        }

        // Pausing a search is the status half of the same problem the two role
        // checks above solve: `requests.me` does not hide a request whose
        // counterpart has paused, so the Accept button can appear for those as
        // well. The roles in such a pair usually still fit — a paused RIDER
        // and an active DRIVER pass every check above — so this is the case a
        // role-only guard admits, which is why `status` is checked here too.
        //
        // Both slots, not just the counterpart's: whichever side paused, the
        // group being built is one of the two people is not looking for.
        // `validateRequestAcceptance` refuses it first, for a message that can
        // name them; this is the half a stale cache or a direct call cannot get
        // around.
        if (driverSearch.status === Status.INACTIVE) {
          throw forbidden(
            "That driver has paused their carpool search, so they cannot " +
              "start a group right now.",
          );
        }

        if (riderSearch.status === Status.INACTIVE) {
          throw forbidden(
            "That rider has paused their carpool search, so they cannot " +
              "join a group right now.",
          );
        }

        // Overwriting an existing membership would leave the old group behind
        // holding one member, which nothing dissolves: the `remainingMembers`
        // check runs in the mutation that removes someone, and that is a
        // different group from this one. The old driver's seat would never be
        // returned either.
        if (driverSearch.carpoolId) {
          throw membershipConflict(
            "You are already in a carpool group. Leave it before starting " +
              "another.",
          );
        }

        if (riderSearch.carpoolId) {
          throw membershipConflict(
            "That user is already in a carpool group. They need to leave it " +
              "before joining yours.",
          );
        }

        // A blocked pair cannot share a group. Last among the
        // refusals and before the seat, so nothing has been written when it
        // throws. `user.blocks.block` enforces the other half: it refuses to
        // block someone the caller already shares a group with.
        //
        // This is a plain, non-locking read, and stays one: it is cheap and
        // catches the ordinary case before anything is reserved. It answers
        // from this transaction's snapshot, so a block landing after this
        // point but before the claim below commits would be invisible to it
        // - closed by the locking recheck after `riderLinked`, not here. See
        // the long comment on `applyBlock` in `blocks.ts` for the full
        // picture.
        await assertNotBlocked(tx, input.driverId, input.riderId);

        await reserveSeat(tx, input.driverId);

        // The group holds no preferences of its own - those are read through
        // the driver's own search.
        const group = await tx.carpoolGroup.create({ data: {} });

        // update driver's CarpoolSearch
        //
        // A raw `UPDATE`, not `tx.carpoolSearch.updateMany`, for the same
        // reason as the rider link below: verified against a real MySQL,
        // `updateMany`'s WHERE matches this transaction's own REPEATABLE READ
        // snapshot rather than the row's current committed state, so two
        // concurrent accepts against a driver with 2+ seats could both pass
        // the membership check above, both reserve a seat, and both overwrite
        // `carpoolId` here - whichever commits last "wins", leaving the other
        // transaction's group linked to a real rider but no driver.
        const driverLinked = await tx.$executeRaw`
          UPDATE carpool_search
          SET carpoolId = ${group.id}
          WHERE userId = ${input.driverId} AND carpoolId IS NULL
        `;

        if (driverLinked === 0) {
          throw membershipConflict(
            "You are already in a carpool group. Leave it before starting " +
              "another.",
          );
        }

        // Re-checks role and membership against the current row rather than
        // trusting `riderSearch` above, which is this transaction's snapshot
        // and can be stale by now: a concurrent `user.edit` can flip this
        // same rider to DRIVER between that read and this write.
        //
        // A raw `UPDATE`, not `tx.carpoolSearch.updateMany` - see the long
        // comment on the equivalent guard in `user.ts`'s `saveProfile` for
        // why: verified against a real MySQL, `updateMany`'s WHERE matched
        // this transaction's own snapshot on this Prisma version rather than
        // the current committed row, so it did not actually close the race.
        const riderLinked = await tx.$executeRaw`
          UPDATE carpool_search
          SET carpoolId = ${group.id}
          WHERE userId = ${input.riderId} AND role = ${Role.RIDER} AND carpoolId IS NULL
        `;

        if (riderLinked === 0) {
          throw membershipConflict(
            "That rider's role or group membership changed while this " +
              "request was being accepted. Ask them to send a new request.",
          );
        }

        // A second, locking check against the pair just linked:
        // `assertNotBlocked` above answered from this transaction's snapshot,
        // taken before this point, so a block a concurrent transaction
        // committed afterward would be invisible to it. This one forces a
        // current read and holds a lock `applyBlock`'s own upsert has to wait
        // behind - see the long comment on `assertNotBlockedForUpdate` in
        // `../../db/blocks.ts` for why that is what actually closes the race
        // rather than merely narrowing it.
        await assertNotBlockedForUpdate(tx, input.driverId, input.riderId);

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
      // commit together. Members are detached before the group row is
      // deleted, so a failure in between would leave a group nobody points at
      // — and it could not be cleaned up through the app at all: retrying
      // reaches `requireGroupDriver` above, whose membership lookup is
      // `{ userId, carpoolId: groupId }`, which would match nothing, so the
      // driver would be told they are not a member of their own group. Only
      // manual SQL could clear it. The guard in `me` above is what this class
      // of orphan looks like from the read side.
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
        //
        // A raw `UPDATE` rather than `tx.carpoolSearch.updateMany`, because
        // the number of rows it detaches is what the seat credit below is
        // derived from, and that has to be a current read. `memberCarpoolSearches`
        // above is this transaction's REPEATABLE READ snapshot: a rider
        // accepted between that read and this write is invisible to it, so
        // counting it would credit the driver one seat short of the riders
        // actually released. InnoDB gives this statement the current row set
        // instead, which is exactly the membership being dissolved.
        const detached = await tx.$executeRaw`
          UPDATE carpool_search
          SET carpoolId = NULL, date_modified = NOW(3)
          WHERE carpoolId = ${input.groupId}
        `;

        // The seats belong to the driver, whoever pressed the button - reading
        // and writing the *session user's* row instead would let a rider
        // deleting the group take the seats while the driver never got them
        // back. The driver's *identity* is taken from the membership captured
        // above, before the carpoolIds were cleared - it has to be, because
        // the rows it is derived from no longer point at the group - but that
        // is safe where the count would not be: `user.edit` refuses every role
        // change while the caller is in a group, so who the driver is cannot
        // move under this transaction, only how many riders there are.
        //
        // `detached > 1` is "there were riders": the driver is one of the
        // detached rows, so anything less is a group of one and nothing to
        // credit. Stated rather than left to arithmetic, because the other
        // way for `detached` to come back low is a concurrent dissolution
        // that cleared the rows this transaction's snapshot still shows -
        // and `releaseSeats` given a negative count would *take* a seat.
        // That transaction rolls back on the `carpoolGroup.delete` below
        // either way, but a write that only survives by being undone is not
        // something to rely on.
        if (driver && detached > 1) {
          // Every detached member other than the driver was occupying a seat.
          await releaseSeats(tx, driver.id, detached - 1);
        }

        // A group row that is already gone is a bad request, not a fault.
        //
        // Unlike the other existence checks in this file this one cannot be a
        // read beforehand, because the condition arises *between* any such read
        // and this statement. `requireGroupDriver` above only ever reads
        // `carpool_search`, never `carpool_group`, so two routes get here with
        // the group row missing: a concurrent `delete`, or an `edit` whose
        // dissolution path (`tx.carpoolGroup.delete`, below) landed in between.
        // Prisma answers both with `P2025`, which is not a `TRPCError` - left
        // uncaught it would reach the client as a masked 500 that the query
        // layer retries twice more into the same answer.
        //
        // Throwing here still aborts the transaction, so the detach above and
        // the seat credit roll back together - which is right: this call did
        // not dissolve the group, and whoever did credited the seats already.
        try {
          return await tx.carpoolGroup.delete({
            where: {
              id: input.groupId,
            },
          });
        } catch (error) {
          if (isMissingRecordError(error)) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Group does not exist",
            });
          }
          throw error;
        }
      });
    }),
  edit: protectedRouter
    .input(
      z.object({
        // Meaningful on the `add` path only, where it is checked against the
        // group and against a request between the two users. The remove path
        // deliberately ignores it and derives the driver from the group's own
        // membership instead - trusting it here would credit a seat to this
        // id unchecked.
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
        // driver's group themselves. Both come out of *accepting* a request, so
        // one has to exist and the caller has to be the person it was sent to —
        // existence alone proves nothing, because anyone can create a request
        // to anyone. See `requireAcceptableRequest`.
        if (callerId !== input.driverId && callerId !== input.riderId) {
          throw forbidden(
            "You can only add someone to your own carpool group.",
          );
        }
        await requireAcceptableRequest(
          ctx.prisma,
          callerId,
          input.driverId,
          input.riderId,
        );

        // The target group must actually be the named driver's group.
        const driverMembership = await membershipOf(
          ctx.prisma,
          input.driverId,
          input.groupId,
        );
        if (!driverMembership || driverMembership.role !== Role.DRIVER) {
          throw forbidden("That carpool group does not belong to this driver.");
        }

        // The driver's own status, checked here rather than in the transaction
        // below because this is where the driver is resolved. This is the path
        // a *rider* takes when accepting the request of a driver who already
        // has a group, so without it a paused driver still gains riders — the
        // `create` equivalent is inside the transaction with the two role
        // checks.
        if (driverMembership.status === Status.INACTIVE) {
          throw forbidden(
            "That driver has paused their carpool search, so nobody can join " +
              "their group right now.",
          );
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

        // A driver leaving a group of three or more strands the rest. The
        // group survives - dissolution below only triggers at one remaining
        // member - but has no DRIVER, and `requireGroupDriver` then refuses
        // every management action, so the riders cannot remove each other or
        // dissolve it. At two members the group dissolves on the way out, so
        // leaving is harmless there and stays allowed.
        if (
          callerMembership.role === Role.DRIVER &&
          input.riderId === callerId
        ) {
          const memberCount = await ctx.prisma.carpoolSearch.count({
            where: { carpoolId: input.groupId },
          });

          if (memberCount > 2) {
            throw forbidden(
              "Remove the other riders before leaving, or dissolve the " +
                "group instead.",
            );
          }
        }
      }

      // Membership change, group dissolution and seat accounting commit
      // together. Untransactioned, adding could take a seat without
      // linking the rider, and removing could detach the rider without ever
      // giving the seat back — an under-count with nothing to correct it.
      //
      // The boundary stops before the trailing read. Reads cannot leave partial
      // state, so they gain nothing from being inside it, and keeping the read
      // out means a group this procedure legitimately dissolved is never
      // resurrected by a rollback.
      const dissolved = await ctx.prisma.$transaction(async (tx) => {
        // The driver to credit on the remove path, resolved before anything
        // below moves memberships. It has to be captured this early: clearing
        // the departing member and dissolving the group both erase the very
        // `carpoolId` rows the driver is derived from, so reading it after the
        // fact would find nobody.
        let groupDriver: { id: string } | null = null;

        if (input.add) {
          // One group per user, checked in here for the same reason as in
          // `create`. Two cases the checks below guard against:
          //
          //   - Already in another group. Without the check, the rider would
          //     be linked into this group anyway, leaving the old group
          //     holding one member that nothing dissolves and its driver a
          //     seat short for good.
          //   - Already in *this* group. `markRequestAccepted` resolves the
          //     request rather than deleting it, so the row survives and
          //     `requireAcceptableRequest` keeps passing - without the check,
          //     a second call would run `reserveSeat` again while the linking
          //     update matched nothing, and the driver would pay two seats
          //     for one rider.
          const riderSearch = await tx.carpoolSearch.findFirst({
            where: { userId: input.riderId },
            select: { role: true, status: true, carpoolId: true },
          });

          if (!riderSearch) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Rider not found",
            });
          }

          // The rider slot has to hold a RIDER, for the same reason as in
          // `create`. This is the path an accept takes when the
          // driver already has a group, so leaving it out would close the
          // first join and not the second.
          if (riderSearch.role !== Role.RIDER) {
            throw forbidden(
              "Only a rider can join a carpool group as a rider.",
            );
          }

          // And the rider's status, for the same reason as in `create`: this
          // is the path an accept takes when the driver already has a group,
          // so leaving it out would close the first join and not the second.
          if (riderSearch.status === Status.INACTIVE) {
            throw forbidden(
              "That rider has paused their carpool search, so they cannot " +
                "join a group right now.",
            );
          }

          if (riderSearch.carpoolId === input.groupId) {
            throw membershipConflict(
              "That user is already in this carpool group.",
            );
          }

          if (riderSearch.carpoolId) {
            throw membershipConflict(
              "That user is already in a carpool group. They need to leave " +
                "it before joining yours.",
            );
          }

          // Against every current member, not only the driver. A rider who
          // blocked another rider, or was blocked by one, would otherwise
          // share a group with them through the driver, which is the state
          // `user.blocks.block` refuses to create from the other side.
          //
          // Same plain read as `create`'s equivalent check above, and the
          // same reason it stays one: cheap, and closed for the racing case
          // by the locking recheck after `riderLinked` below rather than
          // here. See the comment on `applyBlock` in `blocks.ts`.
          const members = await tx.carpoolSearch.findMany({
            where: { carpoolId: input.groupId },
            select: { userId: true },
          });
          await assertNotBlocked(
            tx,
            input.riderId,
            members.map((member) => member.userId),
          );

          // Reserve the seat before linking the rider: the compare-and-swap
          // both rejects a full driver and prevents two simultaneous accepts
          // from taking the same seat. A read-compare-then-decrement could do
          // neither reliably.
          await reserveSeat(tx, input.driverId);

          // Re-checks role and membership against the current row rather
          // than trusting `riderSearch` above, for the same reason as
          // `create`: this transaction's snapshot of it can be stale by now,
          // because a concurrent `user.edit` can flip this rider to DRIVER
          // in between. A raw `UPDATE`, not
          // `tx.carpoolSearch.updateMany` - see the comment on `create`'s
          // equivalent guard above.
          const riderLinked = await tx.$executeRaw`
            UPDATE carpool_search
            SET carpoolId = ${input.groupId}
            WHERE userId = ${input.riderId} AND role = ${Role.RIDER} AND carpoolId IS NULL
          `;

          if (riderLinked === 0) {
            throw membershipConflict(
              "That rider's role or group membership changed while this " +
                "request was being accepted. Ask them to send a new request.",
            );
          }

          // Same recheck as `create`, against every current member rather
          // than only the driver - see the comment on `assertNotBlocked`
          // above and on `assertNotBlockedForUpdate` in `../../db/blocks.ts`
          // for why a locking read is what actually closes the race rather
          // than merely narrowing it.
          await assertNotBlockedForUpdate(
            tx,
            input.riderId,
            members.map((member) => member.userId),
          );

          await markRequestAccepted(tx, input.driverId, input.riderId);
        } else {
          // The seat goes back to the group's own driver, found through the
          // group rather than taken from client input. `driverId` is not
          // validated on this path - the checks above constrain `callerId` and
          // `riderId` and nothing else - so crediting `input.driverId` would
          // write to whatever row the caller named: a stranger would get a
          // seat and the real driver would stay permanently under-counted.
          // `delete` above already derives the driver this way.
          groupDriver = await tx.carpoolSearch.findFirst({
            where: { carpoolId: input.groupId, role: Role.DRIVER },
            select: { id: true },
          });

          // when removing rider, clear carpoolId for the rider
          //
          // Scoped to *this* group and count-checked, which is what makes the
          // seat credit below happen exactly once. Two removals of the same
          // member race routinely - a double submit, or a driver evicting
          // while the rider presses Leave - and both pass the
          // `targetMembership` check above, because that check runs before the
          // transaction and answers from a snapshot. Matching on `userId`
          // alone would find the row whether or not it was still in the group
          // and always report a change, so `releaseSeats` would run for both:
          // the driver would be credited twice for one departure and the car
          // would be overbooked.
          //
          // A raw `UPDATE`, not `tx.carpoolSearch.updateMany`, for the reason
          // the claims on the add path give: `updateMany`'s WHERE was verified
          // against a real MySQL to match this transaction's own snapshot
          // rather than the current committed row, so it would go on matching
          // a membership another transaction had already cleared.
          const unlinked = await tx.$executeRaw`
            UPDATE carpool_search
            SET carpoolId = NULL, date_modified = NOW(3)
            WHERE userId = ${input.riderId} AND carpoolId = ${input.groupId}
          `;

          // The same refusal as the pre-transaction `targetMembership` check,
          // stated where it is authoritative. Throwing rolls the whole
          // transaction back, so the loser of the race neither credits a seat
          // nor dissolves a group the winner is already dissolving.
          if (unlinked === 0) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "That user is not a member of this carpool group.",
            });
          }
        }

        // Check if group should be deleted (only 1 member left)
        const remainingMembers = await tx.carpoolSearch.findMany({
          where: { carpoolId: input.groupId },
        });

        // A carpool of one is not a carpool, so the group goes. Reported out of
        // the transaction rather than re-derived after it, because a later read
        // cannot tell "this procedure just dissolved it" from "it is missing for
        // some other reason" — conflating them would report both as an error.
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

        // Adding already took its seat above. Removing gives one back to the
        // group's driver, clamped to the shared maximum.
        //
        // A group with no DRIVER member has nobody to credit, so the credit is
        // skipped rather than failed. That state is the driverless failure -
        // guarded against for new groups, but older rows can still be in it -
        // and leaving one at a time is the only way its riders can get out.
        // Throwing here would take that away and trap them.
        if (!input.add && groupDriver) {
          await releaseSeats(tx, groupDriver.id, 1);
        }

        return groupDissolved;
      });

      // Dissolving the group is the requested outcome, not a failure. Falling
      // through to the read below would find nothing — because this procedure
      // just deleted it — and throw BAD_REQUEST "Group does not exist". Every
      // caller routes a rejection to "Something went wrong", so leaving a
      // two-person carpool would report failure after succeeding, and the
      // `onSuccess` handlers would never run: no confirmation, the modal
      // staying open, and the React Query invalidations skipped, leaving
      // stale membership on screen.
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

      // The group row and nothing else.
      //
      // Appending `users`, built from an unrestricted `include: { user: true }`,
      // would send every remaining member's whole `User` row back - email,
      // `permission`, `emailVerified`, the licence timestamps. To the wrong
      // person, too: the caller here may be a rider who has just removed
      // themselves, and a departed member is exactly who should not be handed
      // the rest of the group's contact details.
      //
      // Narrowing it through a `PublicUser` converter, as `me` does, would
      // still hand a departed member emails and exact home coordinates. It is
      // dropped outright instead because nothing reads it: both callers use
      // only `data === null` to tell "the group was dissolved" from "it
      // survived", and both invalidate `groups.me` immediately afterwards,
      // which is the read path for members and applies its own projection.
      return group;
    }),
  /**
   * The driver's group ride preferences.
   *
   * There is only one row to write, and it is the caller's own, which is a
   * strong authorization property: this cannot touch anybody else's data, so
   * it needs no driver check. Riders read the driver's values through
   * `groups.me`.
   *
   * All three fields are always written, including as empty strings: a
   * partial write would leave stale values in the fields it skipped rather
   * than merging in only the change, so clearing one field requires writing
   * all three.
   *
   * Lengths are validated here rather than truncated silently.
   */
  updatePreferences: protectedRouter
    .input(
      z.object({
        notes: z.string().max(GROUP_NOTES_MAX_LENGTH),
        musicPreference: z.string().max(GROUP_OPTION_MAX_LENGTH),
        conversationStyle: z.string().max(GROUP_OPTION_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const callerId = requireCallerId(ctx.session.user?.id);

      const search = await ctx.prisma.carpoolSearch.findFirst({
        where: { userId: callerId },
        select: { id: true },
      });

      if (!search) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No carpool search found for this user.",
        });
      }

      return await ctx.prisma.carpoolSearch.update({
        where: { id: search.id },
        data: {
          groupNotes: input.notes,
          groupMusicPreference: input.musicPreference,
          groupConversationStyle: input.conversationStyle,
        },
        select: {
          groupNotes: true,
          groupMusicPreference: true,
          groupConversationStyle: true,
        },
      });
    }),
});
