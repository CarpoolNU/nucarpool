import { Dialog } from "@headlessui/react";
import { useContext, useState, useEffect } from "react";
import { GroupMembers } from "./Group/GroupMemberCard";
import { trpc } from "../utils/trpc";
import { UserContext } from "../utils/userContext";
import { Role } from "@prisma/client";
import Spinner from "./Spinner";
import { toast } from "react-toastify";
import { PublicUser, User } from "../utils/types";
import useIsMobile from "../utils/useIsMobile";

interface GroupPageProps {
  onClose: () => void;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  isMobile?: boolean;
  onPreviewRoute?: () => void;
}

type GroupDetails = {
  notes: string;
  musicPreference: string;
  conversationStyle: string;
  rideVibe: string;
};

const GROUP_DETAILS_PREFIX = "GROUP_DETAILS_V1:";
const NOTES_MAX_LENGTH = 90;

const DEFAULT_GROUP_DETAILS: GroupDetails = {
  notes: "",
  musicPreference: "",
  conversationStyle: "",
  rideVibe: "",
};

const musicPreferenceOptions = [
  "No preference",
  "Pop",
  "Hip-hop",
  "R&B",
  "Electronic",
  "Rock",
  "Podcasts",
  "Quiet ride",
];

const conversationStyleOptions = [
  "No preference",
  "Quiet",
  "Light chat",
  "Talkative",
  "Depends on mood",
];

const rideVibeOptions = [
  "No preference",
  "Chill",
  "Energetic",
  "Focus / study",
  "Morning calm",
];

const normalizeDetails = (details: GroupDetails): GroupDetails => ({
  notes: details.notes.slice(0, NOTES_MAX_LENGTH).trim(),
  musicPreference: details.musicPreference.slice(0, 40).trim(),
  conversationStyle: details.conversationStyle.slice(0, 40).trim(),
  rideVibe: details.rideVibe.slice(0, 40).trim(),
});

const parseGroupDetails = (message?: string | null): GroupDetails => {
  if (!message) {
    return DEFAULT_GROUP_DETAILS;
  }

  if (message.startsWith(GROUP_DETAILS_PREFIX)) {
    try {
      const parsed = JSON.parse(
        message.slice(GROUP_DETAILS_PREFIX.length),
      ) as Partial<GroupDetails>;

      return normalizeDetails({
        notes: parsed.notes ?? "",
        musicPreference: parsed.musicPreference ?? "",
        conversationStyle: parsed.conversationStyle ?? "",
        rideVibe: parsed.rideVibe ?? "",
      });
    } catch {
      return {
        ...DEFAULT_GROUP_DETAILS,
        notes: message,
      };
    }
  }

  return {
    ...DEFAULT_GROUP_DETAILS,
    notes: message,
  };
};

const serializeGroupDetails = (details: GroupDetails): string => {
  const normalized = normalizeDetails(details);
  const hasAnyValue = Object.values(normalized).some((value) => value !== "");

  if (!hasAnyValue) {
    return "";
  }

  return `${GROUP_DETAILS_PREFIX}${JSON.stringify(normalized)}`;
};

const GroupDetailsForm = ({
  details,
  setDetails,
}: {
  details: GroupDetails;
  setDetails: (details: GroupDetails) => void;
}) => {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Group Message
        </div>
        <textarea
          className="min-h-[96px] w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-red-500 focus:ring-2 focus:ring-red-500"
          maxLength={NOTES_MAX_LENGTH}
          value={details.notes}
          onChange={(e) =>
            setDetails({
              ...details,
              notes: e.target.value,
            })
          }
          placeholder="Anything else riders should know about the carpool..."
        />
        <p className="mt-1 text-right text-xs text-gray-500">
          {details.notes.length}/{NOTES_MAX_LENGTH}
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Personality Preferences
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-800">
              Music preference
            </label>
            <select
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-red-500 focus:ring-2 focus:ring-red-500"
              value={details.musicPreference}
              onChange={(e) =>
                setDetails({
                  ...details,
                  musicPreference: e.target.value,
                })
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
            <label className="mb-1 block text-sm font-medium text-gray-800">
              Conversation style
            </label>
            <select
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-red-500 focus:ring-2 focus:ring-red-500"
              value={details.conversationStyle}
              onChange={(e) =>
                setDetails({
                  ...details,
                  conversationStyle: e.target.value,
                })
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
};

const GroupDetailsPreview = ({
  details,
  emptyMessage,
}: {
  details: GroupDetails;
  emptyMessage: string;
}) => {
  const hasAnyDetails = Object.values(normalizeDetails(details)).some(
    (value) => value !== "",
  );

  if (!hasAnyDetails) {
    return (
      <p className="text-sm text-gray-600 rounded-md border px-3 py-2">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
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
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Group Note
          </div>
          <p className="text-sm text-gray-700">{details.notes}</p>
        </div>
      )}
    </div>
  );
};

const MobileGroupPage = ({
  curUser,
  onClose,
  onViewGroupRoute,
  onPreviewRoute,
}: {
  curUser: User;
  onClose: () => void;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  onPreviewRoute?: () => void;
}) => {
  const handleMobileRoutePreview = (
    driver: PublicUser,
    riders: PublicUser[],
  ) => {
    onViewGroupRoute(driver, riders);
    setTimeout(() => {
      onClose();
    }, 100); // delay to ensure the route is rendered first
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Mobile Header */}
      <div className="bg-white shadow-sm border-b border-gray-200 px-4 py-3 flex items-center justify-center mt-6">
        <h1 className="text-lg font-semibold text-gray-900">My Group</h1>
      </div>

      {/* Mobile Content */}
      <div className="flex-1 overflow-auto">
        {!curUser?.carpoolId ? (
          <MobileNoGroupInfo role={curUser.role} />
        ) : (
          <MobileGroupInfo
            curUser={curUser}
            onViewGroupRoute={handleMobileRoutePreview}
            onPreviewRoute={onPreviewRoute}
          />
        )}
      </div>
    </div>
  );
};

