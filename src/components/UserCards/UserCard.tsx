import Rating from "@mui/material/Rating";
import dayjs from "dayjs";
import { formatScheduleTime } from "../../utils/scheduleTime";
import {
  ButtonInfo,
  EnhancedPublicUser,
  PublicUser,
  User,
} from "../../utils/types";
import { trpc } from "../../utils/trpc";
import { toast } from "react-toastify/unstyled";
import React, { useContext } from "react";
import { UserContext } from "../../utils/userContext";
import Spinner from "../Spinner";
import { classNames } from "../../utils/classNames";
import StartIcon from "../../../public/start.png";
import EndIcon from "../../../public/end.png";
import Image from "next/image";
import { trackViewRoute } from "../../utils/mixpanel";
import useProfileImage from "../../utils/useProfileImage";
import { AiOutlineUser } from "react-icons/ai";
import useIsMobile from "../../utils/useIsMobile";
import { counterpartLabel } from "../Sidebar/viewerAccess";

/**
 * The card's activation, as a pair that cannot be half-supplied.
 *
 * A card that is clickable renders a real `<button>` stretched across itself,
 * and that button has no text content of its own — so without a label it is an
 * unnamed control, which is its own axe violation (`button-name`). Trading
 * `nested-interactive` for `button-name` would not be a fix, so the label is
 * required by the type rather than by a comment asking nicely.
 *
 * `onClick` stays optional overall: a card with no activation (every desktop
 * discovery card) renders no button at all.
 */
type CardActivation =
  | {
      onClick: () => void;
      /**
       * The button's accessible name. Build it with `counterpartLabel` rather
       * than from `preferredName`, or Viewer mode leaks the name it withholds.
       */
      onClickLabel: string;
      /** Renders as `aria-current` on the activation button. */
      isSelected?: boolean;
    }
  | { onClick?: undefined; onClickLabel?: undefined; isSelected?: undefined };

type UserCardBaseProps = {
  otherUser: EnhancedPublicUser;
  rightButton?: ButtonInfo;
  onViewRouteClick?: (user: User, otherUser: PublicUser) => void;
  message?: string;
  /**
   * A short explanation of why this card cannot be acted on.
   *
   * Only the Requests tab passes one: a request whose two parties can no longer
   * carpool stays in the list now, so the card has to say why rather than
   * disappear. Discovery cards never need it, because recommendations and
   * favorites are still role-filtered.
   */
  notice?: string;
  /**
   * True when the reader is party to a request with this user.
   *
   * Only the two Requests-tab cards pass it. It governs one thing: whether a
   * VIEWER sees the counterpart's name or their role in its place. See
   * `disclosesCounterpartName` for why a relationship lifts that rule and
   * discovery does not.
   */
  isCounterpart?: boolean;
  isUnread?: boolean;
  classname?: string;
  isMobileCondensedLayout?: boolean;
};

export type UserCardProps = UserCardBaseProps & CardActivation;

const getButtonClassName = (button: ButtonInfo): string => {
  const bColor = button.color;
  return classNames(
    `${bColor} w-1/2 hover:bg-red-700 rounded-md p-1 my-1 text-center text-white`,
  );
};

