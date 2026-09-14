/**
 * The one place the app decides where "mobile" ends.
 *
 * CommonJS on purpose. `tailwind.config.js` has to `require` this, and Tailwind's
 * config is not run through the TypeScript pipeline - so the value cannot live in
 * a `.ts` file if the CSS and the JavaScript are to share a single definition
 * rather than two numbers that happen to match.
 *
 * Before this existed there were two thresholds: `useIsMobile` used 640 and
 * `Header` used 768, so every viewport between them rendered the desktop layout
 * and the mobile bottom navigation at the same time, leaving no usable header.
 *
 * 640 is the value the pages already used, so adopting it changes nothing except
 * the band that was broken. It is deliberately *not* one of the `sm`/`md`/`lg`
 * sizes: `tailwind.config.js` overrides Tailwind's defaults (`sm` is 576px here,
 * `md` is 834px), so 640 was never a Tailwind breakpoint in this project. It is
 * registered as its own screen instead.
 *
 * Caveat worth knowing when comparing against CSS: `window.innerWidth` counts the
 * scrollbar and a CSS media query does not, so the two can disagree by a scrollbar
 * width within a few pixels of the boundary. Kept as-is because that is the
 * existing behaviour and the alternative changes which side of the line some
 * viewports fall on.
 */
const MOBILE_BREAKPOINT_PX = 640;

/**
 * Tailwind screens are `min-width`, so the screen is named for the side of the
 * boundary it turns on: `desktop:flex` applies at `MOBILE_BREAKPOINT_PX` and up.
 * Naming it `mobile:` would read backwards - it would apply everywhere except
 * mobile.
 */
const DESKTOP_SCREEN_NAME = "desktop";

/**
 * The same boundary as a media query, for CSS that cannot reach the `desktop:`
 * screen - a styled-components template.
 *
 * `Header` held three hand-written `@media (max-width: 768px)` blocks after the
 * JavaScript was unified on 640, so viewports between the two got the desktop
 * header wearing mobile padding and a mobile logo. This exists so that a
 * template states the boundary by reading it rather than by restating a number.
 *
 * A `min-width` query, and that direction is deliberate rather than a style
 * preference. It matches `isMobileWidth`, which is strictly below the
 * breakpoint, and the `desktop:` screen, which turns on at it - so a template
 * declares its mobile values as the base and overrides them in here. Inverting
 * a `max-width` block instead would need `max-width: 639.98px`, because a CSS
 * range is inclusive at both ends and `max-width: 640px` would claim the
 * breakpoint itself for mobile, disagreeing with the JavaScript by exactly one
 * pixel - the fractional value is the tell that the query is fighting the
 * constant's semantics.
 */
const DESKTOP_MEDIA_QUERY = `(min-width: ${MOBILE_BREAKPOINT_PX}px)`;

/**
 * The name of the screen that means "wide enough for the desktop layout *and*
 * tall enough to lay it out", used by the onboarding wizard.
 *
 * `desktop:` is a `min-width` and nothing else, which is the defect SCRUM-474
 * records: a phone held in landscape is 667px wide, so it is above the
 * breakpoint and takes every desktop branch - into a viewport 375px tall.
 *
 * Deliberately a *second* screen rather than a height term added to
 * `MOBILE_BREAKPOINT_PX`. That constant is read by `useIsMobile`, by the
 * `desktop:` screen and by `DESKTOP_MEDIA_QUERY`, so giving it a height would
 * move every page across the line at once - a far larger change than the defect
 * justifies, and one that needs its own survey. This adds a variant the wizard
 * opts into and changes no existing one.
 */
const DESKTOP_TALL_SCREEN_NAME = "desktop-tall";

/**
 * The onboarding card's desktop height, in pixels - the `h-[500px]` that
 * `SetupContainer` declares.
 *
 * Restated here only so the threshold below can be *composed* from it rather
 * than from a number typed twice. `setupNavigationPlacement.test.tsx` asserts
 * the component really does request this height, so the two cannot drift apart
 * without a test failing.
 */
