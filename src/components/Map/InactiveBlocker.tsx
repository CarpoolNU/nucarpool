import { useState } from "react";
import { useRouter } from "next/router";
import Spinner from "../Spinner";
import { profileTabRoute } from "../../utils/profile/profileTab";

const InactiveBlocker = () => {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  /**
   * Straight to the tab holding the status toggle, not to the profile's
   * front door.
   *
   * This pushed a bare `/profile`, which opens on "User Profile" - so the
   * one action this overlay offers landed the user two tabs away from the
   * only control that dismisses it, with nothing naming where to go next.
   * SCRUM-667.
   */
  const handleProfileClick = async () => {
    setIsLoading(true);
    await router.push(profileTabRoute("account"));
    setIsLoading(false);
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-md">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          <Spinner />
        </div>
      )}
      <div
        className="mx-auto max-w-md rounded-lg bg-white p-8 text-center shadow-lg"
        role="alert"
        aria-live="assertive"
      >
        <h1 className="mb-4 text-3xl font-bold">You are currently inactive</h1>
        {/* Names the tab, because the button is not the only way anyone
            arrives at the profile and "in your profile" gave a user who got
            there by another route nothing to look for.

            "Account" rather than "Account Status" on purpose: `ProfileSidebar`
            labels this tab "Account" on mobile and "Account Status" on
            desktop, and "Account" is the one wording that reads correctly
            against both. */}
        <p className="text-lg font-medium">
          To view and interact with the map, set your status back to active on
          the Account tab of your profile.
        </p>
        <button
          onClick={handleProfileClick}
          className="bg-northeastern-red mt-6 inline-block rounded-lg px-9 py-3 text-lg font-medium text-white hover:bg-red-800"
        >
          Go to Profile
        </button>
      </div>
    </div>
  );
};

export default InactiveBlocker;
