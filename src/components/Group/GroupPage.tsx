import { Dialog } from "@headlessui/react";
import { useRouter } from "next/router";
import { useCallback, useContext, useEffect, useState } from "react";
import { FaTimes } from "react-icons/fa";
import { GroupMembers } from "./GroupMemberCard";
import { trpc } from "../../utils/trpc";
import { UserContext } from "../../utils/userContext";
import { Role } from "@prisma/client";
import Spinner from "../Spinner";
import { PublicUser, User } from "../../utils/types";
import useIsMobile from "../../utils/useIsMobile";
import {
  GroupDetails,
  NOTES_MAX_LENGTH,
  conversationStyleOptions,
  hasAnyDetail,
  musicPreferenceOptions,
} from "./groupDetails";
import { useGroupDetails } from "./useGroupDetails";
import { QueryError } from "../QueryError";

/**
 * The "My Group" screen.
 *
 * This file used to hold two parallel implementations of the feature,
 * mobile and desktop, each with its own data fetching, mutation wiring and
 * handlers. What remains is one container per state - `NoGroupSection` and
 * `GroupSection` - which own the query and delegate every mutation to
 * `useGroupDetails`, plus per-variant view components that are pure markup.
 *
 * The two layouts are genuinely different (a full-screen card stack on mobile, a
 * centred modal on desktop) so they stay as separate views. The rule is that a
 * view may contain no query, no mutation and no business rule.
 */

type Variant = "mobile" | "desktop";

interface GroupPageProps {
  onClose: () => void;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
}

/* -------------------------------------------------------------------------- */
/* Shared presentation                                                        */
/* -------------------------------------------------------------------------- */

