import { RiFocus3Line } from "react-icons/ri";
import useIsMobile from "../../utils/useIsMobile";

interface RecentreButtonProps {
  /** Fly the map back to the signed-in user's workplace. */
  onRecentre: () => void;
}

/**
 * Puts the map back on the user's workplace.
 *
 * **Previously desktop-only**, so a mobile user who panned away
 * from their workplace had no way back to it.
 *
 * Lifted out of `index.tsx` rather than un-gated in place, for the reason
 * given about that file: it is ~1300 lines behind Mapbox, NextAuth
 * and a dozen tRPC queries and has no test, so a control living inside it is a
 * control nothing checks. Reachability is exactly what this ticket is about -
 * five of its six defects were controls that existed on one platform and not
 * the other - so "this button is in the tree at a mobile width" is worth being
 * able to assert rather than read off a diff.
 *
 * **Its mobile position is not from the phase 1 tokens**, which is a departure
 * from what the ticket expected. Those tokens position against the bottom
 * navigation, and the bottom is the one edge this control cannot use: Mapbox's
 * own `NavigationControl` is added at `bottom-right` in `addMapEvents.tsx`,
 * the explore sheet covers the lower viewport at `z-20`, and the navigation
 * sits above both at `z-index: 100`. The top edge is the only side nothing
 * else claims. The map row is already offset below the banner in `index.tsx`,
 * so the top of the map is clear.
 *
 * 44px on mobile against the desktop 32px, matching the touch target
 * settled on for the explore sheet's handle. jsdom measures nothing,
 * so that is arithmetic and not a measurement.
 */
export const RecentreButton = (props: RecentreButtonProps) => {
  const isMobile = useIsMobile();

  return (
    <button
      type="button"
      className={
        isMobile
          ? "absolute top-2 right-2 z-10 flex h-11 w-11 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200"
          : "absolute right-[8px] bottom-[150px] z-10 flex h-8 w-8 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200"
      }
      aria-label="Recentre the map on your workplace"
      onClick={props.onRecentre}
    >
      <RiFocus3Line aria-hidden="true" />
    </button>
  );
};
