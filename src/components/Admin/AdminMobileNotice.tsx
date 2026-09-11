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
 */
const AdminMobileNotice = () => {
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
     */
    <div
      className="flex h-full w-full flex-col items-center justify-center px-8 text-center"
      style={{ paddingBottom: MOBILE_NAV_SPACE }}
    >
      <h1 className="text-northeastern-red font-montserrat text-2xl font-bold">
        Admin needs a wider screen
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
