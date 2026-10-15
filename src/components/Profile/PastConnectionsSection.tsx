import { format } from "date-fns";
import { Note } from "../../styles/profile";
import { QueryError } from "../QueryError";
import Spinner from "../Spinner";
import { trpc } from "../../utils/trpc";
import UserActionsMenu from "../UserActions/UserActionsMenu";

/**
 * The people the reader used to be connected to, each with Report and Block.
 *
 * **Why this screen exists.** `UserActionsMenu` was reachable only from a
 * live user card and a live conversation header, and a parting destroys both:
 * the group row, the `carpoolId`, the `ACCEPTED` request and every message go
 * together. So the thing most worth reporting - something noticed on an
 * actual shared ride, realised afterwards - was the thing least reportable.
 * SCRUM-636 kept the `CarpoolPairing` row that survives all of that, and this
 * is the surface that reads it. This is a third call site for that menu, not
 * a second menu.
 *
 * **Two kinds of connection, one list.** SCRUM-676 added the other half: a
 * pair who exchanged messages, never carpooled, and whose request was then
 * deleted by either party. `MessageContact` records those, and
 * `user.pastConnections.me` merges both records before this sees them - so
 * the component runs one query, holds no merge rule of its own, and does not
 * re-sort or re-group what it is given.
 *
 * The two are labelled apart because they describe different relationships.
 * Telling a reader they carpooled with someone they only exchanged messages
 * with would be a claim about a shared ride that never happened, made to
 * someone who is deciding whether to report that person.
 *
 * It sits in the profile's Account section beside `BlockedUsersSection` and
 * `ReportsFiledSection`, and outside its react-hook-form for the same reason
 * they are: a report or a block takes effect at once and belongs to "Save
 * Changes" not at all.
 *
 * **Nothing here is removed by acting on it.** Blocking someone leaves their
 * row exactly where it was. The list is a record of who the reader rode with,
 * not a list of who is currently actionable - and filtering blocked pairs out
 * of it would mean someone could harass a passenger, block them, and become
 * unreportable, which is the defect this screen exists to close. Every other
 * multi-user surface excludes `blockedCounterpartIds`; this one deliberately
 * does not.
 *
 * **What a row shows is a display name and a date**, which is the visibility
 * position recorded on SCRUM-623 and carried forward unchanged by SCRUM-676.
 * The reader already had both while they were connected. `driverId`,
 * `formedAt` and `groupId` are on the pairing row and the procedure never
 * returns them.
 *
 * No `requestId` is passed to the menu: the conversation a report would have
 * snapshotted is gone, `reports.create` takes `requestId` as optional, and a
 * report filed from here simply carries no snapshot.
 */
const PastConnectionsSection = () => {
  const connections = trpc.user.pastConnections.me.useQuery();

  return (
    <section aria-labelledby="past-connections-heading" className="pb-8">
      {/* A heading, not the `EntryLabel` the fields above use: that renders a
          `<label>`, and there is no field here for it to label. */}
      <h2
        id="past-connections-heading"
        className="font-montserrat mt-4 mb-4 text-2xl font-bold"
      >
        People You&apos;ve Connected With
      </h2>

      {connections.isPending ? (
        <Spinner />
      ) : connections.isError ? (
        <QueryError
          subject="your past connections"
          onRetry={() => void connections.refetch()}
        />
      ) : connections.data.length === 0 ? (
        <Note className="py-2">
          You haven&apos;t connected with anyone yet.
        </Note>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
          {connections.data.map((entry) => (
            <li
              key={entry.userId}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <span className="font-montserrat block font-medium">
                  {entry.name}
                </span>
                {/*
                  `MMM dd yyyy`, the vocabulary `BlockedUsersSection` and
                  `ReportsFiledSection` both use, and minus a clock for the
                  same reason: this answers "when was this", for which the
                  hour does not matter.

                  A `<time>` element, so the machine-readable instant survives
                  the formatting - `superjson` means `endedAt` arrives as a
                  real `Date`, not a string that has to be reparsed.

                  The verb comes from `kind`, which the server decided. A
                  counterpart in both records is a carpool one, because that
                  is the stronger description of the same relationship - see
                  `pastConnections.ts` for why that is not picked by recency.
                */}
                <time
                  dateTime={entry.endedAt.toISOString()}
                  className="font-montserrat block text-sm text-gray-600"
                >
                  {entry.kind === "CARPOOLED" ? "Carpooled" : "Messaged"} until{" "}
                  {format(entry.endedAt, "MMM dd yyyy")}
                </time>
              </div>
              <UserActionsMenu
                userId={entry.userId}
                userName={entry.name}
                className="flex-shrink-0"
              />
            </li>
          ))}
        </ul>
      )}

      {/*
        The window is written out rather than imported. Both retention
        constants live in modules that pull `@prisma/client` in, which has no
        business in a client bundle. `PastConnectionsSection.test.tsx` imports
        them instead, where the bundle does not matter, and asserts both that
        the number here matches and that the two windows still agree - so a
        change to either policy fails that test rather than quietly leaving
        this screen telling users the wrong number.
      */}
      <Note className="py-2">
        You can report or block someone you carpooled with or messaged in the
        last 12 months, even after the connection has ended. They aren&apos;t
        told either way.
      </Note>
    </section>
  );
};

export default PastConnectionsSection;
