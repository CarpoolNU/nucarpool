import { useRouter } from "next/router";
import { MOBILE_NAV_SPACE } from "../../utils/breakpoints";

/**
 * What `/admin` shows instead of the dashboard below the mobile breakpoint.
 *
 * The dashboard is two columns - a `min-w-[175px]` sidebar beside four chart
 * components - so at 375px the charts were left about 200px to draw in. This
 * says so rather than rendering them into that space.
 *
 * **It is a deliberate removal of a capability, not a layout adaptation**, and
 * that was the choice made on the ticket over stacking the columns. Two
 * reasons. `adminRouter` requires `permission !== "USER"`, so the audience is
 * staff and managers and the work - reading charts, changing permissions - is
 * desk work in practice. And the dashboard's one privileged control is
 * `admin.updateUserPermission`; a cramped column around a mutation that grants
 * and revokes access is worth not shipping at all, rather than shipping small.
 *
 * Adapting the layout properly is the option SCRUM-434 describes and did not
 * take: a horizontal tab strip in place of the sidebar, plus per-component
 * work across the four charts, which are legible at 340px only with fewer
 * ticks and rotated labels. That was left undone deliberately rather than
 * deferred to a ticket, because it should only be built if someone turns out
 * to need the dashboard on a phone. This panel is not the obstacle to it.
 *
 * **It is no longer only the narrow case.** SCRUM-484 added a height term to
 * the gate in `admin.tsx`, so this also stands in for the console on a
 * viewport that is wide enough and too short - a phone in landscape, which is
 * 667x375 and therefore above the width breakpoint. Two things below follow
 * from that and neither is cosmetic: the copy no longer says "wider", because
 * the screen arriving here may be plenty wide, and the navigation allowance is
 * now conditional, because the bar it clears is not always rendered.
 */
type AdminMobileNoticeProps = {
  /**
   * Whether `Header` is currently rendering its fixed bottom navigation, which
   * is true at mobile *width* and not at mobile height.
   *
   * A prop rather than a second `useIsMobile()` call in here. The two reads
   * would be the same value in practice, but the question this component is
   * answering is "is that bar on screen", and the page above already knows -
   * it is the same `isMobile` that chose which `Header` branch to render.
   * Asking again would make it possible for the answer to differ from the one
   * that actually decided.
   */
  reservesMobileNav: boolean;
};

const AdminMobileNotice = ({ reservesMobileNav }: AdminMobileNoticeProps) => {
  const router = useRouter();

  return (
    /*
     * `paddingBottom` clears the fixed bottom navigation, which `Header`
     * renders on mobile in place of the desktop bar. `MOBILE_NAV_SPACE` is the
     * same module `tailwind.config.js` and `MobileNav` itself read, so this
     * cannot drift from the bar's real height the way three hand-written
     * offsets did before that token existed.
     *
     * Inline rather than the matching padding utility because the value
     * carries an `env()` safe-area term: this is one declaration either way,
     * and the inline form keeps the reason next to it. Naming that utility
     * here is also not free - Tailwind v4 scans this comment, so writing it in
     * prose would ship it as CSS whether or not anything uses it.
     *
     * **`undefined` and not `0` when there is no bar**, so the declaration is
     * absent rather than present with a zero value. Either renders the same;
     * the absent one does not invite a reader to wonder which rule the zero is
     * overriding.
     *
     * The height moves with it, and this is the half that is easy to miss.
     * The bottom navigation is `position: fixed`, so on a mobile-width
     * viewport it takes no space in flow and `h-full` correctly fills the page
     * box. The desktop bar is *in flow*, so the same `h-full` would run the
     * bar's whole height past the bottom of the viewport - this panel is the
     * bar's sibling, not its child. `h-content-row` is the remainder the
     * console's own row takes at `admin.tsx:120`, so the notice occupies
     * exactly the space the layout it replaces would have.
     *
     * The remainder is a token rather than a second percentage because
     * SCRUM-496 gave the bar a 44px floor, so below 517.65px of viewport
     * height the bar is that floor and the row is what is left of `100%`
     * after it. `breakpoints.js` composes it; this site only has to name the
     * same one the row does.
     */
    <div
      className={`flex w-full flex-col items-center justify-center px-8 text-center ${
        reservesMobileNav ? "h-full" : "h-content-row"
      }`}
      style={{
        paddingBottom: reservesMobileNav ? MOBILE_NAV_SPACE : undefined,
      }}
    >
      <h1 className="text-northeastern-red font-montserrat text-2xl font-bold">
        Admin needs a bigger screen
      </h1>

      <p className="font-montserrat mt-4 text-base text-stone-700">
        The dashboard&apos;s charts and user management are built for desktop.
        Open this page on a computer to use them.
      </p>

      {/*
       * The labelled way back. `Header`'s mobile branch renders only the
       * bottom navigation, so the desktop admin header - whose sole control is
       * a "Home" button - is not on screen to return from.
       *
       * Tapping Explore in that bottom bar does also reach the map, and did
       * before this panel existed. That is an unlabelled escape route rather
       * than a way back, which is the gap this closes.
       *
       * `min-h-11` is 44px, the target size Apple's HIG and WCAG 2.5.5 ask
       * for and the figure `RecentreButton` and `MapLegend` already use.
       */}
      <button
        type="button"
        onClick={() => router.push("/")}
        className="bg-northeastern-red font-montserrat mt-8 flex min-h-11 items-center rounded-lg px-6 font-medium text-white"
      >
        Back to map
      </button>
    </div>
  );
};

export default AdminMobileNotice;
