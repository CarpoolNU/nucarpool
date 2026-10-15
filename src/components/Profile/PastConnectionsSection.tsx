import { format } from "date-fns";
import { Note } from "../../styles/profile";
import { QueryError } from "../QueryError";
import Spinner from "../Spinner";
import { trpc } from "../../utils/trpc";
import UserActionsMenu from "../UserActions/UserActionsMenu";

/**
 * The people the reader used to carpool with, each with Report and Block.
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
 * position recorded on SCRUM-623. The reader already had both while they were
 * carpooling. `driverId`, `formedAt` and `groupId` are on the row and the
 * procedure never returns them.
 *
 * No `requestId` is passed to the menu: the conversation a report would have
 * snapshotted is gone, `reports.create` takes `requestId` as optional, and a
 * report filed from here simply carries no snapshot.
 */
const PastConnectionsSection = () => {
  const pairings = trpc.user.carpoolPairings.me.useQuery();

  return (
    <section aria-labelledby="past-connections-heading" className="pb-8">
      {/* A heading, not the `EntryLabel` the fields above use: that renders a
          `<label>`, and there is no field here for it to label. */}
      <h2
        id="past-connections-heading"
        className="font-montserrat mt-4 mb-4 text-2xl font-bold"
      >
        People You&apos;ve Carpooled With
      </h2>

      {pairings.isPending ? (
        <Spinner />
      ) : pairings.isError ? (
        <QueryError
          subject="your past carpools"
          onRetry={() => void pairings.refetch()}
        />
      ) : pairings.data.length === 0 ? (
        <Note className="py-2">You haven&apos;t finished a carpool yet.</Note>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
          {pairings.data.map((entry) => (
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
                */}
                <time
                  dateTime={entry.endedAt.toISOString()}
                  className="font-montserrat block text-sm text-gray-600"
                >
                  Carpooled until {format(entry.endedAt, "MMM dd yyyy")}
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

      <Note className="py-2">
        You can report or block someone you carpooled with in the last 12
        months, even after the carpool has ended. They aren&apos;t told either
        way.
      </Note>
    </section>
  );
};

export default PastConnectionsSection;