export const GroupPage = (props: GroupPageProps) => {
  const [isOpen, setIsOpen] = useState<boolean>(true);
  const curUser = useContext(UserContext);
  const isMobile = useIsMobile();

  const onClose = () => {
    setIsOpen(false);
    props.onClose();
  };

  if (!curUser) {
    return <Spinner />;
  }

  // Mobile render
  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 bg-white">
        <MobileGroupPage
          curUser={curUser}
          onClose={onClose}
          onViewGroupRoute={props.onViewGroupRoute}
          onPreviewRoute={props.onPreviewRoute}
        />
      </div>
    );
  }

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 backdrop-blur-sm" aria-hidden="true">
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="flex flex-col content-center justify-start gap-1 overflow-y-auto bg-white shadow-lg h-4/6 w-4/6 rounded-md py-9">
            <div className="relative">
              <Dialog.Title className="text-center font-bold text-3xl">
                My Group
              </Dialog.Title>
            </div>
            <GroupBody
              curUser={curUser}
              onClose={onClose}
              onViewGroupRoute={props.onViewGroupRoute}
              isMobile={false}
              onPreviewRoute={props.onPreviewRoute}
            />
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
};

const MobileNoGroupInfo = ({ role }: { role: Role }) => {
  const utils = trpc.useContext();
  const { data: user } = trpc.user.me.useQuery();
  const [groupDetails, setGroupDetails] = useState<GroupDetails>(
    parseGroupDetails(user?.groupMessage ?? ""),
  );
  const { mutate: updateUserMessage } =
    trpc.user.groups.updateUserMessage.useMutation({
      onSuccess: () => {
        utils.user.me.invalidate();
      },
    });

  useEffect(() => {
    if (user?.groupMessage !== undefined) {
      setGroupDetails(parseGroupDetails(user.groupMessage ?? ""));
    }
  }, [user]);

  const handleMessageSubmit = async () => {
    if (user?.id && role === "DRIVER") {
      await updateUserMessage({ message: serializeGroupDetails(groupDetails) });
    }
  };

  if (role === Role.VIEWER) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
          <svg
            className="w-12 h-12 text-blue-500 mx-auto mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h2 className="text-lg font-medium text-gray-900 mb-2">
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
    <div className="px-4 py-6 space-y-6">
      {role === "DRIVER" && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">
            Driver Information
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            Share specific details your riders should know before they join.
          </p>

          <div className="space-y-4">
            <GroupDetailsForm
              details={groupDetails}
              setDetails={setGroupDetails}
            />

            <button
              className="w-full bg-red-700 text-white py-3 px-4 rounded-lg font-medium hover:bg-red-800 transition-colors"
              onClick={async () => {
                await handleMessageSubmit();
                toast.success("Group message successfully saved!");
              }}
            >
              Save Message
            </button>
          </div>

          <div className="mt-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="text-sm font-medium text-gray-900 mb-2">
              Message Preview
            </h3>
            <GroupDetailsPreview
              details={groupDetails}
              emptyMessage="Add details above so riders know what to expect."
            />
          </div>
        </div>
      )}

      <div className="flex flex-col items-center justify-center bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <svg
          className="w-16 h-16 text-gray-400 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <h2 className="text-lg font-medium text-gray-900 mb-2">No Group Yet</h2>
        <p className="text-gray-600">
          You&apos;re not currently part of a carpool group. Search for
          available rides or create your own!
        </p>
      </div>
    </div>
  );
};

