import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import { ConnectCard } from "../UserCards/ConnectCard";
import { Dialog } from "@headlessui/react";
import { FaTimes } from "react-icons/fa";
import useIsMobile from "../../utils/useIsMobile";

interface ConnectPortalProps {
  otherUsers: PublicUser[] | null;
  extendUser: (user: PublicUser) => EnhancedPublicUser;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onViewRequest: (userId: string) => void;
  onClose: () => void;
}

/**
 * What a tap or click on a map pin opens.
 *
 * **This rendered on desktop only, and the mobile
 * failure was worse than "nothing happens".** The click handlers in
 * `utils/map/addMapEvents.tsx` are registered unconditionally and call
 * `setPopupUsers`, but this component was the sole reader of that state *and*
 * the sole caller of its `onClose`, behind a `!isMobile` gate in `index.tsx`.
 * So a mobile tap updated state, rendered nothing, and left `popupUsers`
 * non-null for the rest of the session with no code path able to clear it.
 *
 * The gate is gone. The wiring - `extendUser`, `onViewRouteClick`,
 * `onViewRequest`, `onClose` - is identical on both platforms by construction,
 * because there is one component; only the presentation differs, which is what
 * the ticket asked for. Un-gating alone would not have worked: the desktop
 * panel is a fixed-width column anchored to the top right, beside where a
 * cursor would be.
 *
 * **Why `useIsMobile` rather than responsive utilities.** Presentation is
 * normally better expressed in CSS, and it would be correct at first paint
 * without any JavaScript. Two things decide it the other way here. The close
 * control below is a *capability*, not a style - it is the only affordance
 * that can clear `popupUsers` on a touch device - and a capability that exists
 * or does not needs to be assertable, which media queries are not: jsdom
 * evaluates none, so a control hidden by a breakpoint utility looks present to
 * every test. Second, keeping the branch in JavaScript leaves the desktop
 * class strings exactly as they were rather than restating them as overrides,
 * which is what "no desktop behaviour changes" actually requires. See
 * `src/testing/viewport.ts` for what that division of labour rests on.
 */
export const MapConnectPortal = (props: ConnectPortalProps) => {
  const isMobile = useIsMobile();

  /**
   * Where the panel sits.
   *
   * The mobile sheet stops at the top edge of the bottom navigation rather
   * than at the bottom of the viewport. `bottom-mobile-nav` is that change's
   * token for that height and already accounts for the home-indicator inset,
   * which matters because the navigation is `z-index: 100` against this
   * dialog's `z-50` - it would otherwise sit *over* the sheet, hiding whatever
   * is at the bottom of it, including the Connect button.
   *
   * `fixed`, not `absolute`: Headless UI renders the dialog through a portal,
   * so there is no positioned map container to be absolute within.
   */
  const anchorClasses = isMobile
    ? "bottom-mobile-nav fixed inset-x-0 flex justify-center"
    : "fixed inset-0 mt-20 flex items-start justify-end pt-4";

  /**
   * The panel itself. Full width with a sheet edge on mobile; on desktop the
   * same fixed-width column as before.
   *
   * A max-height class that does not exist in Tailwind or in this project's
   * theme sat on the desktop string, doing nothing. Removed rather than
   * repaired - the element below it carries the cap that actually applies.
   */
  const panelClasses = isMobile
    ? "relative w-full rounded-t-3xl border-2 border-black bg-white shadow-lg"
    : "relative mt-11 w-[26rem]";

  /**
   * The scrolling list of cards.
   *
   * The desktop version's mask gradient and percentage margins are tuned to a
   * tall column that fades at both ends. On a short sheet those percentages
   * resolve against a much smaller box and read as stray padding, so mobile
   * gets a plain scroller with a viewport-relative cap instead. `dvh` rather
   * than `vh` for the same reason `globals.css` uses it: `vh` on a mobile
   * browser is the height with the chrome retracted.
   */
  const listClasses = isMobile
    ? "max-h-[45dvh] overflow-y-auto"
    : "scrollbar scrollbar-thumb-northeastern-red scrollbar-track-rounded-full scrollbar-thumb-rounded-full mr-3 max-h-[calc(100vh-8rem)] scrollbar-track-transparent overflow-y-scroll";

  const listStyle = isMobile
    ? undefined
    : {
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 5%, black 95%, transparent 100%)",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        marginTop: "-8%",
        paddingTop: "15%",
        marginBottom: "15%",
        paddingBottom: "15%",
      };

  return (
    <Dialog
      open={!!(props.otherUsers && props.otherUsers.length > 0)}
      onClose={props.onClose}
      className="relative z-50"
    >
      <div className="fixed inset-0">
        <div className={anchorClasses}>
          <Dialog.Panel className={isMobile ? "w-full" : undefined}>
            <div className={panelClasses}>
              {/*
               * Mobile only, and the reason this item was filed rather than a
               * nicety. `Dialog` supplies backdrop-click and Escape, which is
               * all a desktop user needs, but this dialog paints no dimmed
               * overlay - so on a phone the only way out is tapping a patch of
               * map that does not look like a control. Desktop keeps exactly
               * the affordances it had, so its tab order is unchanged.
               */}
              {isMobile && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={props.onClose}
                    aria-label="Close"
                    className="flex h-11 w-11 items-center justify-center text-gray-600 hover:text-black"
                  >
                    <FaTimes aria-hidden="true" />
                  </button>
                </div>
              )}
              <div tabIndex={0} className={listClasses} style={listStyle}>
                {props.otherUsers &&
                  props.otherUsers.map((user: PublicUser) => (
                    <div key={user.id}>
                      <ConnectCard
                        otherUser={props.extendUser(user)}
                        onViewRouteClick={props.onViewRouteClick}
                        onViewRequest={props.onViewRequest}
                        onClose={(action) => {
                          if (action === "connect") props.onClose();
                        }}
                      />
                    </div>
                  ))}
              </div>
            </div>
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
};
