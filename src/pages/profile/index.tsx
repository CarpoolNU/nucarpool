import React, { useEffect, useRef, useState } from "react";
import { FieldErrors, SubmitHandler, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { GetServerSidePropsContext, NextPage } from "next";
import { useRouter } from "next/router";
import { toast } from "react-toastify/unstyled";
import { useSession } from "next-auth/react";
import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/[...nextauth]";
import { trpc } from "../../utils/trpc";
import { OnboardingFormInputs } from "../../utils/types";
import {
  onboardSchema,
  profileDefaultValues,
} from "../../utils/profile/zodSchema";

import Spinner from "../../components/Spinner";
import { QueryError } from "../../components/QueryError";

import { Role } from "@prisma/client";
import { trackProfileCompletion } from "../../utils/mixpanel";
import { useUploadFile } from "../../utils/profile/useUploadFile";
import { useRemoveProfilePicture } from "../../utils/profile/useRemoveProfilePicture";
import { hasProfileChanges } from "../../utils/profile/hasProfileChanges";
import {
  PendingPicture,
  isPendingRemoval,
  pendingPictureFile,
} from "../../utils/profile/pendingPicture";
import { planCoopRangeNotice } from "../../utils/profile/coopRangeNotice";
import { useAddressSelection } from "../../utils/useAddressSelection";
import {
  updateUser,
  useEditUserMutation,
} from "../../utils/profile/updateUser";
import {
  UNRESOLVED_ADDRESS_MESSAGE,
  unresolvedAddressFields,
} from "../../utils/coordinates";

import ProfileSidebar from "../../components/Profile/ProfileSidebar";
import UserSection from "../../components/Profile/UserSection";
import Header from "../../components/Header";
import PageTitle from "../../components/PageTitle";
import CarpoolSection from "../../components/Profile/CarpoolSection";
import AccountSection from "../../components/Profile/AccountSection";
import BlockedUsersSection from "../../components/Profile/BlockedUsersSection";
import ReportsFiledSection from "../../components/Profile/ReportsFiledSection";
import SafetySection from "../../components/Profile/SafetySection";
import UnsavedModal from "../../components/Profile/UnsavedModal";
import useIsMobile from "../../utils/useIsMobile";

// One direct session lookup, not a self-directed HTTP round trip to
// `/api/auth/session`. `getSession` from `next-auth/react` is the
// *client* helper and was being called here; `getServerSession` reads the cookie
// and queries directly, as `server/router/context.ts` already did.
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    return {
      redirect: {
        destination: "/sign-in",
        permanent: false,
      },
    };
  }
  if (!session?.user.isOnboarded) {
    return {
      redirect: {
        destination: "/profile/setup",
        permanent: false,
      },
    };
  }

  return {
    props: {},
  };
}
const Index: NextPage = () => {
  const router = useRouter();
  const [option, setOption] = useState<"user" | "carpool" | "account">("user");

  /**
   * Whether this mount has already told the user their co-op range is
   * backwards.
   *
   * A ref rather than state because nothing renders from it, and because the
   * effect that reads it re-runs on every `user` change — including the
   * refetch after a save. Without the latch, someone who fixed a different
   * field first would be pulled back to the Account tab on each round trip.
   */
  const coopRangeNoticeShown = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  /**
   * The unsaved picture change: a cropped file, a pending removal, or
   * nothing. One slot rather than two pieces of state, because uploading and
   * removing are mutually exclusive - see `pendingPicture.ts`.
   */
  const [pendingPicture, setPendingPicture] = useState<PendingPicture>(null);
  const pendingFile = pendingPictureFile(pendingPicture);
  const { uploadFile } = useUploadFile(pendingFile);
  const { removeProfilePicture } = useRemoveProfilePicture();
  const { data: session } = useSession();
  const userQuery = trpc.user.me.useQuery(undefined, {
    refetchOnMount: true,
  });
  const { data: user } = userQuery;
  const editUserMutation = useEditUserMutation(
    router,
    () => setIsLoading(false),
    false,
  );
  const startAddressHook = useAddressSelection();
  const companyAddressHook = useAddressSelection();

  const { setSelectedAddress: setStartAddressSelected } = startAddressHook;
  const { setSelectedAddress: setCompanyAddressSelected } = companyAddressHook;

  const isMobile = useIsMobile();

  useEffect(() => {
    if (user?.startAddress && user.startAddress !== "") {
      setStartAddressSelected({
        place_name: user.startAddress,
        center: [user.startCoordLng, user.startCoordLat],
        street: user.startStreet || "",
        city: user.startCity || "",
        state: user.startState || "",
      });
    }
    if (user?.companyAddress && user.companyAddress !== "") {
      setCompanyAddressSelected({
        place_name: user.companyAddress,
        center: [user.companyCoordLng, user.companyCoordLat],
        street: user.companyStreet || "",
        city: user.companyCity || "",
        state: user.companyState || "",
      });
    }
  }, [user, setStartAddressSelected, setCompanyAddressSelected]);

  const {
    register,
    setValue,
    setError,
    formState: { errors },
    watch,
    handleSubmit,
    reset,
    trigger,
    control,
  } = useForm<OnboardingFormInputs>({
    mode: "onChange",
    defaultValues: profileDefaultValues,
    resolver: zodResolver(onboardSchema),
  });

  useEffect(() => {
    if (user) {
      reset({
        role: user.role,
        seatAvail: user.seatAvail,
        status: user.status,
        companyName: user.companyName,
        companyAddress: user.companyAddress,
        startAddress: user.startAddress,
        preferredName: user.preferredName,
        pronouns: user.pronouns,
        daysWorking: user.daysWorking
          ? user.daysWorking.split(",").map((bit) => bit === "1")
          : profileDefaultValues.daysWorking,
        startTime: user.startTime!,
        endTime: user.endTime!,
        coopStartDate: user.coopStartDate!,
        coopEndDate: user.coopEndDate!,
        bio: user.bio,
      });
      // Deliberately re-runs on every `user` change rather than only the first:
      // a save refetches, and the form must show what was stored.

      // A stored co-op range that runs backwards makes this user invisible in
      // matching, and the form is `mode: "onChange"` — so nothing would say so
      // until they changed a field or pressed Save. Neither is likely when the
      // only symptom is an empty explore map. A stored year like 1901 is the
      // same problem at lower cost. `planCoopRangeNotice` decides;
      // the latch is here because the effect above re-runs on every refetch.
      const notice = planCoopRangeNotice({
        role: user.role,
        coopStartDate: user.coopStartDate,
        coopEndDate: user.coopEndDate,
        alreadyShown: coopRangeNoticeShown.current,
      });

      if (notice) {
        coopRangeNoticeShown.current = true;
        setOption(notice.tab);
        // `trigger` on the notice's fields rather than the whole form: with a
        // zod resolver this still runs the entire schema, but surfaces only
        // those fields' issues — so a user carrying some other incomplete
        // state does not get it thrown at them on open as well.
        void trigger(notice.fields);
        toast.error(notice.message, { autoClose: false });
      }
    }
  }, [reset, trigger, user]);

  /**
   * Where the header wanted to go, held until the user answers the modal.
   *
   * A ref rather than state because nothing renders from it, and because
   * `handleSaveChanges` reads it after an `await` - a state value captured in
   * that closure would be the one from before the save.
   */
  const proceedRef = useRef<(() => void | Promise<void>) | null>(null);

  /** Runs the header's navigation, or the map fallback if it supplied none. */
  const proceedToDestination = async () => {
    const proceed = proceedRef.current;
    proceedRef.current = null;

    if (proceed) {
      await proceed();
      return;
    }

    await router.push("/");
  };

  /**
   * Offers the unsaved-changes modal on the way out, or leaves if there is
   * nothing to lose.
   *
   * The comparison lives in `utils/profile/hasProfileChanges.ts` - see the
   * header there, which records what happens when fourteen of these
   * are chained inline and two of them are wrong.
   *
   * `proceed` is the navigation the header wanted to perform. It arrives as a
   * callback rather than a destination so that the mobile path's full page
   * load stays in `Header` where its reason is written down.
   * Absent, the map is the destination, which is what the desktop button
   * asks for.
   *
   * `pendingPicture` is passed as well as the form values because it is the
   * one unsaved change that is not a form field. Without it a freshly cropped
   * picture - or a pending removal - takes the else branch below and the
   * navigation happens at once, with no modal: the one profile edit the guard
   * cannot see, on a page whose other fourteen it protects.
   */
  const checkForChanges = async (proceed?: () => void | Promise<void>) => {
    proceedRef.current = proceed ?? null;

    if (hasProfileChanges(watch(), user, pendingPicture)) {
      setShowModal(true);
    } else {
      setIsLoading(true);
      await proceedToDestination();
      setIsLoading(false);
    }
  };
  /**
   * Leave without saving - the modal's Continue, and also the tail of a
   * successful save.
   *
   * Dropping `pendingPicture` is what makes "Continue discards the picture"
   * true of the state rather than only of the navigation, and it now discards
   * a pending *removal* on the same terms: the stored picture stays. Leaving
   * the page usually unmounts this component and takes the pending change with
   * it, but that is a consequence of the destination rather than a decision
   * made here: `proceed` is supplied by the caller, and a guard that declined
   * to navigate - or a destination that re-renders this page rather than
   * replacing it - would otherwise leave a change the user has just chosen to
   * abandon still queued for the next save. Clearing it first costs nothing on
   * the paths that do unmount and closes the one that does not.
   *
   * Safe on the save path too: `onSubmitWithContinue` has already awaited the
   * upload by the time it calls this.
   */
  const onContinue = async () => {
    setIsLoading(true);
    setPendingPicture(null);
    await proceedToDestination();
    setIsLoading(false);
    setShowModal(false);
  };

  /**
   * Cancel. Drops the pending destination too - otherwise the next navigation
   * that supplies none would inherit this one.
   */
  const onDismissModal = () => {
    proceedRef.current = null;
    setShowModal(false);
  };

  const onSubmit = async (values: OnboardingFormInputs): Promise<boolean> => {
    // The address fields hold text and `onboardSchema` checks the text; the
    // coordinates live outside the form, in the two address hooks, and the
    // combobox only writes back to the form when a suggestion is chosen. So a
    // non-empty address can sit next to the `[0, 0]` the hook defaults to.
    // Saving that puts the pin ~4000 miles out and drops the row from every
    // distance-filtered search, so `user.edit` refuses it; this names the
    // field instead of surfacing a Zod error in a toast.
    const unresolved = unresolvedAddressFields({
      role: values.role,
      home: startAddressHook.selectedAddress.center,
      company: companyAddressHook.selectedAddress.center,
    });
    if (unresolved.length > 0) {
      for (const field of unresolved) {
        setError(field, {
          type: "manual",
          message: UNRESOLVED_ADDRESS_MESSAGE,
        });
      }
      setOption("carpool");
      toast.error("One or more fields are invalid, please fix and try again.");
      return false;
    }

    setIsLoading(true);
    const userInfo = {
      ...values,
      companyCoordLng: companyAddressHook.selectedAddress.center[0],
      companyCoordLat: companyAddressHook.selectedAddress.center[1],
      startCoordLng: startAddressHook.selectedAddress.center[0],
      startCoordLat: startAddressHook.selectedAddress.center[1],
      // Only a driver has seats, normalised here rather than on load. A
      // `role` effect doing it would also corrupt a full driver's `0`;
      // normalising at the submit boundary keeps the "non-driver stores 0"
      // outcome without the form rewriting stored data behind the user. It
      // tests DRIVER rather than RIDER because VIEWER needs zeroing too - a
      // `=== "RIDER"` check lets a viewer persist a stale count, and rows
      // carrying one exist.
      seatAvail: values.role === Role.DRIVER ? (values.seatAvail ?? 0) : 0,
      startStreet:
        startAddressHook.selectedAddress.street || user?.startStreet || "",
      startCity: startAddressHook.selectedAddress.city || user?.startCity || "",
      startState:
        startAddressHook.selectedAddress.state || user?.startState || "",
      companyStreet:
        companyAddressHook.selectedAddress.street || user?.companyStreet || "",
      companyCity:
        companyAddressHook.selectedAddress.city || user?.companyCity || "",
      companyState:
        companyAddressHook.selectedAddress.state || user?.companyState || "",
      companyName: values.companyName ?? "",
      companyAddress: values.companyAddress ?? "",
      startAddress: values.startAddress ?? "",
      preferredName: values.preferredName ?? "",
      pronouns: values.pronouns ?? "",
      bio: values.bio ?? "",
      daysWorking: values.daysWorking ?? [],
      startTime: values.startTime ?? null,
      endTime: values.endTime ?? null,
      coopStartDate: values.coopStartDate ?? null,
      coopEndDate: values.coopEndDate ?? null,
    };
    // A failed picture change must not stop at the console, or the save below
    // reports success while the avatar silently stays as it was. The failure is
    // carried down to the save result instead of aborting here, because the
    // profile fields still save correctly when only the picture fails.
    //
    // The three states are exclusive by construction, which is why this is a
    // branch rather than two independent checks: `pendingPicture` holds a file,
    // the removal marker, or nothing, so an upload and a removal can never both
    // be attempted in one save.
    let pictureFailure: "upload" | "removal" | null = null;
    if (pendingFile) {
      try {
        await uploadFile();

        // The bytes are in S3 and `recordProfilePictureUpload` has run, so this
        // file is saved rather than pending and the guard must stop counting
        // it - otherwise Save Changes, which leaves the user on this page,
        // would arm the unsaved-changes modal against a picture that is
        // already stored, and a second press would re-upload it.
        //
        // Only on success. A failed upload leaves the picture genuinely
        // unsaved, so keeping the file is what makes the modal's warning true
        // and lets the user retry with the crop they already chose.
        //
        // `uploadFile` awaits `invalidateProfileImage` before returning, so the
        // stored picture has already been refetched by the time the preview
        // stops deriving from this file - the avatar swaps straight from the
        // local crop to the uploaded one with nothing in between.
        setPendingPicture(null);
      } catch (error) {
        console.error("File upload failed:", error);
        pictureFailure = "upload";
      }
    } else if (isPendingRemoval(pendingPicture)) {
      try {
        await removeProfilePicture();

        // Cleared on success for the same reason as above, and kept on failure
        // for the same reason too: a removal the server refused is still
        // pending, so the modal should go on warning about it and a second
        // press should retry it rather than silently do nothing.
        setPendingPicture(null);
      } catch (error) {
        console.error("Profile picture removal failed:", error);
        pictureFailure = "removal";
      }
    }
    const sessionName = session?.user?.name ?? "";
    try {
      await updateUser({
        userInfo,
        sessionName,
        mutation: editUserMutation,
      });
      trackProfileCompletion(userInfo.role, userInfo.status);
      // Named separately rather than sharing one message: "could not be
      // uploaded" told a user who pressed Remove the opposite of what happened,
      // and in both cases the reassuring half - that the stored picture is
      // untouched - is the part they need in order to decide whether to retry.
      if (pictureFailure === "upload") {
        toast.warning(
          "Your profile was updated, but the new picture could not be uploaded. Your previous picture is unchanged - please try again.",
        );
      } else if (pictureFailure === "removal") {
        toast.warning(
          "Your profile was updated, but your picture could not be removed. It is still there - please try again.",
        );
      } else {
        toast.success("User profile updated successfully!");
      }
    } catch (error) {
      // No toast here: `useEditUserMutation`'s `onError` has already shown one
      // carrying the server's reason, and a second would stack a vaguer
      // message on top of it.
      //
      // `false`, because the save did not happen. Falling through to the
      // `return true` below would let the unsaved-changes modal's Save and
      // Continue navigate away - or sign out - on a refused save, throwing away
      // the very edits it offered to keep.
      return false;
    } finally {
      setIsLoading(false);
    }
    return true;
  };
  // Leaving the page is conditional on the save having succeeded. The guard
  // above returns without saving and the catch returns on a refused save, and
  // navigating away regardless would have discarded the field error or the
  // edits.
  const onSubmitWithContinue: SubmitHandler<OnboardingFormInputs> = async (
    values,
  ) => {
    if (await onSubmit(values)) {
      await onContinue();
    }
  };
  const handleSaveChanges = async () => {
    setShowModal(false);
    await handleSubmit(onSubmitWithContinue, onError)();
  };
  const onError = (errors: FieldErrors<OnboardingFormInputs>) => {
    const firstErrorKey = Object.keys(errors)[0];
    if (firstErrorKey) {
      if (
        ["preferredName", "pronouns", "role", "bio", "seatAvail"].includes(
          firstErrorKey,
        )
      ) {
        setOption("user");
      } else if (
        [
          "startAddress",
          "companyAddress",
          "companyName",
          "startTime",
          "endTime",
          "daysWorking",
        ].includes(firstErrorKey)
      ) {
        setOption("carpool");
      } else {
        setOption("account");
      }
    }
    toast.error("One or more fields are invalid, please fix and try again.");
  };

  /*
   * A failed `user.me` must say so. Left unread, `isError` leaves `data`
   * undefined behind the overlay below forever - and because this guard
   * returns before `Header` renders, that overlay is the whole page, with no
   * navigation to leave by and no way out but a manual reload. `/` carries the
   * same guard for the map page.
   *
   * Checked ahead of the spinner for the reason `toQueryState` documents: a
   * query that has failed is also not loading, so a spinner would be standing
   * in for a failure. `isLoading` in the guard below is this page's *save*
   * state, not the query's, so the two are independent.
   */
  if (userQuery.isError) {
    return (
      <>
        <PageTitle page="Profile" />
        <QueryError
          variant="page"
          subject="your profile"
          onRetry={() => {
            void userQuery.refetch();
          }}
        />
      </>
    );
  }

  if (isLoading || !user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
        <PageTitle page="Profile" />
        <Spinner />
      </div>
    );
  }
  return (
    <div className="relative h-full select-none">
      <PageTitle page="Profile" />
      {showModal && (
        <UnsavedModal
          onClose={onDismissModal}
          onContinue={onContinue}
          onSave={handleSaveChanges}
        />
      )}

      <Header profile={true} checkChanges={checkForChanges} />

      {/* `bottom-mobile-nav` below stands in for a hard-coded 64px bottom
          offset, which would be this file's own guess at the navigation's
          height and disagrees with both the bar itself and the explore page's
          guess of 48px. That class name is spelled out in words rather than
          written here, because Tailwind scans this file for class-like strings
          and would emit the utility as a real rule from the comment describing
          it - which also puts a false hit in front of anyone grepping for live
          uses.

          The tab strip sits inside this container, and the strip and the pane
          are one flex column. That is instead of a 6rem top offset on the pane
          - described rather than written out, for the same scanning reason.

          Every quantity such an offset reserves space for lives in
          `ProfileSidebar`, not here: 12px of `py-3` either side, a 32px icon,
          4px of `mb-1`, the label's 24px `text-base` line box, the selected
          tab's 4px underline, and this wrapper's 2px bottom border. That is
          90px against the 96 reserved, so a 6px dead band would sit under the
          strip. The 6px is the smaller half of the problem. The larger half is
          that nothing keeps the two in step - changing the icon size or the
          label's type scale in the other file moves the strip and leaves the
          offset behind, with nothing to notice it.

          A flex column deletes the quantity rather than correcting it. The
          strip is `shrink-0` and takes its natural height, the pane takes
          whatever is left, and no number in this file measures a component in
          another one. It also holds where a derived constant would not - a
          late-loading font, or a label that wraps at a narrow width - without
          the `ResizeObserver` that measuring at runtime would cost.

          `min-h-0` is load-bearing. A flex item defaults to `min-height: auto`
          and refuses to shrink below its content, so without it the pane grows
          to fit rather than scrolling, and its overflow runs on underneath the
          bottom navigation. */}
      {isMobile ? (
        <div className="bottom-mobile-nav absolute top-0 right-0 left-0 flex flex-col">
          <div className="border-busy-red z-10 w-full shrink-0 border-b-2 bg-stone-100">
            <ProfileSidebar option={option} setOption={setOption} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-8 pt-6 pb-24">
              {option === "user" ? (
                <UserSection
                  watch={watch}
                  onPendingPictureChange={setPendingPicture}
                  pendingPicture={pendingPicture}
                  errors={errors}
                  register={register}
                  onSubmit={handleSubmit(onSubmit, onError)}
                  setValue={setValue}
                  user={user}
                  checkChanges={checkForChanges}
                />
              ) : option === "carpool" ? (
                <CarpoolSection
                  watch={watch}
                  errors={errors}
                  register={register}
                  setValue={setValue}
                  onSubmit={handleSubmit(onSubmit, onError)}
                  startAddressHook={startAddressHook}
                  companyAddressHook={companyAddressHook}
                  control={control}
                />
              ) : option === "account" ? (
                <>
                  <AccountSection
                    control={control}
                    watch={watch}
                    onSubmit={handleSubmit(onSubmit, onError)}
                    errors={errors}
                    setValue={setValue}
                  />
                  {/* Beside the form rather than in it: unblocking takes
                      effect immediately and is not part of Save Changes.
                      The reports list is read-only and belongs to Save
                      Changes even less. */}
                  <BlockedUsersSection />
                  <ReportsFiledSection />
                  <SafetySection />
                </>
              ) : (
                <></>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="h-content-row relative grid w-full grid-cols-[250px_repeat(2,1fr)] overflow-hidden">
          <div className="border-busy-red sticky top-0 col-start-1 col-end-2 h-full w-[250px] border-r-4 bg-stone-100 lg:w-[350px]">
            <ProfileSidebar option={option} setOption={setOption} />
          </div>

          <div className="col-start-2 col-end-4 flex h-full shrink items-start justify-center overflow-x-hidden overflow-y-auto">
            <div className="mt-10 w-full max-w-2xl px-8">
              {option === "user" ? (
                <UserSection
                  watch={watch}
                  onPendingPictureChange={setPendingPicture}
                  pendingPicture={pendingPicture}
                  errors={errors}
                  register={register}
                  onSubmit={handleSubmit(onSubmit, onError)}
                  setValue={setValue}
                  user={user}
                  checkChanges={checkForChanges}
                />
              ) : option === "carpool" ? (
                <CarpoolSection
                  watch={watch}
                  errors={errors}
                  register={register}
                  setValue={setValue}
                  onSubmit={handleSubmit(onSubmit, onError)}
                  startAddressHook={startAddressHook}
                  companyAddressHook={companyAddressHook}
                  control={control}
                />
              ) : option === "account" ? (
                <>
                  <AccountSection
                    control={control}
                    watch={watch}
                    onSubmit={handleSubmit(onSubmit, onError)}
                    errors={errors}
                    setValue={setValue}
                  />
                  {/* Beside the form rather than in it: unblocking takes
                      effect immediately and is not part of Save Changes.
                      The reports list is read-only and belongs to Save
                      Changes even less. */}
                  <BlockedUsersSection />
                  <ReportsFiledSection />
                  <SafetySection />
                </>
              ) : (
                <></>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
export default Index;
