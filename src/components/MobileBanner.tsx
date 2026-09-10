import useIsMobile from "../utils/useIsMobile";

/**
 * The fixed bar telling mobile users to try the desktop site.
 *
 * Moved out of `index.tsx` unchanged (SCRUM-415). It was declared **inside**
 * `Home`'s render body, which meant React saw a brand-new component *type* on
 * every render of a 918-line page behind Mapbox, NextAuth and a dozen tRPC
 * queries. A new type is not a re-render, it is a remount: React tore the
 * subtree down and rebuilt it rather than updating it. Harmless for a `<div>`
 * of static text, and a trap for whatever gets added to it next.
 *
 * **The styling is copied verbatim, including its contradictions.** The
 * `className` says `absolute … z-[9999]` while the inline `style` says
 * `position: fixed`, and the inline value wins — so `absolute` is dead, and
 * `top-0` and `z-[9999]` are each stated twice in two syntaxes. Tidying that
 * would change emitted CSS with no way to check the result: jsdom does not lay
 * out (see `src/testing/viewport.ts`), so "the banner still looks the same" is
 * not assertable here. This ticket's own acceptance criterion is that rendered
 * output is unchanged, and a verbatim copy is the only version of this change
 * that guarantees it.
 *
 * **It is also on its way out**, which is the stronger reason to leave it
 * alone. SCRUM-415 exists to delete this component: the banner is a deliberate
 * statement that mobile is secondary, and it stops being *true* once SCRUM-414
 * finishes giving mobile the capabilities it names. Two of those - the map-pin
 * sheet and the legend/recentre controls - are still unstarted, so the banner
 * is still accurate and still has to stay. Restyling something scheduled for
 * removal is work done twice.
 *
 * When it does go, four sites compensate for its height and all four have to
 * go with it. They are listed on SCRUM-415; note that the ticket's own
 * evidence names `top-[6rem]` on the profile page as one of them and that is
 * wrong - this component is local to the explore page, so `/profile` never
 * renders it.
 */
export const MobileBanner = () => {
  const isMobile = useIsMobile();

  /**
   * Self-hiding rather than gated by its caller, which is how it already
   * behaved. Preserved deliberately: the whole reason this component exists is
   * "show this on mobile", and moving that decision to the call site is how a
   * second call site comes to forget it.
   */
  if (!isMobile) return null;

  return (
    <div
      className="absolute top-0 right-0 left-0 z-[9999] bg-yellow-100 px-4 py-1 text-center text-xs text-black"
      style={{
        width: "100%",
        position: "fixed",
        top: 0,
        zIndex: 9999,
      }}
    >
      For the full experience, try using CarpoolNU on desktop
    </div>
  );
};

export default MobileBanner;