export const UserCard = (props: UserCardProps): React.JSX.Element => {
  const trpcUtils = trpc.useUtils();
  const isMobile = useIsMobile();
  const { mutate: mutateFavorites } = trpc.user.favorites.edit.useMutation({
    onError: (error: any) => {
      toast.error(`Something went wrong: ${error.message}`);
    },
    onSuccess() {
      trpcUtils.user.favorites.me.invalidate();
    },
  });
  const {
    profileImageUrl,
    imageLoadError,
    isLoading: isProfileImageLoading,
  } = useProfileImage(props.otherUser.id);

  const user = useContext(UserContext);
  // The owning user is no longer sent — the server takes it from
  // the session. The `if (user)` guard this replaces existed only to narrow
  // `user` for `user.id`; the component already returns early when it is absent.
  const handleFavorite = (favoriteId: string, add: boolean) => {
    mutateFavorites({
      favoriteId,
      add,
    });
  };

  <q></q>; /** Creates a div with 7 boxes, each representing a day of the week.
   *  Background color is red if the user is working on that day.
   */
  const DaysWorkingDisplay = (daysWorking: string) => {
    if (!daysWorking || typeof daysWorking !== "string") {
      return <div className="flex w-11/12 justify-between">No days set</div>;
    }
    const boxes: React.JSX.Element[] = [];
    const days: string[] = ["S", "M", "Tu", "W", "Th", "F", "Sa"];
    for (let i = 0; i < daysWorking.length; i = i + 2) {
      let backgroundColor = "";
      let textColor = "";
      let dayIndex = Math.floor(i / 2);
      if (daysWorking[i] == "1") {
        backgroundColor = " bg-northeastern-red";
        textColor = " text-white";
      }
      boxes.push(
        <div
          key={i}
          className={
            "flex h-8 w-8 items-center justify-center rounded-full border border-black text-sm" +
            backgroundColor +
            textColor
          }
        >
          {days[dayIndex]}
        </div>,
      );
    }
    return <div className="flex w-11/12 justify-between">{boxes}</div>;
  };

  if (!user) {
    return <Spinner />;
  }

  // One source for what this card calls the other person, so the heading below
  // and the activation button's `aria-label` cannot disagree.
  const displayName = counterpartLabel({
    viewerRole: user.role,
    isCounterpart: props.isCounterpart ?? false,
    preferredName: props.otherUser.preferredName,
    role: props.otherUser.role,
  });

  return (
    <div
      className={classNames(
        "align-center relative flex flex-col rounded-xl bg-stone-100 text-left shadow-md",
        "border-l-busy-red font-montserrat border-l-[13px]",
        isMobile ? "mx-1 my-2 gap-1 px-3 py-3" : "m-3.5 gap-2 px-4 py-4",
        props.classname,
      )}
    >
      <div className={"mb-1 -ml-2 flex flex-row items-center"}>
        {/* Profile Image */}
        {isProfileImageLoading ? (
          <div className="h-14 w-14 rounded-full bg-gray-200" />
        ) : profileImageUrl && !imageLoadError ? (
          <Image
            src={profileImageUrl}
            // Not `preferredName`: this alt text announced the name the heading
            // withholds from a VIEWER on a discovery card, which is the same
            // accessibility-layer leak the activation button's label is careful
            // to avoid. Fixed here because it is the identical defect in the
            // same component, using the value computed for it two lines above.
            alt={`${displayName}'s Profile Image`}
            width={56}
            height={56}
            className="h-14 w-14 rounded-full object-cover"
          />
        ) : (
          <AiOutlineUser className="h-14 w-14 rounded-full bg-gray-200" />
        )}

        {/* Name and Pronouns */}
        <div className="flex flex-col items-start pl-3.5">
          <div className="text-lg font-semibold">
            <p>{displayName}</p>
          </div>
          <div className="flex flex-row items-start gap-4">
            <p className="font-montserrat text-sm italic">
              {props.otherUser.pronouns !== ""
                ? "(" + `${props.otherUser.pronouns}` + ")"
                : null}
            </p>

            {props.isUnread && (
              <div className="flex items-center">
                <span className="mr-1 h-2 w-2 rounded-full bg-blue-300"></span>
                <p className="text-sm italic">New!</p>
              </div>
            )}
          </div>
        </div>

        {/* Rating — a sibling of the activation button rather than a
            descendant, which is the whole point. `z-20` keeps it
            above the stretched button; `relative` is what makes `z-20` apply. */}
        <div className="relative z-20 ml-auto">
          <Rating
            name=""
            size="large"
            onChange={(_, value) => handleFavorite(props.otherUser.id, !!value)}
            value={props.otherUser.isFavorited ? 1 : 0}
            max={1}
          />
        </div>
      </div>
      {/* second row - Start location*/}

      <div className="flex items-center">
        <div className="flex w-7 items-center justify-center">
          <Image src={StartIcon} width={25} height={25} alt="Start icon" />
        </div>
        <p className="ml-2 text-sm font-semibold">
          {props.otherUser.startAddress}
        </p>
      </div>

      {/* third row - End location*/}
      <div className="flex items-center">
        <div className="flex w-7 items-center justify-center">
          <Image src={EndIcon} width={21} height={25} alt="End icon" />
        </div>
        <p className="ml-2 text-sm font-semibold">
          {props.otherUser.companyName}
        </p>
      </div>

      {/* Fourth row - messaging bubble */}
      {props.message && !(isMobile && props.isMobileCondensedLayout) && (
        <div
          className={`mt-2 inline-block max-w-full rounded-lg bg-white p-2 text-sm break-words ${
            props.isUnread ? "font-bold" : ""
          }`}
        >
          {props.message}
        </div>
      )}

      {!(isMobile && props.isMobileCondensedLayout) && (
        <div className="flex w-full items-center gap-4">
          {DaysWorkingDisplay(props.otherUser.daysWorking)}
        </div>
      )}

      {/* Fifth row - Start and end times */}
      {!(isMobile && props.isMobileCondensedLayout) && (
        <div className="m-0 flex w-full justify-between align-middle">
          <div className="flex text-sm">
            <p className="pr-1">Job Start:</p>
            <p className="font-semibold">
              {formatScheduleTime(props.otherUser.startTime)}
            </p>
            <p className="px-2 font-semibold">|</p>
            <p className="pr-1">Job End:</p>
            <p className="font-semibold">
              {formatScheduleTime(props.otherUser.endTime)}
            </p>
          </div>
        </div>
      )}
      {/* Sixth row - coop Start and end dates */}
      {props.otherUser.coopStartDate &&
        props.otherUser.coopEndDate &&
        !(isMobile && props.isMobileCondensedLayout) && (
          <div className="m-0 flex w-full justify-between align-middle">
            <div className="flex text-sm">
              <p className="pr-1">From:</p>
              <p className="font-semibold">
                {dayjs(props.otherUser.coopStartDate).format("MMMM")}
              </p>
              <p className="px-2 font-semibold">|</p>
              <p className="pr-1">To:</p>
              <p className="font-semibold">
                {dayjs(props.otherUser.coopEndDate).format("MMMM")}
              </p>
            </div>
          </div>
        )}

      {/* Seventh row - Seats avaliable*/}
      {props.otherUser.role === "DRIVER" &&
        !(isMobile && props.isMobileCondensedLayout) && (
          <div className="flex flex-row text-sm">
            <div className="mr-1">Seats Available:</div>
            <div className="font-semibold">{props.otherUser.seatAvail}</div>
          </div>
        )}

      {props.notice && (
        <div className="rounded-md bg-white p-2 text-sm text-gray-700 italic">
          {props.notice}
        </div>
      )}

      {/* 8th row - Buttons*/}
      {props.onViewRouteClick && props.rightButton && !isMobile ? (
        // Raised above the activation button for the same reason as the Rating.
        // These two were the ticket's "same nesting problem in a second form":
        // real buttons that used to sit inside the card's own click target, so
        // pressing View Route or Connect also fired it.
        <div className="relative z-20 flex flex-row justify-between gap-2">
          <button
            disabled={user.status === "INACTIVE" && user.role !== "VIEWER"}
            onClick={() => {
              props.onViewRouteClick &&
                props.onViewRouteClick(user, props.otherUser);
              trackViewRoute(user.role);
            }}
            className="my-1 w-1/2 rounded-md border border-black p-1 text-center hover:bg-stone-200 disabled:hover:bg-transparent"
          >
            View Route
          </button>
          <button
            onClick={() => {
              if (props.rightButton?.onPress) {
                trackViewRoute(user.role);
                props.rightButton.onPress(props.otherUser);
              }
            }}
            disabled={user.role === "VIEWER" || user.status === "INACTIVE"}
            className={getButtonClassName(props.rightButton)}
          >
            {props.rightButton?.text}
          </button>
        </div>
      ) : null}

      {/* The card's activation target.
       *
       * A real <button>, stretched across the card and rendered **last** so it
       * paints over the card's text while staying below the `z-20` controls
       * above. It is a *sibling* of those controls, not an ancestor, which is
       * what fixes both halves of the ticket at once: favouriting no longer
       * bubbles into "open the conversation", because there is nothing to bubble
       * into, and a <button> containing no focusable descendants is no longer
       * `nested-interactive`.
       *
       * This replaces the `role="button"` + `tabIndex` + Enter/Space wrapper
       * `SentCard` and `ReceivedCard` used to need. A real button
       * brings keyboard activation, Space/Enter semantics and the disabled and
       * focus behaviour of a control for free, so all of that is deleted rather
       * than reimplemented.
       *
       * `inset-0` covers the padding box, so the focus ring traces the card just
       * inside its left border rather than around the border itself.
       */}
      {props.onClick && (
        <button
          type="button"
          aria-label={props.onClickLabel}
          aria-current={props.isSelected ? "true" : undefined}
          onClick={props.onClick}
          className="focus-visible:outline-northeastern-red absolute inset-0 z-10 cursor-pointer rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      )}
    </div>
  );
};
