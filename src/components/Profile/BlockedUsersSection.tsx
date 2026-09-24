import { toast } from "react-toastify/unstyled";
import { Note } from "../../styles/profile";
import { QueryError } from "../QueryError";
import Spinner from "../Spinner";
import { trpc } from "../../utils/trpc";
import { invalidateBlockCaches } from "../../utils/blocks/invalidateBlockCaches";

/**
 * The people the reader has blocked, each with Unblock (SCRUM-554).
 *
 * It sits in the profile's Account section and outside its react-hook-form.
 * Unblock is a mutation of its own that takes effect at once, and none of it
 * belongs to "Save Changes". Every button here is `type="button"`, so nothing
 * here can submit the form, and an unblock does not count as an unsaved edit.
 *
 * The list is only people the reader blocked. `user.blocks.me` never returns
 * who blocked *them*.
 */
const BlockedUsersSection = () => {
  const utils = trpc.useUtils();
  const blocked = trpc.user.blocks.me.useQuery();

  const unblock = trpc.user.blocks.unblock.useMutation({
    onSuccess: async (_, variables) => {
      await invalidateBlockCaches(utils);
      const name = blocked.data?.find(
        (entry) => entry.userId === variables.userId,
      )?.name;
      toast.success(name ? `You unblocked ${name}.` : "User unblocked.");
    },
    onError: (error) => {
      toast.error(`Something went wrong: ${error.message}`);
    },
  });

  return (
    <section aria-labelledby="blocked-users-heading" className="pb-8">
      {/* A heading, not the `EntryLabel` the dates above use: that renders a
          `<label>`, and there is no field here for it to label. */}
      <h2
        id="blocked-users-heading"
        className="font-montserrat mt-4 mb-4 text-2xl font-bold"
      >
        Blocked Users
      </h2>

      {blocked.isPending ? (
        <Spinner />
      ) : blocked.isError ? (
        <QueryError
          subject="your blocked users"
          onRetry={() => void blocked.refetch()}
        />
      ) : blocked.data.length === 0 ? (
        <Note className="py-2">You haven&apos;t blocked anyone.</Note>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
          {blocked.data.map((entry) => (
            <li
              key={entry.userId}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <span className="font-montserrat font-medium">{entry.name}</span>
              <button
                type="button"
                disabled={
                  unblock.isPending &&
                  unblock.variables?.userId === entry.userId
                }
                onClick={() => unblock.mutate({ userId: entry.userId })}
                aria-label={`Unblock ${entry.name}`}
                className="rounded-md border border-black px-4 py-2 text-sm font-medium hover:bg-stone-200 disabled:opacity-40"
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}

      <Note className="py-2">
        Blocked users can&apos;t find, request or message you, and you
        won&apos;t see them. Unblocking brings back anything that was hidden.
      </Note>
    </section>
  );
};

export default BlockedUsersSection;