const WIZARD_CARD_HEIGHT_PX = 500;

/**
 * The vertical space the `Previous`/`Continue` strip occupies at the bottom of
 * the desktop arrangement: the strip itself, plus the 40px it is raised off the
 * bottom edge by.
 *
 * The offset is written as a number rather than as the utility that sets it,
 * deliberately. Tailwind v4 scans this file like any other, so naming a bare
 * utility in prose emits it as real CSS - the effect `tailwind.config.js`
 * describes at length.
 *
 * **132 of this is measured, not declared** - it is two buttons and a `gap-6`
 * at the desktop type scale, so it follows the font and the padding rather than
 * any constant. Measured in Chromium against the compiled stylesheet, on the
 * steps that draw both buttons; step 1 draws only `Continue` and is 56px, so
 * this is the worst case and therefore the right one to reserve.
 */
const WIZARD_NAV_STRIP_SPACE_PX = 132 + 40;

/**
 * The shortest viewport the onboarding wizard's *desktop* arrangement actually
 * fits in, in pixels.
 *
 * **Derived, not chosen**, and this is the arithmetic. On desktop the wizard
 * centres the card in the viewport and pins the navigation strip to the bottom,
 * out of flow, so the two are placed by rules that know nothing about each
 * other:
 *
 *   card bottom = (H + CARD) / 2
 *   strip top   = H - STRIP
 *
 * They clear each other only while `(H + CARD) / 2 <= H - STRIP`, which solves
 * to `H >= CARD + 2 * STRIP`. The doubling is the part worth reading twice: the
 * card is *centred*, so every pixel the strip takes at the bottom costs the card
 * two.
 *
 * Verified by measurement rather than trusted - in Chromium, against the
 * compiled stylesheet, reproducing the real ancestor chain. At 900px tall the
 * card and the strip clear each other by 28px; at 844px by exactly 0; at 800px
 * the strip covers the card's last 22px; and at 375px it covers 132px of a card
 * that is itself clipped 62px off the top of the screen and 63px off the
 * bottom.
 *
 * Because the strip's share is measured, this is a floor that has to be
 * rechecked if the strip's contents change, and that is what the composition
 * above is for: the pieces are named, so the recheck is arithmetic rather than
 * archaeology. The geometry itself is not assertable in jsdom and belongs in
 * SCRUM-264's Playwright suite.
 */
const WIZARD_DESKTOP_MIN_HEIGHT_PX =
  WIZARD_CARD_HEIGHT_PX + 2 * WIZARD_NAV_STRIP_SPACE_PX;

/**
 * The same pair of conditions as a media query, which is what
 * `tailwind.config.js` registers as a screen.
 *
 * Both terms are `min-`, matching `DESKTOP_MEDIA_QUERY`'s direction and for the
 * same reason: the mobile-first arrangement is the base and this overrides it,
 * so no `max-width: 639.98px` fractional value is needed to avoid claiming the
 * boundary pixel for the wrong side.
 */
const DESKTOP_TALL_MEDIA_QUERY =
  `(min-width: ${MOBILE_BREAKPOINT_PX}px) and ` +
  `(min-height: ${WIZARD_DESKTOP_MIN_HEIGHT_PX}px)`;

/**
 * Split out from the hook so the boundary itself is testable without a DOM.
 * That was originally the only way to test it at all; the hook
 * has its own suite in `useIsMobile.test.tsx`, and this stays split because
 * `tailwind.config.js` has to `require` it and Tailwind's config is not run
 * through the TypeScript pipeline.
 *
 * Strictly below the breakpoint, matching `min-width` CSS semantics - at exactly
 * `MOBILE_BREAKPOINT_PX` the `desktop:` utilities apply, so this must be false.
 */
const isMobileWidth = (width) => width < MOBILE_BREAKPOINT_PX;

