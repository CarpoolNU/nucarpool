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
 * Split out from the hook so the boundary itself is testable: the hook needs a
 * DOM and this repo has no jsdom environment configured, but the comparison is
 * the part that can be got wrong.
 *
 * Strictly below the breakpoint, matching `min-width` CSS semantics - at exactly
 * `MOBILE_BREAKPOINT_PX` the `desktop:` utilities apply, so this must be false.
 */
const isMobileWidth = (width) => width < MOBILE_BREAKPOINT_PX;

module.exports = {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_SCREEN_NAME,
  isMobileWidth,
};
