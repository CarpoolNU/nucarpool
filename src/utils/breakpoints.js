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

module.exports = {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_SCREEN_NAME,
  DESKTOP_MEDIA_QUERY,
  isMobileWidth,
  MOBILE_NAV_HEIGHT_PX,
  MOBILE_NAV_SPACE,
};