const GroupDetailsForm = ({
  details,
  setDetails,
}: {
  details: GroupDetails;
  setDetails: (details: GroupDetails) => void;
}) => (
  <div className="space-y-6">
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Group Message
      </div>
      <textarea
        className="min-h-[96px] w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-red-500 focus:ring-2 focus:ring-red-500"
        maxLength={NOTES_MAX_LENGTH}
        value={details.notes}
        onChange={(e) => setDetails({ ...details, notes: e.target.value })}
        placeholder="Anything else riders should know about the carpool..."
      />
      <p className="mt-1 text-right text-xs text-gray-500">
        {details.notes.length}/{NOTES_MAX_LENGTH}
      </p>
    </div>

    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Personality Preferences
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label
            className="mb-1 block text-sm font-medium text-gray-800"
            htmlFor="group-music-preference"
          >
            Music preference
          </label>
          <select
            id="group-music-preference"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-red-500 focus:ring-2 focus:ring-red-500"
            value={details.musicPreference}
            onChange={(e) =>
              setDetails({ ...details, musicPreference: e.target.value })
            }
          >
            <option value="">Select music preference</option>
            {musicPreferenceOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            className="mb-1 block text-sm font-medium text-gray-800"
            htmlFor="group-conversation-style"
          >
            Conversation style
          </label>
          <select
            id="group-conversation-style"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-red-500 focus:ring-2 focus:ring-red-500"
            value={details.conversationStyle}
            onChange={(e) =>
              setDetails({ ...details, conversationStyle: e.target.value })
            }
          >
            <option value="">Select conversation style</option>
            {conversationStyleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  </div>
);

const GroupDetailsPreview = ({
  details,
  emptyMessage,
}: {
  details: GroupDetails;
  emptyMessage: string;
}) => {
  if (!hasAnyDetail(details)) {
    return (
      <p className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-600">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
      <div className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Current Preferences
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-gray-50 px-3 py-2">
          <span className="font-semibold text-gray-900">Music:</span>{" "}
          {details.musicPreference || "Not set"}
        </div>
        <div className="rounded-md bg-gray-50 px-3 py-2">
          <span className="font-semibold text-gray-900">Conversation:</span>{" "}
          {details.conversationStyle || "Not set"}
        </div>
      </div>
      {details.notes && (
        <div className="rounded-md border border-gray-200 px-3 py-2">
          <div className="mb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase">
            Group Note
          </div>
          <p className="text-sm text-gray-700">{details.notes}</p>
        </div>
      )}
    </div>
  );
};

const PreviewRouteButton = ({
  variant,
  riderCount,
  onClick,
}: {
  variant: Variant;
  riderCount: number;
  onClick: () => void;
}) => {
  const caption =
    riderCount > 0
      ? `View the combined route for ${riderCount + 1} group member${
          riderCount + 1 === 1 ? "" : "s"
        }`
      : "Preview your route as the driver";

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className={
          variant === "mobile"
            ? "flex w-full items-center justify-center space-x-2 rounded-lg bg-red-700 px-4 py-4 font-semibold text-white transition-colors hover:bg-red-800"
            : "bg-northeastern-red flex w-1/2 flex-row items-center justify-center gap-1 rounded-md px-4 py-3 font-medium text-white transition-colors hover:bg-red-700"
        }
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-1.447-.894L15 4m0 13V4m-6 3l6-3"
          />
        </svg>
        <span>Preview Group Route</span>
      </button>
      <p
        className={
          variant === "mobile"
            ? "mt-2 text-center text-xs text-gray-500"
            : "mx-auto mt-2 max-w-xs text-center text-xs text-gray-500"
        }
      >
        {caption}
      </p>
    </>
  );
};

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export const GroupPage = (props: GroupPageProps) => {
  const [isOpen, setIsOpen] = useState<boolean>(true);
  const curUser = useContext(UserContext);
  const isMobile = useIsMobile();
  const router = useRouter();

  // Destructured out here, not read as `props.onClose` inside the callback
  // below, because depending on `props` would rebuild the callback whenever
  // *any* prop changes - which is the fix `react-hooks/exhaustive-deps` names,
  // and CI runs eslint with `--max-warnings=0`.
  const { onClose: requestClose } = props;

  // Memoized because the Escape handler below depends on it: rebuilt every
  // render, it would tear down and re-add the key listener on each one. Note
  // the caller passes an inline arrow (`Header` renders
  // `onClose={() => setDisplayGroup(false)}`), so this bounds the churn rather
  // than removing it - the listener is correct either way.
  const onClose = useCallback(() => {
    setIsOpen(false);
    requestClose();
  }, [requestClose]);

  /**
   * Escape closes the mobile screen.
   *
   * The desktop branch gets this from Headless UI's `Dialog`, which the mobile
   * branch deliberately does not use. `Dialog` would also bring a focus trap,
   * and a trap is wrong here: the bottom navigation is `z-index: 100` against
   * this screen's `z-50`, so it stays visible *and* tappable on top of it.
   * Trapping focus would let a pointer reach the navigation while the keyboard
   * could not, which is a worse state than no trap at all. This is a
   * full-screen view with live navigation over it, not a modal, so it gets the
   * one dismissal behaviour it was missing rather than the whole modal
   * contract.
   *
   * Declared above the `!curUser` early return - hooks cannot sit after a
   * conditional return.
   */
  useEffect(() => {
    if (!isMobile) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, onClose]);

  if (!curUser) {
    return <Spinner />;
  }

  const body = (variant: Variant) =>
    !curUser.carpoolId ? (
      <NoGroupSection role={curUser.role} variant={variant} />
    ) : (
      <GroupSection
        curUser={curUser}
        variant={variant}
        onViewGroupRoute={props.onViewGroupRoute}
        onClose={onClose}
      />
    );

  if (isMobile) {
    return (
      /* `bottom-mobile-nav` rather than the `inset-0` this used to carry.
       * `inset-0` put the overlay's bottom edge at the viewport's, and the
       * bottom navigation is `position: fixed` at `z-index: 100` against this
       * screen's `z-50` - so the nav won both the paint and the hit test over
       * whatever the overlay put down there. That was the sticky action bar
       * holding "Preview Group Route", the group screen's primary action:
       * SCRUM-464 measured 44 of its 56px behind the nav on a 375x667 phone,
       * leaving a 12px strip to tap. The last member card's Leave/Remove
       * button is the same exposure whenever it is the bottom-most thing in
       * the scroll port, which is the `hasDriver` false case, where no action
       * bar renders below it.
       *
       * Reserving the nav's height once here rather than padding the action
       * bar: the scroll port fills this box, so its bottom edge is now the
       * nav's top edge and *nothing* it contains can sit behind the nav, at
       * any scroll position and for any amount of content. The sticky bar
       * inherits that, and so does anything else ever pinned to the bottom of
       * this screen - which is why this is one class here rather than padding
       * on each of them. `MapConnectPortal` solved the same overlap the same
       * way, and `bottom-mobile-nav` is the token SCRUM-412 created for it -
       * it carries `env(safe-area-inset-bottom)`, which a hand-written offset
       * would not.
       *
       * The nav stays visible and tappable over this view by design; see this
       * file's test for why it is a full-screen view with live navigation
       * rather than a modal. */
      <div className="bottom-mobile-nav fixed inset-x-0 top-0 z-50 bg-white">
        <div className="flex h-full flex-col bg-gray-50">
          {/* `mt-6` only on `/`: it clears `MobileBanner`, whose only render
           * site is `src/pages/index.tsx`. This overlay portals to
           * `document.body` on every route (`Header.tsx`'s mobile branch), so
           * unconditional `mt-6` left a 24px empty strip above this header on
           * every other route - there is no banner there to clear (SCRUM-504).
           * If `/` gets a banner-free future, this condition is also this
           * component's only remaining tie to the banner and comes out with it. */}
          <div
            className={`flex items-center border-b border-gray-200 bg-white px-4 py-3 shadow-xs ${
              router.pathname === "/" ? "mt-6" : ""
            }`}
          >
            {/* The way out. This header held the title alone, so the only exit
             * from My Group on a phone was tapping a different navigation tab -
             * the desktop branch has dismissed on backdrop click and Escape all
             * along, from `Dialog`.
             *
             * `FaTimes` and "Close" rather than a back chevron, matching the
             * filter panel: this dismisses an overlay sitting on the map, it
             * does not navigate anywhere, and the tab bar underneath is what
             * actually moves between screens. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close My Group"
              className="focus-visible:outline-northeastern-red p-3 text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <FaTimes size={20} aria-hidden="true" />
            </button>
            <h1 className="flex-1 text-center text-lg font-semibold text-gray-900">
              My Group
            </h1>
            {/* Balances the button so the title stays centred, which
             * `justify-center` did for free when the button did not exist.
             *
             * `w-11` is 44px, matching the button exactly: `p-3` either side of
             * a 20px glyph. The padding is sized for a touch target rather than
             * for the glyph - at the icon's own size this would be a 20px
             * target, well under the 44px guideline. No negative margin pulling
             * the button outward, deliberately: that would make it consume less
             * of the flex line than the spacer reserves and push the title
             * off-centre by the difference. */}
            <span className="w-11" aria-hidden="true" />
          </div>
          <div className="flex-1 overflow-auto">{body("mobile")}</div>
        </div>
      </div>
    );
  }

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      {/* Backdrop and panel are siblings. While the backdrop wrapped the
       * panel, its `aria-hidden` covered the whole subtree - the group-details
       * form, "Preview Group Route", "Leave Group", "Remove", "Delete Group" -
       * and no descendant can opt back in. SCRUM-475. The `relative z-50` on
       * `Dialog` above is the stacking context both of these sit in, so DOM
       * order alone puts the panel over the blur. */}
      <div className="fixed inset-0 backdrop-blur-xs" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="flex h-4/6 w-4/6 flex-col content-center justify-start gap-1 overflow-y-auto rounded-md bg-white py-9 shadow-lg">
          <div className="relative">
            <Dialog.Title className="text-center text-3xl font-bold">
              My Group
            </Dialog.Title>
          </div>
          {body("desktop")}
        </Dialog.Panel>
      </div>
    </Dialog>
  );
};

/* -------------------------------------------------------------------------- */
/* Containers - the only place group data is fetched or written               */
/* -------------------------------------------------------------------------- */

const NoGroupSection = ({
  role,
  variant,
}: {
  role: Role;
  variant: Variant;
}) => {
  const { data: user } = trpc.user.me.useQuery();
  const { details, setDetails, save, isSaving } = useGroupDetails({
    // Same resolver as the has-group branch below, so a driver sees identical
    // preferences before and after forming a group.
    stored: user,
    // Gated on the query having resolved, not just on the role: the old code
    // guarded with `if (user?.id && role === "DRIVER")`, and without it a click
    // landing before the fetch would serialise the still-empty form and save
    // an empty message over the stored one.
    canEdit: Boolean(user?.id) && role === Role.DRIVER,
  });

  const onSave = () =>
    save({ successMessage: "Group message successfully saved!" });

  return variant === "mobile" ? (
    <MobileNoGroupView
      role={role}
      details={details}
      setDetails={setDetails}
      onSave={onSave}
      isSaving={isSaving}
    />
  ) : (
    <DesktopNoGroupView
      role={role}
      details={details}
      setDetails={setDetails}
      onSave={onSave}
      isSaving={isSaving}
    />
  );
};

const GroupSection = ({
  curUser,
  variant,
  onViewGroupRoute,
  onClose,
}: {
  curUser: User;
  variant: Variant;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  onClose: () => void;
}) => {
  const groupQuery = trpc.user.groups.me.useQuery();
  const { data: group } = groupQuery;
  const users = group?.users ?? [];
  const driver = users.find((user) => user.role === Role.DRIVER);
  const riders = users.filter((user) => user.role === Role.RIDER);
  const isDriver = curUser.role === Role.DRIVER;

  const { details, setDetails, save, isSaving } = useGroupDetails({
    // The driver's own values, read through the group. This used to
    // read `group.message`, a second copy that could disagree with the driver's.
    stored: group?.preferences,
    // As above, mirroring the old `if (group?.id && role === "DRIVER")` guard.
    canEdit: Boolean(group?.id) && isDriver,
  });

  const onViewRoute = () => {
    if (!driver) {
      return;
    }
    onViewGroupRoute(driver, riders);
    if (variant === "mobile") {
      // The mobile screen is a full-screen overlay above the map, so it has to
      // come down for the route to be visible - but only after the route has
      // rendered, hence the deferral. The desktop modal closes immediately.
      setTimeout(onClose, 100);
    } else {
      onClose();
    }
  };

  // The group tab gets the same three states as the sidebar lists.
  // Without this, a failure and a group that has been deleted underneath a stale
  // `carpoolId` both left `GroupMembers` rendering a spinner with no driver to
  // find, indefinitely.
  if (groupQuery.isError) {
    return (
      <QueryError
        variant="page"
        subject="your group"
        onRetry={() => {
          void groupQuery.refetch();
        }}
      />
    );
  }

  if (groupQuery.isLoading) {
    return <Spinner />;
  }

  // Settled, and there is genuinely no group - the membership pointed at a row
  // that is gone. Delegate to the real no-group container rather than rendering
  // its view here: that container owns the `user.me` query and the save path
  // that writes to the driver's own message, so the form on this screen still
  // works. Rendering the view directly would leave a Submit button wired to
  // nothing.
  if (!group) {
    return <NoGroupSection role={curUser.role} variant={variant} />;
  }

  // Built after the guards above rather than before them, so `hasDriver` can be
  // read off the settled group.
  const viewProps = {
    isDriver,
    users,
    riderCount: riders.length,
    /*
     * The server's flag, not a second local derivation of it. `groups.me`
     * computes `hasDriver` from the same membership rows it maps into `users`,
     * and it was added expressly so this page could explain itself - but no
     * client read it, and this line recomputed `Boolean(driver)` beside it. Two
     * spellings of one fact, either of which could be changed alone.
     */
    hasDriver: group.hasDriver,
    details,
    setDetails,
    isSaving,
    onViewRoute,
    onClose,
  };

  return variant === "mobile" ? (
    <MobileGroupView
      {...viewProps}
      onSave={() => save({ successMessage: "Message updated!" })}
    />
  ) : (
    <DesktopGroupView
      {...viewProps}
      onSave={() =>
        save({ successMessage: "Group message successfully saved!" })
      }
    />
  );
};

/* -------------------------------------------------------------------------- */
/* Views - markup only                                                        */
/* -------------------------------------------------------------------------- */

type NoGroupViewProps = {
  role: Role;
  details: GroupDetails;
  setDetails: (details: GroupDetails) => void;
  onSave: () => void;
  isSaving: boolean;
};

const MobileNoGroupView = ({
  role,
  details,
  setDetails,
  onSave,
  isSaving,
}: NoGroupViewProps) => {
  if (role === Role.VIEWER) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-6">
          <svg
            className="mx-auto mb-4 h-12 w-12 text-blue-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h2 className="mb-2 text-lg font-medium text-gray-900">
            Viewer Mode
          </h2>
          <p className="text-gray-600">
            You are currently in Viewer mode. Switch to Rider or Driver to join
            a carpool group.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-6">
      {role === Role.DRIVER && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-xs">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">
            Driver Information
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            Share specific details your riders should know before they join.
          </p>

          <div className="space-y-4">
            <GroupDetailsForm details={details} setDetails={setDetails} />
            <button
              type="button"
              disabled={isSaving}
              className="w-full rounded-lg bg-red-700 px-4 py-3 font-medium text-white transition-colors hover:bg-red-800 disabled:opacity-50"
              onClick={onSave}
            >
              Save Message
            </button>
          </div>

          <div className="mt-6 rounded-lg bg-gray-50 p-4">
            <h3 className="mb-2 text-sm font-medium text-gray-900">
              Message Preview
            </h3>
            <GroupDetailsPreview
              details={details}
              emptyMessage="Add details above so riders know what to expect."
            />
          </div>
        </div>
      )}

      <div className="flex flex-col items-center justify-center rounded-lg border border-gray-200 bg-white p-8 text-center shadow-xs">
        <svg
          className="mx-auto mb-4 h-16 w-16 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <h2 className="mb-2 text-lg font-medium text-gray-900">No Group Yet</h2>
        <p className="text-gray-600">
          You&apos;re not currently part of a carpool group. Search for
          available rides or create your own!
        </p>
      </div>
    </div>
  );
};

