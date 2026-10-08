import { RiFocus3Line } from "react-icons/ri";
import useIsMobile from "../../utils/useIsMobile";
import type { MapCentreSubject } from "../../utils/map/mapHomeCentre";

/**
 * What the label calls the place this flies to. The component owns the copy and
 * the caller owns the choice, which keeps the role test in `index.tsx` where
 * the rest of them are - this button's placement rules exist precisely so it
 * does not have to know about roles.
 */
const SUBJECT_LABELS: Record<MapCentreSubject, string> = {
  workplace: "Recentre the map on your workplace",
  campus: "Recentre the map on Northeastern",
};

interface RecentreButtonProps {
  /** Fly the map back to the user's home point. */
  onRecentre: () => void;
  /**
   * Which place that is. A VIEWER has no workplace - and nor does anyone whose
   * address never resolved - so the map's home point for them is the campus,
   * and `mapHomeCentre` gives both the same answer. Defaults to `workplace`,
   * which is the case every existing caller and every existing test means.
   */
  subject?: MapCentreSubject;
}

/**
 * Puts the map back on the user's home point.
 *
 * A VIEWER - about a third of production, and a role with no `Location` row
 * at all - has no workplace, so a literal label promising one would be
 * wrong, and flying to company coordinates unconditionally would land at
 * `(0, 0)`. `mapHomeCentre` answers both halves from one place: where to
 * fly, and what to call it.
 *
 * Renders on both platforms: a mobile user who pans away from their
 * workplace needs a way back to it too.
 *
 * Lives as its own component rather than inline in `index.tsx`, because
 * that file is ~1300 lines behind Mapbox, NextAuth and a dozen tRPC queries
 * and has no test, so a control living inside it would be a control nothing
 * checks. Reachability matters here - this button needs to exist at every
 * viewport - so "this button is in the tree at a mobile width" is worth
 * being able to assert rather than read off a diff.
 *
 * **Its mobile position does not use the bottom-navigation-relative tokens
 * used elsewhere**, because the bottom is the one edge this control cannot
 * use: Mapbox's own `NavigationControl` is added at `bottom-right` in
 * `addMapEvents.tsx`, the explore sheet covers the lower viewport at
 * `z-20`, and the navigation sits above both at `z-index: 100`. The top
 * edge is the only side nothing else claims.
 *
 * **`absolute` here only works because the caller renders this inside `#map`**,
 * which is `relative`. Moved to a sibling of the map container with nothing
 * positioned between it and `#__next`, `top-2` would measure from the
 * viewport instead and land under `MobileBanner`. Keep the call site inside
 * `#map`. The offsets below are relative to the map, not to the page.
 *
 * 44px on mobile against the desktop 32px, matching the touch target
 * settled on for the explore sheet's handle. jsdom measures nothing,
 * so that is arithmetic and not a measurement.
 */
export const RecentreButton = (props: RecentreButtonProps) => {
  const isMobile = useIsMobile();
  const label = SUBJECT_LABELS[props.subject ?? "workplace"];

  return (
    <button
      type="button"
      className={
        isMobile
          ? "absolute top-2 right-2 z-10 flex h-11 w-11 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200"
          : "absolute right-[8px] bottom-[150px] z-10 flex h-8 w-8 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200"
      }
      aria-label={label}
      onClick={props.onRecentre}
    >
      <RiFocus3Line aria-hidden="true" />
    </button>
  );
};
