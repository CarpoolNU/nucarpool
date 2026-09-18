import React, { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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
import InitialStep from "../../components/Setup/InitialStep";
import { FaArrowRight } from "react-icons/fa";
import StepTwo from "../../components/Setup/StepTwo";
import ProgressBar from "../../components/Setup/ProgressBar";
import StepThree from "../../components/Setup/StepThree";
import { SetupContainer } from "../../components/Setup/SetupContainer";
import StepFour from "../../components/Setup/StepFour";
import ViewerConfirmModal from "../../components/Setup/ViewerConfirmModal";
import { Role } from "@prisma/client";
import { trackFTUECompletion, trackFTUEStep } from "../../utils/mixpanel";
import { useUploadFile } from "../../utils/profile/useUploadFile";
import { useAddressSelection } from "../../utils/useAddressSelection";
import {
  updateUser,
  useEditUserMutation,
} from "../../utils/profile/updateUser";
import useIsMobile from "../../utils/useIsMobile";
import {
  UNRESOLVED_ADDRESS_MESSAGE,
  unresolvedAddressFields,
} from "../../utils/coordinates";

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
  if (session?.user.isOnboarded) {
    return {
      redirect: {
        destination: "/profile",
        permanent: false,
      },
    };
  }

  return {
    props: {},
  };
}
const Setup: NextPage = () => {
  const router = useRouter();
  const isMobile = useIsMobile(); // Use the hook to detect mobile

  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [initialLoad, setInitialLoad] = useState(true);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showViewerConfirm, setShowViewerConfirm] = useState(false);
  const { uploadFile } = useUploadFile(selectedFile);
  const { data: session } = useSession();
  const { data: user } = trpc.user.me.useQuery(undefined, {
    refetchOnMount: true,
  });
  const editUserMutation = useEditUserMutation(router, () =>
    setIsLoading(false),
  );
  const startAddressHook = useAddressSelection();
  const companyAddressHook = useAddressSelection();

  const { setSelectedAddress: setStartAddressSelected } = startAddressHook;
  const { setSelectedAddress: setCompanyAddressSelected } = companyAddressHook;

  useEffect(() => {
    if (user?.startAddress && user.startAddress !== "") {
      setStartAddressSelected({
        place_name: user.startAddress,
        center: [user.startCoordLng, user.startCoordLat],
      });
    }
    if (user?.companyAddress && user.companyAddress !== "") {
      setCompanyAddressSelected({
        place_name: user.companyAddress,
        center: [user.companyCoordLng, user.companyCoordLat],
      });
    }
  }, [user, setStartAddressSelected, setCompanyAddressSelected]);

  const {
    register,
    setValue,
    formState: { errors },
    setError,
    watch,
    handleSubmit,
    reset,
    control,
    trigger,
  } = useForm<OnboardingFormInputs>({
    mode: "onChange",
    defaultValues: profileDefaultValues,
    resolver: zodResolver(onboardSchema),
  });

  useEffect(() => {
    if (initialLoad && user) {
      reset({
        // A brand-new user has no `CarpoolSearch` row, so `user.role` is only
        // the `?? Role.VIEWER` fallback in `user.me` - not a stored choice.
        // Restoring it here is what put every new user on Viewer with one tap
        // to end onboarding. SCRUM-508.
        role: user.hasCarpoolSearch ? user.role : profileDefaultValues.role,
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
      setInitialLoad(false);
    }
  }, [initialLoad, reset, user]);
  const role = watch("role");

  /**
   * Reports the address steps whose coordinates never resolved.
   *
   * The two `startAddress` / `companyAddress` form fields hold text, and that is
   * all `onboardSchema` can see. The coordinates live in the address hooks, and
   * `ControlledAddressCombobox` writes back to the form only when a suggestion
   * is chosen - so text restored from a previous save can sit next to the
   * `[0, 0]` the hook defaults to. Saving that put the pin in the Gulf of
   * Guinea and made the row unmatchable.
   *
   * Returns true when it blocked, having set the field errors.
   */
  const blockOnUnresolvedAddresses = (role: Role): boolean => {
    const unresolved = unresolvedAddressFields({
      role,
      home: startAddressHook.selectedAddress.center,
      company: companyAddressHook.selectedAddress.center,
    });

    for (const field of unresolved) {
      setError(field, { type: "manual", message: UNRESOLVED_ADDRESS_MESSAGE });
    }

    return unresolved.length > 0;
  };

  const onSubmit = async (values: OnboardingFormInputs) => {
    // Backstop for the step-2 check below, which is what a user actually hits.
    // Reached only if the address is cleared after passing that step.
    if (blockOnUnresolvedAddresses(values.role)) {
      setStep(2);
      return;
    }

    setIsLoading(true);
    const userInfo = {
      ...values,
      companyCoordLng: companyAddressHook.selectedAddress.center[0],
      companyCoordLat: companyAddressHook.selectedAddress.center[1],
      startCoordLng: startAddressHook.selectedAddress.center[0],
      startCoordLat: startAddressHook.selectedAddress.center[1],
      // Only a driver has seats - see the matching note in `profile/index.tsx`.
      // The `?? 1` is unreachable for a DRIVER, because `handleNextStep`
      // refuses to leave step 1 without a positive count, and is kept as the
      // same backstop it has always been.
      seatAvail: values.role === Role.DRIVER ? (values.seatAvail ?? 1) : 0,
      startStreet: startAddressHook.selectedAddress.street || "",
      startCity: startAddressHook.selectedAddress.city || "",
      startState: startAddressHook.selectedAddress.state || "",
      companyStreet: companyAddressHook.selectedAddress.street || "",
      companyCity: companyAddressHook.selectedAddress.city || "",
      companyState: companyAddressHook.selectedAddress.state || "",
      companyName: values.companyName ?? "",
      profilePicture: values.profilePicture ?? "",
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
    // Reported rather than swallowed, so the picture does not just fail to
    // appear with no explanation. Onboarding continues either way - a missing
    // picture is not worth blocking setup over, and it can be added later from
    // the profile page.
    if (selectedFile) {
      try {
        await uploadFile();
      } catch (error) {
        console.error("File upload failed:", error);
        toast.warning(
          "Your profile picture could not be uploaded. You can add it later from your profile.",
        );
      }
    }
    const sessionName = session?.user?.name ?? "";
    await updateUser({
      userInfo,
      sessionName,
      mutation: editUserMutation,
    });
    trackFTUECompletion(userInfo.role);
  };

  const handleNextStep = async () => {
    const seatAvail = watch("seatAvail");
    if (step === 1) {
      if (role === Role.VIEWER) {
        // Confirm before this ends onboarding: `onSubmit` is what sets
        // `isOnboarded: true`, and step 1 is otherwise a single tap away from
        // it with no way back into the wizard. SCRUM-508.
        setShowViewerConfirm(true);
        return;
      }
      if (role === Role.DRIVER && (!seatAvail || seatAvail <= 0)) {
        setError("seatAvail", {
          type: "manual",
          message: "Seat availability must be > 0",
        });
        return;
      }
      const isValid = await trigger(["seatAvail"]);
      if (!isValid) return;
    } else if (step === 2) {
      const isValid = await trigger([
        "startAddress",
        "companyAddress",
        "companyName",
      ]);
      if (!isValid) return;
      // Typing an address is not the same as resolving one, and only the
      // resolved point is usable for matching.
      if (blockOnUnresolvedAddresses(role)) return;
    } else if (step === 3) {
      const valid = await trigger([
        "coopStartDate",
        "daysWorking",
        "coopEndDate",
        "startTime",
        "endTime",
      ]);
      if (!valid) return;
    } else if (step === 4) {
      const valid = await trigger(["bio", "preferredName", "pronouns"]);
      if (!valid) return;
      await handleSubmit(onSubmit)();
      return;
    }
    trackFTUEStep(step);
    setStep((prevStep) => prevStep + 1);
  };
  if (isLoading || !user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
        <Spinner />
      </div>
    );
  }

  /*
    The navigation buttons, which are a sibling of the card rather than an
    overlay on top of it.

    On mobile this element is *in flow*, the last child of the same full-screen
    column the card sits in, so the card's height and the strip's height are
    sized against each other by the flex container instead of by two numbers
    that have to agree. It used to be `fixed ... bottom-6 ... z-50` outside that
    container, which the card's own height knew nothing about, so the strip
    covered the bottom 70px of every step's scroll area at 375x667 - measured,
    not estimated. `z-50` on `SetupContainer` did not save it: `position: fixed`
    on the wrapper creates a stacking context, so the card's z-index only ever
    competed with its own siblings while the strip competed in the root.

    No `shrink-0` here, though a column layout invites one. The strip keeps its
    height for free: its `overflow` is `visible`, so its automatic minimum size
    is its own content, and the browser shrinks the card instead. Measured down
    to a 260px-tall container - the strip held 96px at every step of that, with
    and without the class - so `shrink-0` would have been a no-op asserting
    something load-bearing.

    `z-50` is kept for the desktop arrangement, where the strip is taken out of
    flow again and *can* meet the card on a short window. It is a no-op on
    mobile, where the two no longer occupy the same space at all.

    **The placement is `desktop-tall:`, not `desktop:`, and that is SCRUM-474.**
    Taking the strip out of flow is only safe while the window is tall enough
    for a centred 500px card to clear it, which is `WIZARD_DESKTOP_MIN_HEIGHT_PX`
    - see the derivation there. Below it the strip stays in flow and the column
    above sizes the two against each other, which is the arrangement that was
    already correct on a phone. `desktop:` alone is a `min-width`, so a phone
    held in landscape is 667px wide, reports desktop, and got this branch in a
    375px-tall viewport: the card was clipped 62px off the top and 63px off the
    bottom with the strip across the middle of what was left, and the last field
    could not be reached at all. Measured, not estimated, and not only a phone
    problem - at 1280x800 the strip covered the card's last 22px.

    `desktop:gap-6` deliberately keeps the plain width breakpoint. The space
    between the two buttons is type-scale styling, which tracks the same thing
    the button padding beside it does; only the strip's *placement* depends on
    there being vertical room.

    Styling-only differences go through `desktop:` overrides on mobile-first
    base classes rather than an `isMobile` ternary, per SCRUM-415. That also
    removes a first-render wrinkle this element used to have: `useIsMobile`
    returns the desktop snapshot during hydration, so the ternary positioned the
    strip twice on a phone, and - because the two branches lived at different
    points in the tree - React remounted the buttons to do it.
  */
  const buttonContainerClass =
    "desktop-tall:absolute desktop-tall:bottom-10 desktop-tall:left-1/2 desktop-tall:-translate-x-1/2 desktop:gap-6 z-50 flex flex-col items-center gap-3";

  const backButtonClass = isMobile
    ? "px-4 py-2 font-montserrat text-base text-black underline"
    : "px-6 py-3 font-montserrat text-lg text-black underline";

  const continueBaseClass = isMobile
    ? "flex w-[170px] items-center justify-center rounded-full drop-shadow-[0_10px_3px_rgba(0,0,0,0.35)]"
    : "flex w-[200px] items-center justify-center rounded-full drop-shadow-[0_15px_4px_rgba(0,0,0,0.35)]";

  const continueButtonDefaultClass = isMobile
    ? "bg-white text-black px-4 py-2"
    : "bg-white text-black px-6 py-3";

  const continueButtonFinalStepClass = isMobile
    ? "bg-northeastern-red text-white px-4 py-2"
    : "bg-northeastern-red text-white px-6 py-3";

  // Responsive title classes
  const titleClass = isMobile
    ? "absolute z-10 w-full justify-start p-3 font-lato text-3xl font-bold text-northeastern-red transition-opacity duration-1000"
    : "absolute z-10 w-full justify-start p-4 font-lato text-5xl font-bold text-northeastern-red transition-opacity duration-1000";

  // Container padding based on step and device
  const containerPadding = () => {
    if (step < 2) {
      return isMobile
        ? "rounded-2xl bg-white px-6 py-10 drop-shadow-[0_15px_8px_rgba(0,0,0,0.35)]"
        : "rounded-2xl bg-white px-16 py-20 drop-shadow-[0_15px_8px_rgba(0,0,0,0.35)]";
    } else {
      return isMobile
        ? "rounded-2xl bg-white px-4 py-6 drop-shadow-[0_15px_8px_rgba(0,0,0,0.35)]"
        : "rounded-2xl bg-white drop-shadow-[0_15px_8px_rgba(0,0,0,0.35)]";
    }
  };

  /*
    The height each step would *like* on mobile. A request, not a guarantee.

    These are requests because the card is a shrinkable item in the column
    below, so the flex container hands back whatever is left once the button
    strip, the gap and the safe-area inset have been taken - and on a 667px
    phone that is less than any figure here, so every step renders at the same
    height. That was already true before: a `maxHeight: "85vh"` clamped all of
    them to 567px, and the table only began to take effect above roughly 824px
    of viewport height. The difference is that the space is now measured rather
    than guessed at 85%, so the remainder is genuinely reachable instead of
    sitting under the buttons.

    The `vh` is gone with it. Per the note in `globals.css`, `vh` resolves
    against the *large* viewport on iOS Safari - the page as it would measure
    with the browser chrome retracted - so the clamp was computed against space
    the user could not see, which made the overlap worse on a real phone than
    in a desktop Chromium at the same size. Nothing here needs a viewport unit
    now that the container does the arithmetic.
  */
  const mobileHeights = {
    0: 500,
    1: 700,
    2: 580,
    3: 700,
    4: 700,
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="bg-floaty absolute inset-0" />
      <h1 className={titleClass}>CarpoolNU</h1>

      {/*
        The progress bar's wrapper carries its width, because `ProgressBar` is
        a capped `w-full` and this element is absolutely positioned: with no
        explicit width it shrink-wraps its content, and a `w-full` child
        resolving against a shrink-to-fit parent is circular. 90% is the same
        figure `SetupContainer` uses, so the bar and the card share an edge.

        Both differences here are overrides on mobile-first base classes rather
        than an `isMobile` ternary - the direction SCRUM-415 settled on. That
        also removes a first-render wrinkle: `useIsMobile` returns the desktop
        snapshot during hydration, so the ternary placed the bar at its desktop
        offset once on a phone before correcting.

        The two differences take *different* breakpoints, which is the point of
        SCRUM-474. The width is a width concern and stays on `desktop:`, sharing
        its 600px with the card. The offset is not: `calc(50% - 250px - 60px)`
        is only meaningful while the card is a 500px block centred in the
        viewport - it reads as "half the screen, back up over the card's top
        half, then 60px clear of it" - and below `WIZARD_DESKTOP_MIN_HEIGHT_PX`
        the card is neither 500px nor centred that way. Left on `desktop:` the
        formula went negative on a landscape phone and put the bar at y -122,
        entirely off the top of the screen; on `desktop-tall:` it falls back to
        the same `top-16` a phone uses.
      */}
      {step > 1 && (
        <div className="desktop-tall:top-[calc(50%-250px-60px)] desktop:w-[600px] absolute top-16 left-1/2 z-20 w-[90%] -translate-x-1/2 transform">
          <ProgressBar step={step - 2} />
        </div>
      )}

      {/*
        Full screen flex container for perfect centering.

        A *column* on mobile, holding the card and the navigation strip as two
        in-flow items, which is what makes the card's height account for the
        buttons rather than ignore them. `pt-12` keeps the card's top edge where
        it has always been, clear of the "CarpoolNU" title; the bottom padding
        restates the `bottom-6` the strip used to position itself with and adds
        `env(safe-area-inset-bottom)`, so `Continue` clears a home indicator.
        The `0px` fallback is load-bearing for the same reason it is in
        `breakpoints.js`: `env()` with no fallback invalidates the whole
        `calc()` on a browser that does not know the variable, which would drop
        the padding entirely rather than drop the inset.

        `desktop-tall:flex-row` restores the original direction rather than
        leaving the column in place, so the card keeps the desktop behaviour it
        has today. Height is the main axis in a column and the cross axis in a
        row, and a flex item only shrinks along the main axis - which is exactly
        why the direction is the thing that has to be conditional. In a row the
        500px card refuses to shrink however short the window is, so it was
        clipped rather than fitted; in a column it shrinks to what is left.

        **The condition gained a height term for SCRUM-474.** It was
        `desktop:flex-row`, a `min-width` and nothing else, so a phone in
        landscape - 667px wide, 375px tall, above the breakpoint - was handed
        the arrangement that cannot shrink. Switching on
        `WIZARD_DESKTOP_MIN_HEIGHT_PX` as well means the row is used only where
        it fits, and the column below it is not a new layout but the one a phone
        already gets. Desktop above that height is untouched, which is measured
        rather than asserted: the card and the strip land on identical boxes
        either side of this change at 1280x900.

        `min-h-0` on the card is *redundant today* and kept deliberately. A flex
        item's default `min-height: auto` would floor the card at its requested
        700px and push the buttons off the bottom of the screen - trading the
        overlap for something worse - but `overflow-y-auto` already zeroes that
        automatic minimum, because the rule only applies to a `visible`
        overflow. The two are independent routes to the same thing and either
        alone is enough; with neither the card measures 700px in a 667px
        viewport. This is the one that still holds if the scroll area ever moves
        to an inner element.
      */}
      <div className="desktop-tall:flex-row desktop-tall:gap-0 desktop-tall:p-0 fixed inset-0 flex flex-col items-center justify-center gap-4 pt-12 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]">
        <SetupContainer
          className={`${containerPadding()} min-h-0 overflow-y-auto`}
          style={
            isMobile
              ? {
                  height: `${mobileHeights[step as keyof typeof mobileHeights]}px`,
                }
              : undefined
          }
        >
          {(step === 0 || step == 1) && (
            <InitialStep
              handleNextStep={handleNextStep}
              step={step}
              errors={errors}
              register={register}
              watch={watch}
              setValue={setValue}
            />
          )}
          {step === 2 && (
            <div
              className={`relative z-0 ${isMobile ? "scale-95 transform" : ""}`}
            >
              <StepTwo
                control={control}
                register={register}
                errors={errors}
                startAddressHook={startAddressHook}
                companyAddressHook={companyAddressHook}
              />
            </div>
          )}
          {step === 3 && (
            <StepThree
              control={control}
              user={user}
              watch={watch}
              errors={errors}
              setValue={setValue}
            />
          )}
          {step === 4 && (
            <StepFour
              setValue={setValue}
              watch={watch}
              onFileSelect={setSelectedFile}
              errors={errors}
              register={register}
            />
          )}
        </SetupContainer>

        {step > 0 && (
          <div className={buttonContainerClass}>
            {step > 1 && (
              <button
                type="button"
                className={backButtonClass}
                onClick={() => setStep((prevStep) => Math.max(prevStep - 1, 0))}
              >
                Previous
              </button>
            )}
            <button
              type="button"
              className={`${continueBaseClass} ${
                step === 4 || watch("role") === Role.VIEWER
                  ? continueButtonFinalStepClass
                  : continueButtonDefaultClass
              }`}
              onClick={handleNextStep}
            >
              <div
                className={`font-montserrat flex items-center ${isMobile ? "text-xl" : "text-2xl"} font-bold`}
              >
                {watch("role") === Role.VIEWER
                  ? "View Map"
                  : step === 4
                    ? "Complete"
                    : "Continue"}
                {step !== 4 && watch("role") !== Role.VIEWER && (
                  <FaArrowRight
                    className={`${isMobile ? "ml-1" : "ml-2"} text-black`}
                  />
                )}
              </div>
            </button>
          </div>
        )}
      </div>
      {showViewerConfirm && (
        <ViewerConfirmModal
          onCancel={() => setShowViewerConfirm(false)}
          onConfirm={async () => {
            setShowViewerConfirm(false);
            await handleSubmit(onSubmit)();
          }}
        />
      )}
    </div>
  );
};

export default Setup;