const DesktopNoGroupView = ({
  role,
  details,
  setDetails,
  onSave,
  isSaving,
}: NoGroupViewProps) => (
  <div className="flex h-full flex-col px-8">
    {role === Role.VIEWER ? (
      <div className="flex flex-grow items-center justify-center text-center text-xl font-light">
        You are in Viewer mode, switch to Rider or Driver to join a group
      </div>
    ) : (
      <>
        {role === Role.DRIVER && (
          <div className="mb-2 flex flex-col py-1">
            <GroupDetailsForm details={details} setDetails={setDetails} />
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                disabled={isSaving}
                className="w-[150px] rounded-md bg-red-700 py-2 text-white transition-colors hover:bg-red-800 disabled:opacity-50"
                onClick={onSave}
              >
                Submit
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-grow items-center justify-center text-xl font-light">
          You are not currently part of a carpool group
        </div>
      </>
    )}
  </div>
);

type GroupViewProps = {
  isDriver: boolean;
  users: PublicUser[];
  riderCount: number;
  hasDriver: boolean;
  details: GroupDetails;
  setDetails: (details: GroupDetails) => void;
  onSave: () => void;
  isSaving: boolean;
  onViewRoute: () => void;
  onClose: () => void;
};

const MobileGroupView = ({
  isDriver,
  users,
  riderCount,
  hasDriver,
  details,
  setDetails,
  onSave,
  isSaving,
  onViewRoute,
}: GroupViewProps) => (
  <div className="space-y-6 px-4 py-6">
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-xs">
      {isDriver ? (
        <>
          <h2 className="mb-3 text-lg font-semibold text-gray-900">
            Group Details
          </h2>
          <p className="mb-4 text-sm text-gray-600">
            Keep these details up to date for your riders.
          </p>
          <div className="space-y-4">
            <GroupDetailsForm details={details} setDetails={setDetails} />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Visible to riders</span>
              <button
                type="button"
                disabled={isSaving}
                className="rounded-lg bg-red-700 px-6 py-2 font-medium text-white transition-colors hover:bg-red-800 disabled:opacity-50"
                onClick={onSave}
              >
                Update
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-3 text-lg font-semibold text-gray-900">
            Driver Details
          </h2>
          <div className="rounded-lg border-l-4 border-red-500 bg-gray-50 p-4">
            <GroupDetailsPreview
              details={details}
              emptyMessage="No details from your driver yet."
            />
          </div>
        </>
      )}
    </div>

    <div className="rounded-lg border border-gray-200 bg-white shadow-xs">
      <div className="border-b border-gray-200 p-4">
        <h2 className="text-lg font-semibold text-gray-900">Group Members</h2>
        <p className="mt-1 text-sm text-gray-600">
          {users.length} member{users.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="divide-y divide-gray-100">
        <GroupMembers users={users} />
      </div>
    </div>

    {hasDriver && (
      <div className="sticky bottom-0 -mx-4 border-t border-gray-200 bg-white p-4">
        <PreviewRouteButton
          variant="mobile"
          riderCount={riderCount}
          onClick={onViewRoute}
        />
      </div>
    )}
  </div>
);

const DesktopGroupView = ({
  isDriver,
  users,
  riderCount,
  hasDriver,
  details,
  setDetails,
  onSave,
  isSaving,
  onViewRoute,
  onClose,
}: GroupViewProps) => (
  <div className="flex h-full flex-col px-8">
    {isDriver ? (
      <div className="flex flex-shrink-0 flex-col py-1">
        <div className="my-1 text-xs text-slate-400 italic">
          Share your group details so riders know what to expect.
        </div>
        <GroupDetailsForm details={details} setDetails={setDetails} />
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            disabled={isSaving}
            className="w-[150px] rounded-md bg-red-700 py-2 text-white transition-colors hover:bg-red-800 disabled:opacity-50"
            onClick={onSave}
          >
            Submit
          </button>
        </div>
      </div>
    ) : (
      <div className="flex flex-shrink-0 flex-col py-1">
        <div className="mb-2 text-center">Driver Details</div>
        <GroupDetailsPreview
          details={details}
          emptyMessage="Keep a look out for details from your driver on this board!"
        />
      </div>
    )}

    <div className="mt-4 flex min-h-0 flex-grow flex-col">
      <div className="flex h-full flex-col divide-y-2 overflow-y-auto rounded-md border border-gray-200 px-2">
        <GroupMembers users={users} onLeftGroup={onClose} />
      </div>
    </div>

    {hasDriver && (
      <div className="mt-4 flex-shrink-0">
        <div className="flex flex-col items-center">
          <PreviewRouteButton
            variant="desktop"
            riderCount={riderCount}
            onClick={onViewRoute}
          />
        </div>
      </div>
    )}
  </div>
);
