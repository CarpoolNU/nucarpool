import { Menu, Transition } from "@headlessui/react";
import { useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import Spinner from "./Spinner";
import React, { Fragment, useState } from "react";
import { AiOutlineUser } from "react-icons/ai";
import { useRouter } from "next/router";
import useProfileImage from "../utils/useProfileImage";
import {
  signOutWithGuard,
  UnsavedChangesGuard,
} from "../utils/profile/signOutWithGuard";

interface DropDownMenuProps {
  /**
   * The unsaved-changes guard, when the page this is mounted on has one.
   *
   * Only the profile page does, and `Header` forwards it from the same prop it
   * already passes the Map button and the bottom navigation. Signing out from
   * here on `/profile` discarded pending edits exactly as `UserSection`'s
   * button did - the same defect on the other viewport - so it is routed
   * through the same guard rather than left as the one remaining unguarded
   * exit. Everywhere else this is `undefined` and the behaviour is unchanged.
   */
  checkChanges?: UnsavedChangesGuard;
}

const DropDownMenu = ({ checkChanges }: DropDownMenuProps) => {
  const { data: session } = useSession();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const {
    profileImageUrl,
    imageLoadError,
    isLoading: isProfileImageLoading,
  } = useProfileImage();

  const logout = () => {
    void signOutWithGuard(checkChanges);
  };

  const handleProfileClick = async () => {
    setIsLoading(true);
    await router.push("/profile");
    setIsLoading(false);
  };

  return (
    // `relative`: Menu.Items below is `absolute right-0`, and neither this
    // wrapper nor any ancestor up to the viewport used to be positioned, so
    // it resolved against the window instead of this trigger (SCRUM-517).
    <div className="relative z-30">
      {isLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
          <Spinner />
        </div>
      )}
      <Menu>
        {/* `h-header-control w-header-control`, not the `h-14 w-14` this
            declared, and that pair is SCRUM-491's fix. The trigger is a child
            of a bar whose height is 8.5% of the viewport, so a fixed 56px was
            unrelated to the space it had: at 667x375 the bar is 31.875px and
            this box was 56px, centred, hanging 12.06px above the screen and
            12.06px into the content row below - and hit-testing there, because
            the `z-30` wrapper above makes this a flex item with a stacking
            context. A tap aimed at the top of the page opened this menu.

            The token is `min(56px, ...)`, so it binds only where 56px does not
            fit and an ordinary desktop window is unchanged. The three children
            below take `h-full w-full` rather than a second copy of the 56 -
            one figure, applied to both axes, which is what keeps the circle
            round while it scales. `breakpoints.js` carries the derivation.

            The `width`/`height` props stay at 56: they are `next/image`'s
            intrinsic hint for the raster it requests, not a layout figure, and
            the class above is what sizes the box. */}
        <Menu.Button className="h-header-control w-header-control flex items-center justify-center overflow-hidden rounded-full">
          {isProfileImageLoading ? (
            <div className="h-full w-full rounded-full bg-gray-400" />
          ) : profileImageUrl && !imageLoadError ? (
            <Image
              src={profileImageUrl}
              alt="Profile Image"
              width={56}
              height={56}
              className="h-full w-full rounded-full object-cover"
            />
          ) : (
            <AiOutlineUser className="h-full w-full rounded-full bg-gray-400" />
          )}
        </Menu.Button>

        <Transition
          as={Fragment}
          enter="transition ease-out duration-100"
          enterFrom="transform opacity-0 scale-95"
          enterTo="transform opacity-100 scale-100"
          leave="transition ease-in duration-75"
          leaveFrom="transform opacity-100 scale-100"
          leaveTo="transform opacity-0 scale-95"
        >
          {session?.user && (
            <Menu.Items className="absolute right-0 mt-2 w-56 origin-top-right divide-y divide-gray-300 rounded-lg bg-white shadow-lg ring-1 ring-black/5 focus:outline-hidden">
              <Menu.Item
                as="div"
                className="flex flex-col items-center justify-center p-6"
              >
                <h1 className="text-lg font-bold">{session.user.name}</h1>
                <p className="text-sm font-light text-gray-500">
                  {session.user.email}
                </p>
                <button
                  onClick={handleProfileClick}
                  className="mt-4 w-4/5 rounded-2xl border border-gray-300 bg-white px-3 py-2 text-center hover:bg-gray-100"
                >
                  Profile
                </button>
                <Link
                  href="https://carpoolnu.atlassian.net/jira/software/form/dfa5383a-5436-4a1c-b434-2c4f56428623?atlOrigin=eyJpIjoiMzkwYjU1YzQwNmIzNDI0Zjk4N2NiMGQwNzAzZGE3ZWYiLCJwIjoiaiJ9"
                  className="mt-4 w-4/5 rounded-2xl border border-gray-300 bg-white px-3 py-2 text-center hover:bg-gray-100"
                >
                  Feedback
                </Link>
              </Menu.Item>
              <Menu.Item
                as="div"
                className="flex flex-col items-center justify-center px-2 py-4"
              >
                <button
                  onClick={logout}
                  className="w-4/5 rounded border border-gray-300 bg-white px-3 py-2 text-center hover:bg-gray-100"
                >
                  Sign Out
                </button>
              </Menu.Item>
            </Menu.Items>
          )}
        </Transition>
      </Menu>
    </div>
  );
};

export default DropDownMenu;