const MobileGroupInfo = ({
  curUser,
  onViewGroupRoute,
  onPreviewRoute,
}: {
  curUser: User;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  onPreviewRoute?: () => void;
}) => {
  const utils = trpc.useUtils();
  const { data: group } = trpc.user.groups.me.useQuery();
  const users = group?.users ?? [];
  const [groupDetails, setGroupDetails] = useState<GroupDetails>(
    parseGroupDetails(group?.message ?? ""),
  );

  const driver = users.find((user) => user.role === Role.DRIVER);
  const riders = users.filter((user) => user.role === Role.RIDER);

  const { mutate: updateMessage } = trpc.user.groups.updateMessage.useMutation({
    onSuccess: () => {
      utils.user.groups.me.invalidate();
    },
  });
  const { mutate: updateUserMessage } =
    trpc.user.groups.updateUserMessage.useMutation({
      onSuccess: () => {
        utils.user.me.invalidate();
      },
    });

  useEffect(() => {
    if (group?.message !== undefined) {
      setGroupDetails(parseGroupDetails(group.message));
    }
  }, [group]);

  const handleMessageSubmit = async () => {
    if (group?.id && curUser?.role === "DRIVER") {
      const serializedDetails = serializeGroupDetails(groupDetails);
      await updateMessage({ groupId: group.id, message: serializedDetails });
      await updateUserMessage({ message: serializedDetails });
    }
  };

  const handleMobileViewCombinedRoute = () => {
    if (driver) {
      onViewGroupRoute(driver, riders);
    }
  };

  return (
    <div className="px-4 py-6 space-y-6">
      {/* Group Message Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        {curUser?.role === "DRIVER" ? (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">
              Group Details
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Keep these details up to date for your riders.
            </p>
            <div className="space-y-4">
              <GroupDetailsForm
                details={groupDetails}
                setDetails={setGroupDetails}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Visible to riders</span>
                <button
                  className="bg-red-700 text-white py-2 px-6 rounded-lg font-medium hover:bg-red-800 transition-colors"
                  onClick={async () => {
                    await handleMessageSubmit();
                    toast.success("Message updated!");
                  }}
                >
                  Update
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">
              Driver Details
            </h2>
            <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-red-500">
              <GroupDetailsPreview
                details={groupDetails}
                emptyMessage="No details from your driver yet."
              />
            </div>
          </>
        )}
      </div>

      {/* Group Members Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Group Members</h2>
          <p className="text-sm text-gray-600 mt-1">
            {users.length} member{users.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="divide-y divide-gray-100">
          <MobileGroupMembers users={users} />
        </div>
      </div>

      {/* Preview Route Button */}
      {driver && (
        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 -mx-4">
          <button
            onClick={handleMobileViewCombinedRoute}
            className="w-full bg-red-700 text-white py-4 px-4 rounded-lg font-semibold hover:bg-red-800 transition-colors flex items-center justify-center space-x-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
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
          <p className="text-xs text-gray-500 text-center mt-2">
            {riders.length > 0
              ? `View the combined route for ${riders.length + 1} group member${users.length > 1 ? "s" : ""}`
              : "Preview your route as the driver"}
          </p>
        </div>
      )}
    </div>
  );
};