/**
 * The height of the mobile bottom navigation, in pixels.
 *
 * **Declared, not measured.** `MobileNav` used to set no height at all, so its
 * height was whatever its children summed to - about 59px, from 8px of padding
 * either side of a 24px icon and a 12px label, plus a 4px active underline and
 * a 1px top border. Three files then guessed at that number independently and
 * none of them agreed with it or with each other: the explore sheet sat 48px
 * from the bottom, the profile content 64px, and floating buttons 64px.
 *
 * 60 is the nearest round number to what the nav already rendered at, so
 * adopting it changes the layout by about a pixel. The point is not the value
 * but that `MobileNav` now takes its height *from here*, which makes the
 * declared number true by construction rather than by arithmetic that has to be
 * redone whenever a child's padding changes.
 *
 * Same reasoning as `MOBILE_BREAKPOINT_PX` above, and the same reason this file
 * is CommonJS: `tailwind.config.js` has to `require` it.
 */
const MOBILE_NAV_HEIGHT_PX = 60;

/**
 * How much room the mobile navigation actually occupies - its height plus
 * whatever the device reserves for a home indicator.
 *
 * This is the value a caller wants nine times out of ten. Anything positioned
 * against the bottom of a mobile viewport has to clear the inset as well as the
 * bar, and before this existed nothing in the repository referenced
 * `env(safe-area-inset-*)` at all, so on a home-bar iPhone the last ~34px of
 * the nav sat under the indicator.
 *
 * **The `0px` fallback is load-bearing.** `env()` with no fallback resolves to
 * nothing on a browser that does not know the variable, which makes the whole
 * `calc()` invalid and drops the declaration - so the fallback is what keeps
 * this from silently collapsing to no offset rather than to no inset. Note the
 * inset only becomes non-zero once `viewport-fit=cover` is set, which `_app.tsx`
 * owns.
 */
const MOBILE_NAV_SPACE = `calc(${MOBILE_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px))`;

/**
 * The strip of map left visible above the expanded explore sheet, in rem.
 *
 * It lived in `tailwind.config.js` and moved here because the drag gesture now
 * needs it as a *number*: `useSheetDrag` derives the sheet's expanded height
 * from the sheet's own bottom edge minus this strip, so that the range is known
 * in every detent rather than only after an expanded render (SCRUM-459).
 *
 * The rem figure is the definition and the CSS string below is derived from it,
 * rather than the other way round, because parsing `"5.5rem"` back into a
 * number at the point of use is the step that would silently produce `NaN` if
 * anyone ever wrote the value in another unit.
 *
 * **This is the only layout constant the drag reads, and that is the point.**
 * The sheet's other two - the navigation's height and the home-indicator inset
 * - cancel out of the arithmetic: both sit below the sheet's bottom edge, and
 * that edge is measured. `env(safe-area-inset-bottom)` cannot be evaluated in
 * JavaScript at all, so a derivation that needed it would be wrong on exactly
 * the devices that have one.
 */
const MOBILE_SHEET_MAP_STRIP_REM = 5.5;

/** The same strip as a CSS length, which is what `tailwind.config.js` composes. */
const MOBILE_SHEET_MAP_STRIP = `${MOBILE_SHEET_MAP_STRIP_REM}rem`;

module.exports = {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_SCREEN_NAME,
  DESKTOP_MEDIA_QUERY,
  DESKTOP_TALL_SCREEN_NAME,
  DESKTOP_TALL_MEDIA_QUERY,
  WIZARD_CARD_HEIGHT_PX,
  WIZARD_NAV_STRIP_SPACE_PX,
  WIZARD_DESKTOP_MIN_HEIGHT_PX,
  isMobileWidth,
  MOBILE_NAV_HEIGHT_PX,
  MOBILE_NAV_SPACE,
  MOBILE_SHEET_MAP_STRIP_REM,
  MOBILE_SHEET_MAP_STRIP,
};
