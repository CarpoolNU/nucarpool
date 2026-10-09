import React, { useEffect, useCallback, useRef } from "react";
import type { SetStateAction } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";
import { toast } from "react-toastify/unstyled";

import { driver, type Driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import useIsMobile from "../utils/useIsMobile";
import type { SheetDetent } from "../utils/explore/sheetDetents";

/**
 * What the mobile tour forces the explore sheet to while highlighting three of
 * its steps, keyed by the step's index in `mobileSteps` below.
 *
 * The sidebar step (`[data-testid="explore-sidebar"]`) needs the sheet's
 * height nonzero: a VIEWER's opening detent is `collapsed`, which
 * `MOBILE_SIDEBAR_CLASSES.collapsed` in `pages/index.tsx` renders as `h-0
 * opacity-0 pointer-events-none`, so without this the tour anchors a popover
 * to an element that is there but invisible. The safety step sits on that
 * same element and carries its own entry rather than inheriting the one
 * before it: driver.js calls `onHighlightStarted` per step, and a user
 * stepping backwards into it from the map step arrives with the sheet
 * collapsed. The map step (`#map`) needs the opposite: a RIDER or DRIVER's
 * own opening detent is `expanded`, which pins the sheet over roughly 85% of
 * the map, so this collapses it first.
 *
 * **These keys are step indices, so inserting a step shifts them.** The map
 * step moved from 2 to 3 when the safety step went in at 2.
 * `WelcomeTutorial.test.tsx` asserts every key still lands on the element its
 * entry was written for, so a later insertion cannot silently desync them.
 */
export const MOBILE_STEP_DETENTS: Partial<Record<number, SheetDetent>> = {
  1: "expanded",
  2: "expanded",
  3: "collapsed",
};

/**
 * The safety step's copy, shared by both variants.
 *
 * Held here rather than written out twice because the two step arrays below
 * are the one place in this component where the same user-facing sentence has
 * to appear in two literals, and an edit to one of them would otherwise leave
 * a phone and a laptop telling a user different things about what reporting
 * does.
 *
 * Every claim it makes is one the server actually keeps: `user.reports.create`
 * notifies admins and nobody else, `user.blocks.block` notifies nobody at all
 * and hides both directions, and `user.blocks.unblock` reverses it.
 */
export const SAFETY_STEP_TITLE = "If someone makes you uncomfortable";
export const SAFETY_STEP_DESCRIPTION =
  "Every card and conversation has a menu holding Report and Block. A report goes to the admins only, and the other person is never told. A block hides the two of you from each other, and you can undo it from your profile.";

interface WelcomeTutorialProps {
  onComplete?: () => void;
  /**
   * The mobile explore sheet's current resting detent, and the setter that
   * drives it - both undefined on desktop, where no such state exists. The
   * tour reads `sheetDetent` once, at mount, to know what to restore, and
   * writes through `setSheetDetent` to force the two steps above into view.
   */
  sheetDetent?: SheetDetent;
  setSheetDetent?: (next: SetStateAction<SheetDetent>) => void;
}

const WelcomeTutorial: React.FC<WelcomeTutorialProps> = ({
  onComplete,
  sheetDetent,
  setSheetDetent,
}) => {
  const { data: session, update } = useSession();
  // A ref rather than state: this component renders `null`, so the flag has no
  // bearing on any output, and as state it would be both a dependency of the
  // tour effect and something the effect's own teardown sets - which would
  // make a single completion re-run the effect and build another tour. A ref
  // is also the stricter guard, since `setState` would not be visible to a
  // second call in the same tick.
  const isCompletingRef = useRef(false);
  // Use the exact same mobile detection as the main page
  const isMobile = useIsMobile();

  const utils = trpc.useUtils();

  const completeTutorialMutation = trpc.user.completeTutorial.useMutation({
    onSuccess: async () => {
      utils.user.me.invalidate();
      // Update session to reflect tutorial completion
      await update();
      isCompletingRef.current = false; // Reset completion flag
      onComplete?.();
    },
    onError: (error) => {
      console.error("Error completing tutorial:", error);
      isCompletingRef.current = false; // Reset completion flag on error
      toast.error("Something went wrong. Please try again.");
    },
  });

  const handleComplete = useCallback(async () => {
    if (isCompletingRef.current) return; // Prevent multiple completions
    isCompletingRef.current = true;
    try {
      await completeTutorialMutation.mutateAsync();
    } catch (error) {
      isCompletingRef.current = false; // Reset if error occurs
    }
  }, [completeTutorialMutation]);

  /**
   * The driver.js hooks are wired once, when the tour is built, but they have
   * to call the *current* `handleComplete`. Reaching it through a ref is what
   * keeps its identity out of the tour effect's dependency array below.
   *
   * It cannot be a dependency: `completeTutorialMutation` is the object
   * React Query v5's `useMutation` returns, and that is an object literal
   * rebuilt on every render (`return { ...result, mutate, mutateAsync }`). So
   * `handleComplete` is never referentially stable, and depending on it re-ran
   * the effect - tearing down the live tour and starting a new one from step 1
   * - on every single render of this component.
   */
  const handleCompleteRef = useRef(handleComplete);
  useEffect(() => {
    handleCompleteRef.current = handleComplete;
  }, [handleComplete]);

  /**
   * Same reasoning as `handleCompleteRef` above, for the same reason: the
   * mobile steps' `onHighlightStarted` hooks are wired once, when the tour is
   * built, but must call the *current* `setSheetDetent` - and it cannot be a
   * dependency of the tour effect without re-running it, and therefore
   * rebuilding the tour, on every render.
   */
  const setSheetDetentRef = useRef(setSheetDetent);
  useEffect(() => {
    setSheetDetentRef.current = setSheetDetent;
  }, [setSheetDetent]);

  /**
   * `sheetDetent` itself cannot be read directly inside the tour effect
   * below, for the same reason `handleComplete` is not: the effect's
   * dependency array does not include it (see `openingDetent` inside), so a
   * direct reference there is exactly what `react-hooks/exhaustive-deps`
   * flags as stale. Reading it through a ref sidesteps the lint rule the
   * same way the codebase already does for `handleComplete`, and is exactly
   * as correct here, since the effect only ever reads `.current` once, at
   * the moment it runs.
   */
  const sheetDetentRef = useRef(sheetDetent);
  useEffect(() => {
    sheetDetentRef.current = sheetDetent;
  }, [sheetDetent]);

  useEffect(() => {
    const userName = session?.user?.name;
    if (!userName) return;

    /**
     * React unmounting this component, or re-running this effect, is not the
     * user finishing the tour - but driver.js cannot tell the difference on
     * its own. Its public `destroy()` is bound to `h(false)`, and the `false`
     * is precisely what skips the `onDestroyStarted` guard and drops straight
     * into the teardown that invokes `onDestroyed`. So the hook has to make
     * that distinction itself, or every teardown reports a completed tutorial
     * to the server.
     */
    let isCleaningUp = false;

    /**
     * The detent the sheet was resting at before this tour touched it - a
     * snapshot taken once, since this effect does not depend on `sheetDetent`
     * (that would re-run the whole effect on every step the mobile tour
     * drives, rebuilding the tour exactly the way the fix above avoids).
     * `undefined` on desktop, where the prop is never passed.
     */
    const openingDetent = sheetDetentRef.current;

    const firstName = userName.split(" ")[0];

    const desktopSteps: DriveStep[] = [
      {
        popover: {
          title: `Welcome to Carpool, ${firstName}!`,
          description:
            "Let's take a quick tour to help you get started with NU Carpool.",
          showButtons: ["next", "close"],
          nextBtnText: "Show Me Around",
        },
      },
      {
        element: '[data-testid="explore-sidebar"]',
        popover: {
          title: "These are drivers",
          description:
            "Browse through available drivers in your area. You can view their profiles, ratings, and routes.",
          side: "right",
          align: "start",
        },
      },
      {
        element: '[data-testid="explore-sidebar"]',
        popover: {
          title: SAFETY_STEP_TITLE,
          description: SAFETY_STEP_DESCRIPTION,
          side: "right",
          align: "start",
        },
      },
      {
        element: "#map",
        popover: {
          title: "This is the map",
          description:
            "Explore the map to find the best routes and nearby drivers.",
          side: "top",
          align: "center",
        },
      },
      {
        element: '[data-testid="navigation-desktop"]',
        popover: {
          title: "This is the navigation bar",
          description:
            "Navigate through your requests, group details, and profile.",
          side: "bottom",
          align: "center",
        },
      },
      {
        popover: {
          title: "You're all set!",
          description:
            "Enjoy using NU Carpool to find or offer rides with your fellow students.",
          showButtons: ["close"],
        },
      },
    ];

    const mobileSteps: DriveStep[] = [
      {
        popover: {
          title: `Welcome to Carpool, ${firstName}!`,
          description:
            "Let's take a quick tour to help you get started with NU Carpool.",
          showButtons: ["next", "close"],
          nextBtnText: "Show Me Around",
        },
      },
      {
        element: '[data-testid="explore-sidebar"]',
        // Forces the sheet open before this step is measured or shown - see
        // `MOBILE_STEP_DETENTS`. Without it a VIEWER's opening `collapsed`
        // detent leaves this element `h-0 opacity-0`, so the popover anchors
        // to nothing.
        onHighlightStarted: () =>
          setSheetDetentRef.current?.(MOBILE_STEP_DETENTS[1]!),
        popover: {
          title: "This is your sidebar",
          description:
            "Browse your matches, manage favorites, and track requests here.",
          side: "top",
          align: "center",
        },
      },
      {
        element: '[data-testid="explore-sidebar"]',
        // Its own entry in `MOBILE_STEP_DETENTS`, for the reason given there:
        // arriving here backwards from the map step means arriving with the
        // sheet collapsed.
        onHighlightStarted: () =>
          setSheetDetentRef.current?.(MOBILE_STEP_DETENTS[2]!),
        popover: {
          title: SAFETY_STEP_TITLE,
          description: SAFETY_STEP_DESCRIPTION,
          side: "top",
          align: "center",
        },
      },
      {
        element: "#map",
        // Collapses the sheet before this step is measured or shown - a
        // RIDER or DRIVER's opening `expanded` detent otherwise pins the
        // sheet over roughly 85% of the map this step claims to show.
        onHighlightStarted: () =>
          setSheetDetentRef.current?.(MOBILE_STEP_DETENTS[3]!),
        popover: {
          title: "This is the map",
          description:
            "Explore the map to find the best routes and nearby drivers.",
          side: "top",
          align: "center",
        },
      },
      {
        element: '[data-testid="navigation"]',
        popover: {
          title: "This is the navigation bar",
          description:
            "Navigate through your requests, group details, and profile.",
          side: "top",
          align: "center",
        },
      },
      {
        popover: {
          title: "You're all set!",
          description:
            "Enjoy using NU Carpool to find or offer rides with your fellow students.",
          showButtons: ["close"],
        },
      },
    ];

    // One `driver()` call for both platforms. The two configurations only
    // ever differ in their steps, and holding the hooks in one place is what
    // stops the mobile and desktop teardowns from drifting apart.
    const driverInstance: Driver = driver({
      popoverClass: "welcome-tutorial-popover",
      showProgress: true,
      allowClose: true,
      overlayColor: "rgba(0, 0, 0, 0.4)",
      steps: isMobile ? mobileSteps : desktopSteps,
      // Reached only from a genuine end of the tour: `onDestroyStarted` below
      // is the single caller that destroys, and React's cleanup sets the flag
      // first. No `onCloseClick` is configured deliberately - a configured one
      // *replaces* driver.js's own close handler, which is the guarded
      // `h(true)` path, so the ✕ would complete the tutorial without ever
      // closing the tour or asking for confirmation.
      onDestroyed: () => {
        // Fires on every real teardown - a genuine finish, a confirmed skip,
        // and the `destroy()` call below that React's own cleanup makes - so
        // this is the one place that reaches all of them, synchronously,
        // rather than waiting on `handleComplete`'s round trip to the server.
        if (isMobile && openingDetent !== undefined) {
          setSheetDetentRef.current?.(openingDetent);
        }
        if (isCleaningUp) return;
        handleCompleteRef.current();
      },
      // Handle early exit with confirmation
      onDestroyStarted: () => {
        if (
          driverInstance.hasNextStep() &&
          !confirm("Are you sure you want to skip the tour?")
        ) {
          return; // Prevent destruction
        }
        driverInstance.destroy(); // Ensure all instances are destroyed
      },
    });

    // Start the appropriate tour
    driverInstance.drive();

    return () => {
      isCleaningUp = true;
      driverInstance.destroy();
    };
  }, [session?.user?.name, isMobile]);

  if (!session?.user?.name) {
    return null;
  }

  return null; // driver.js handles the UI
};

export default WelcomeTutorial;