const MobileGroupMembers = ({ users }: { users: PublicUser[] }) => {
  const curUser = useContext(UserContext);
  const driver = users.find((user) => user.role === Role.DRIVER);
  const riders = users.filter(
    (user) => user.id !== driver?.id && user.id !== curUser?.id,
  );
  const utils = trpc.useContext();
  const { mutate: deleteGroup } = trpc.user.groups.delete.useMutation({
    onError: (error: any) => {
      toast.error(`Something went wrong: ${error.message}`);
    },
    onSuccess() {
      utils.user.me.invalidate();
      toast.success("Group has been successfully deleted");
    },
  });

  const { mutate: editGroup } = trpc.user.groups.edit.useMutation({
    onError: (error: any) => {
      toast.error(`Something went wrong: ${error.message}`);
    },
    onSuccess() {
      if (riders.length <= 1) {
        // Group will be empty after removal
      } else {
        utils.user.groups.me.invalidate();
      }
      utils.user.me.invalidate();
      toast.success("Removed from group");
    },
  });

  if (!driver || !curUser) {
    return <Spinner />;
  }

  const handleDelete = () => {
    if (driver.carpoolId) {
      deleteGroup({ groupId: driver.carpoolId });
    }
  };

  const handleEdit = (id: string) => {
    if (driver.carpoolId) {
      editGroup({
        driverId: driver.id,
        riderId: id,
        add: false,
        groupId: driver.carpoolId,
      });
    }
  };

  return (
    <>
      {/* Driver */}
      <MobileMemberCard
        user={driver}
        isCurrentUser={driver.id === curUser.id}
        buttonText={curUser.role === Role.DRIVER ? "Delete Group" : undefined}
        buttonAction={curUser.role === Role.DRIVER ? handleDelete : undefined}
        buttonColor="red"
      />

      {/* Current user if they're a rider */}
      {curUser.role === Role.RIDER && (
        <MobileMemberCard
          user={curUser}
          isCurrentUser={true}
          buttonText="Leave Group"
          buttonAction={() => handleEdit(curUser.id)}
          buttonColor="red"
        />
      )}

      {/* Other riders */}
      {riders.map((rider) => (
        <MobileMemberCard
          key={rider.id}
          user={rider}
          isCurrentUser={false}
          buttonText={curUser.role === Role.DRIVER ? "Remove" : undefined}
          buttonAction={
            curUser.role === Role.DRIVER
              ? () => handleEdit(rider.id)
              : undefined
          }
          buttonColor="red"
        />
      ))}
    </>
  );
};

