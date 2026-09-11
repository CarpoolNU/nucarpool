import RedSquare from "../../../public/driver-dest.png";
import BlueSquare from "../../../public/user-dest.png";
import UserDriver from "../../../public/user-dest-driver.png";
import OrangeSquare from "../../../public/rider-dest.png";
import Image from "next/image";
import { useState } from "react";
import useIsMobile from "../../utils/useIsMobile";

interface MapLegendProps {
  role: string;
}

/**
 * What the pin colours mean.
 *
 * **Previously desktop-only**, which left the colour encoding
 * unexplained on the platform where the map is most of the screen.
 *
 * Un-gating it as-is would not have worked: the panel is anchored to the
 * bottom left, and on mobile the explore sheet occupies the bottom of the
 * viewport at `z-20` against this panel's `z-10`, so it would have been
 * covered whenever the sheet was open - which is its default state. So on
 * mobile it moves to the top of the map and starts **collapsed**, behind a
 * toggle, which is what the ticket suggested: a three-row panel permanently
 * over a phone-sized map costs more than it explains.
 *
 * Desktop keeps the always-open panel in the same place, with the same
 * classes. The collapse state is only consulted on mobile.
 */
export const MapLegend = (props: MapLegendProps) => {
  const role = props.role;
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);

  /** Desktop has no toggle, so it must not be gated on the collapse state. */
  const showEntries = !isMobile || isOpen;

  /**
   * Top left on mobile, bottom left on desktop.
   *
   * The top edge is the only side of a mobile map that nothing else claims:
   * the bottom holds the navigation, the explore sheet and Mapbox's own
   * `NavigationControl`. The banner is not a problem here even though it is
   * fixed at `z-[9999]` - the row this map sits in is already pushed down by
   * its height in `index.tsx`, so the map's own top edge is below it.
   */
  const containerClasses = isMobile
    ? "text-md absolute top-2 left-2 z-10 flex flex-col rounded-xl border border-gray-200 bg-white p-2 md:text-lg"
    : "text-md absolute bottom-8 left-2 z-10 flex flex-col rounded-xl border border-gray-200 bg-white p-2 md:text-lg";

  return (
    <>
      <div className={containerClasses}>
        {isMobile && (
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            aria-expanded={isOpen}
            className="flex min-h-11 items-center px-1 text-left font-medium"
          >
            {/*
             * Named "Map legend" rather than the more obvious "Legend" so the
             * accessible name still says what it is out of context, which is
             * how a screen reader will read it.
             */}
            Map legend
          </button>
        )}
        {showEntries && (
          <>
            <div className="my-1 flex flex-row items-center">
              {(role === "VIEWER" || role === "RIDER") && (
                <Image
                  className=""
                  alt=""
                  src={BlueSquare}
                  width={32}
                  height={42}
                />
              )}
              {role === "DRIVER" && (
                <Image
                  className=""
                  alt=""
                  src={UserDriver}
                  width={32}
                  height={42}
                />
              )}
              <p className="mx-2">My Destination</p>
            </div>
            {(role === "VIEWER" || role === "RIDER") && (
              <div className="my-1 flex flex-row items-center">
                <Image
                  className=""
                  alt=""
                  src={RedSquare}
                  width={32}
                  height={42}
                />
                <p className="mx-2">{"Driver Destination"}</p>
              </div>
            )}
            {(role === "VIEWER" || role === "DRIVER") && (
              <div className="my-1 flex flex-row items-center">
                <Image
                  className=""
                  alt=""
                  src={OrangeSquare}
                  width={32}
                  height={42}
                />
                <p className="mx-2">{"Rider Destination"}</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
};
