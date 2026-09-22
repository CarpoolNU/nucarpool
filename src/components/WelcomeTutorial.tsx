import React, { useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";
import { toast } from "react-toastify/unstyled";

import { driver, type Driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import useIsMobile from "../utils/useIsMobile";

interface WelcomeTutorialProps {
  onComplete?: () => void;
}

const WelcomeTutorial: React.FC<WelcomeTutorialProps> = ({ onComplete }) => {
  const { data: session, update } = useSession();
  // A ref rather than state: this component renders `null`, so the flag has no
  // bearing on any output, and as state it was both a dependency of the tour
  // effect and something the effect's own teardown set - which made a single
  // completion re-run the effect and build another tour. A ref is also the
  // stricter guard, since `setState` would not have been visible to a second
  // call in the same tick. SCRUM-527.
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
   * - on every single render of this component. SCRUM-527.
   */
  const handleCompleteRef = useRef(handleComplete);
  useEffect(() => {
    handleCompleteRef.current = handleComplete;
  }, [handleComplete]);

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
     * to the server. SCRUM-527.
     */
    let isCleaningUp = false;

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
        popover: {
          title: "These are drivers",
          description:
            "Browse through available drivers in your area. You can view their profiles, ratings, and routes.",
          side: "top",
          align: "center",
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

    // One `driver()` call for both platforms. The two configurations only ever
    // differed in their steps, and holding the hooks in one place is what stops
    // the mobile and desktop teardowns from drifting apart again.
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