const MobileMemberCard = ({
  user,
  isCurrentUser,
  buttonText,
  buttonAction,
  buttonColor = "red",
}: {
  user: PublicUser;
  isCurrentUser: boolean;
  buttonText?: string;
  buttonAction?: () => void;
  buttonColor?: "red" | "gray";
}) => {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleAction = () => {
    if (
      buttonText?.includes("Delete") ||
      buttonText?.includes("Remove") ||
      buttonText?.includes("Leave")
    ) {
      setShowConfirm(true);
    } else {
      buttonAction?.();
    }
  };

  const confirmAction = () => {
    buttonAction?.();
    setShowConfirm(false);
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center space-x-3">
        {/* Avatar */}
        <div className="flex-shrink-0">
          <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
            <span className="text-gray-600 font-medium text-lg">
              {user.preferredName.charAt(0).toUpperCase()}
            </span>
          </div>
        </div>

        {/* User Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2">
            <h3 className="text-base font-semibold text-gray-900 truncate">
              {user.preferredName}
              {isCurrentUser && (
                <span className="text-sm font-normal text-gray-500 ml-1">
                  (You)
                </span>
              )}
            </h3>
            <span
              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                user.role === Role.DRIVER
                  ? "bg-blue-100 text-blue-800"
                  : "bg-green-100 text-green-800"
              }`}
            >
              {user.role === Role.DRIVER ? "Driver" : "Rider"}
            </span>
          </div>
          <p className="text-sm text-gray-600 truncate">{user.email}</p>
        </div>

        {/* Action Button */}
        {buttonText && buttonAction && !showConfirm && (
          <button
            onClick={handleAction}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              buttonColor === "red"
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {buttonText}
          </button>
        )}

        {/* Confirmation buttons */}
        {showConfirm && (
          <div className="flex space-x-2">
            <button
              onClick={confirmAction}
              className="px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const GroupBody = ({
  curUser,
  onClose,
  onViewGroupRoute,
  isMobile,
  onPreviewRoute,
}: {
  curUser: User;
  onClose: () => void;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  isMobile?: boolean;
  onPreviewRoute?: () => void;
}) => {
  return !curUser?.carpoolId ? (
    <NoGroupInfo role={curUser.role} onClose={onClose} />
  ) : (
    <GroupInfo
      curUser={curUser}
      onClose={onClose}
      onViewGroupRoute={onViewGroupRoute}
      isMobile={isMobile}
      onPreviewRoute={onPreviewRoute}
    />
  );
};

interface NoGroupInfoProps {
  role: Role;
  onClose: () => void;
}

const NoGroupInfo = ({ role }: NoGroupInfoProps) => {
  const utils = trpc.useContext();
  const { data: user } = trpc.user.me.useQuery();
  const [groupDetails, setGroupDetails] = useState<GroupDetails>(
    parseGroupDetails(user?.groupMessage ?? ""),
  );
  const { mutate: updateUserMessage } =
    trpc.user.groups.updateUserMessage.useMutation({
      onSuccess: () => {
        // Invalidate and refetch the user.me query
        utils.user.me.invalidate();
      },
    });

  useEffect(() => {
    if (user?.groupMessage !== undefined) {
      setGroupDetails(parseGroupDetails(user.groupMessage ?? ""));
    }
  }, [user]);

  const handleMessageSubmit = async () => {
    if (user?.id && role === "DRIVER") {
      await updateUserMessage({ message: serializeGroupDetails(groupDetails) });
    }
  };

  return (
    <div className="flex flex-col h-full px-8">
      {role === Role.VIEWER ? (
        <div className="flex flex-grow items-center justify-center text-xl font-light text-center">
          You are in Viewer mode, switch to Rider or Driver to join a group
        </div>
      ) : (
        <>
          {role === "DRIVER" && (
            <div className="mb-2 flex flex-col py-1">
              <GroupDetailsForm
                details={groupDetails}
                setDetails={setGroupDetails}
              />
              <div className="mt-3 flex justify-center">
                <button
                  className="w-[150px] rounded-md bg-red-700 py-2 text-white hover:bg-red-800 transition-colors"
                  onClick={async () => {
                    await handleMessageSubmit();
                    toast.success("Group message successfully saved!");
                  }}
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
};

const GroupInfo = ({
  curUser,
  onClose,
  onViewGroupRoute,
  isMobile,
  onPreviewRoute,
}: {
  curUser: User;
  onClose: () => void;
  onViewGroupRoute: (driver: PublicUser, riders: PublicUser[]) => void;
  isMobile?: boolean;
  onPreviewRoute?: () => void;
}) => {
  const utils = trpc.useUtils();
  const { data: group } = trpc.user.groups.me.useQuery();
  const users = group?.users ?? [];
  const [groupDetails, setGroupDetails] = useState<GroupDetails>(
    parseGroupDetails(group?.message ?? ""),
  );

  const driver = users.find((user) => user.role === Role.DRIVER);
  const riders = users.filter((user) => user.role === Role.RIDER);

  const { mutate: updateMessage } = trpc.user.groups.updateMessage.useMutation({
    onSuccess: () => {
      // Invalidate and refetch the groups.me query
      utils.user.groups.me.invalidate();
    },
  });
  const { mutate: updateUserMessage } =
    trpc.user.groups.updateUserMessage.useMutation({
      onSuccess: () => {
        // Invalidate and refetch the user.me query
        utils.user.me.invalidate();
      },
    });

  useEffect(() => {
    if (group?.message !== undefined) {
      setGroupDetails(parseGroupDetails(group.message));
    }
  }, [group]);

  const handleMessageSubmit = async () => {
    if (group?.id && curUser?.role === "DRIVER") {
      const serializedDetails = serializeGroupDetails(groupDetails);
      await updateMessage({ groupId: group.id, message: serializedDetails });
      await updateUserMessage({ message: serializedDetails });
    }
  };

  const handleViewCombinedRoute = () => {
    if (driver && riders.length > 0) {
      onViewGroupRoute(driver, riders);
      onClose(); // close modal after showing the route
    }
  };

  return (
    <div className="flex flex-col h-full px-8">
      {curUser?.role === "DRIVER" ? (
        <div className="flex flex-col py-1 flex-shrink-0">
          <div className="my-1 text-xs italic text-slate-400">
            Share your group details so riders know what to expect.
          </div>
          <GroupDetailsForm
            details={groupDetails}
            setDetails={setGroupDetails}
          />
          <div className="flex justify-center mt2">
            <button
              className="w-[150px] rounded-md bg-red-700 py-2 text-white hover:bg-red-800 transition-colors"
              onClick={async () => {
                await handleMessageSubmit();
                toast.success("Group message successfully saved!");
              }}
            >
              Submit
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col py-1 flex-shrink-0">
          <div className="text-center mb-2">Driver Details</div>
          <GroupDetailsPreview
            details={groupDetails}
            emptyMessage="Keep a look out for details from your driver on this board!"
          />
        </div>
      )}

      <div className="mt-4 flex flex-col flex-grow min-h-0">
        <div className="flex flex-col divide-y-2 rounded-md border px-2 h-full overflow-y-auto">
          <GroupMembers users={users} onClose={onClose} />
        </div>
      </div>

      {/* combined route button */}
      {driver && riders.length > 0 && (
        <div className="mt-4 pb-4 flex-shrink-0">
          <div className="flex flex-col items-center">
            <button
              onClick={handleViewCombinedRoute}
              className="flex flex-row items-center gap-1 justify-center w-1/2 rounded-md bg-northeastern-red py-3 px-4 text-white font-medium hover:bg-red-700 transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-1.447-.894L15 4m0 13V4m-6 3l6-3"
                />
              </svg>
              Preview Group Route
            </button>
            <p className="mt-2 text-xs text-gray-500 text-center max-w-xs mx-auto">
              Preview a combined route between the driver and all riders in your
              group
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
