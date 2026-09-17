/**
 * `MOBILE_SHEET_MAP_STRIP` is the strip of map left visible above the expanded
 * explore sheet, and it is read by four tokens below.
 *
 * It was a local constant here, hoisted out of the `h-mobile-sheet` token once
 * the sheet gained a second open height. It moved into `breakpoints.js` for
 * SCRUM-459, which needs the same figure as a number in JavaScript: the drag
 * gesture derives the sheet's expanded height from its measured bottom edge
 * less this strip, so the range is known in every detent rather than only after
 * an expanded render. Defining it twice would let the gesture and the CSS drift
 * apart silently, which is the failure this file's other constants already
 * avoid by coming from the same place.
 */
const {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_SCREEN_NAME,
  DESKTOP_TALL_SCREEN_NAME,
  DESKTOP_TALL_MEDIA_QUERY,
  MESSAGE_PANEL_TALL_SCREEN_NAME,
  MESSAGE_PANEL_TALL_MEDIA_QUERY,
  MESSAGE_PANEL_SHORT_SCREEN_NAME,
  MESSAGE_PANEL_SHORT_MEDIA_QUERY,
  MOBILE_NAV_SPACE,
  MOBILE_SHEET_MAP_STRIP,
  HEADER_AVATAR_TRIGGER_SIZE,
  HEADER_NAV_BUTTON_VERTICAL_PADDING,
  CONTENT_ROW_HEIGHT,
} = require("./src/utils/breakpoints");

/**
 * How far the handle's pill sits above the top edge of the sheet it belongs
 * to.
 *
 * This is not a new number: the expanded handle was positioned with
 * `bottom-[calc(100%-6rem)]`, and 6rem is exactly this map strip plus this
 * 0.5rem. Naming it is what lets the half detent's handle be placed by the
 * same rule rather than by a second hand-computed `calc()`.
 */
const MOBILE_SHEET_HANDLE_LIFT = "0.5rem";

/** The expanded sheet's height, which the half detent is half of. */
const MOBILE_SHEET_HEIGHT = `calc(100% - ${MOBILE_SHEET_MAP_STRIP} - ${MOBILE_NAV_SPACE})`;

/**
 * The chrome above the map connect portal's desktop card list, which that
 * list's own height budget has to reserve.
 *
 * Every term is set by an ancestor in `src/components/Map/MapConnectPortal.tsx`,
 * so a change to one of those class strings has to move the matching line here.
 * Listed in the order the boxes nest:
 *
 *   `mt-20` on `anchorClasses`        5rem       80px
 *   `pt-4`  on `anchorClasses`        1rem       16px
 *   `mt-11` on `panelClasses`         2.75rem    44px
 *   `marginTop: -8%` in `listStyle`  -2.08rem   -33.28px
 *
 * **The negative term is the one worth reading twice**, and leaving it out is
 * the arithmetic error SCRUM-483 corrects. A percentage margin resolves against
 * the containing block's *inline* size - the panel's `w-[26rem]` - and never
 * against the viewport height, so it contributes a constant 8% of 26rem at
 * every window height rather than scaling with one. It also collapses with the
 * `mt-11` directly above it, the panel having no border or padding to keep the
 * two apart, which is why they belong in one sum rather than as separate boxes.
 *
 * **Measured, not only declared**, in Chromium against the compiled stylesheet
 * and reproducing the real ancestor chain: the list's top edge lands at
 * 106.73px at viewport heights of 640, 800 and 1200. The 6.67rem below is that
 * figure to within a hundredth of a pixel. The budget this replaced reserved
 * 128px, which capped the list 21.27px *shorter* than the space it had at all
 * three heights - it under-used the viewport rather than overflowing it.
 */
const CONNECT_PORTAL_LIST_CHROME = "calc(5rem + 1rem + 2.75rem - 2.08rem)";

/*
 * **Tailwind v4 scans the whole repository for class names**, minus what
 * `.gitignore` excludes -- not just `src/`, and not just JS and TS. Automatic
 * source detection comes from the `@import` in `src/styles/globals.css` and
 * supersedes any scan configuration here; a `content` array in this file has no
 * effect and was removed.
 *
 * Two things follow, and the second is the one that bites. **Naming a utility
 * in prose emits that utility**, so a comment or document mentioning a class
 * ships it as CSS. And therefore **"class X no longer appears in the output" is
 * never a valid check** -- the sentence explaining X's removal is enough to keep
 * X in the stylesheet. Verify CSS changes by diffing the compiled
 * `.next/static/css/*.css` between builds instead.
 *
 * The `theme` and `screens` keys below are load-bearing. Only the scan
 * boundary was inert.
 *
 * TODO: add theme to follow the branding rules of Northeastern
 * https://brand.northeastern.edu/visual-design/typography/
 */
module.exports = {
  theme: {
    extend: {
      /**
       * Offsets measured against the mobile bottom navigation, all derived from
       * the one constant in `src/utils/breakpoints.js` that `MobileNav` itself
       * takes its height from. Composed here, in JavaScript, rather than left
       * to `calc()` in arbitrary values at each call site: this config reaches
       * Tailwind v4 through `@config`, so its theme values are not guaranteed
       * to be emitted as CSS custom properties, and a `calc()` composed against
       * a variable that does not exist fails silently.
       *
       * The two names encode the two intents the old hard-coded values were
       * conflating. `bottom-12` (48px) was used for the explore sheet, which
       * sits flush against the nav; `bottom-16` (64px) for floating controls,
       * which want clearance above it. Reading either number told you nothing
       * about which was meant.
       */
      spacing: {
        /** Flush with the top edge of the navigation. */
        "mobile-nav": MOBILE_NAV_SPACE,
        /** Clear of the navigation, with a small gap. */
        "above-mobile-nav": `calc(${MOBILE_NAV_SPACE} + 0.5rem)`,
        /**
         * The drag handle's rest position at each of the sheet's two open
         * detents: the sheet's top edge, lifted by the pill's clearance.
         *
         * `bottom` percentages resolve against the containing block's height,
         * and the handle shares the sheet's containing block, so `100%` means
         * the same quantity in both - which is what makes composing these out
         * of the height above correct rather than coincidental.
         *
         * `sheet-handle` is the value the page used to spell
         * `calc(100% - 6rem)` inline. It resolves identically; it is expressed
         * this way so that the two detents cannot drift apart.
         */
        "sheet-handle": `calc(100% - ${MOBILE_SHEET_MAP_STRIP} - ${MOBILE_SHEET_HANDLE_LIFT})`,
        "half-sheet-handle": `calc(${MOBILE_NAV_SPACE} + (${MOBILE_SHEET_HEIGHT}) / 2 - ${MOBILE_SHEET_HANDLE_LIFT})`,
        /**
         * The two caps SCRUM-491 puts on the header bar's own controls, both
         * derived in `breakpoints.js` from the same 8.5% the bar declares.
         *
         * **Tokens rather than arbitrary values at the call site, and here the
         * usual reason is joined by a hard one.** Each value is composed in
         * JavaScript from a constant, and Tailwind emits an arbitrary value
         * only if the finished class name appears literally in the source - so
         * a bracketed padding utility would have to spell the whole nested
         * `max`/`min`/`calc` expression out a second time, in a place nothing
         * checks against the first. The `spacing` block above settles the same
         * question for the same reason.
         *
         * The first draft of this comment made that point by quoting the
         * bracketed class in full, and the selector-set diff caught it
         * emitting that rule into the production bundle - dead CSS matching no
         * element. This file's own docblock is about exactly that, which is
         * the joke: **naming a utility in prose ships it.** Hence the
         * description rather than the example.
         *
         * `spacing` and not `height`/`padding` separately: `header-control` is
         * a square and needs its two axes from one figure, which is what keeps
         * the trigger circular at every viewport.
         */
        "header-control": HEADER_AVATAR_TRIGGER_SIZE,
        "header-nav-y": HEADER_NAV_BUTTON_VERTICAL_PADDING,
      },
      height: {
        /**
         * Every desktop content row: the viewport, less however tall the header
         * bar actually turned out.
         *
         * Four call sites - `index.tsx`, `admin.tsx`, `profile/index.tsx` and
         * `AdminMobileNotice.tsx` - each of which declared the bar's percentage
         * complement directly until SCRUM-496 gave the bar a 44px floor. Once
         * the bar's height is a `max()` the complement stops being a second
         * percentage, so it could not stay a figure typed out four times.
         *
         * A token and not a bracketed utility, which the `spacing` block above
         * argues at length and which is *harder* here: the value is a nested
         * `calc()` around a `max()`, and Tailwind emits a bracketed class only
         * when the finished name appears literally in the source - so each call
         * site would have to spell the whole expression, underscore-escaped,
         * with nothing checking the four copies against `breakpoints.js`. The
         * escaping alone would make a diff unreadable.
         *
         * `breakpoints.js` carries the derivation, including why the bar itself
         * takes the floor as a separate `min-height` rather than folding it
         * into its `height`, and why that distinction is what keeps `/sign-in`
         * out of this.
         */
        "content-row": CONTENT_ROW_HEIGHT,
        /**
         * The explore page's main row on mobile: the viewport, less the
         * navigation, less the fixed banner this row is pushed down by.
         *
         * `1.5rem` is that banner allowance, and it must stay equal to the top
         * margin the row carries in `index.tsx`. It was `1.25rem` until
         * that change's final reconciliation, which is 20px against a banner
         * that measures 24px - so the fixed bar overlapped the first 4px of
         * the row. Both figures come from the built stylesheet rather than from
         * the class names: the banner is a 12px font on a 1/0.75 line height,
         * 16px, plus 4px of padding either side.
         *
         * Deliberately not a token: the banner is still scheduled for removal,
         * and giving a thing about to be deleted its own name in the design
         * system would be work done twice. The two sites are instead
         * cross-referenced, here and there.
         */
        "mobile-row": `calc(100% - 1.5rem - ${MOBILE_NAV_SPACE})`,
        /**
         * The expanded explore sheet. `MOBILE_SHEET_MAP_STRIP` is the strip of
         * map left visible above it, which is what the previous
         * `calc(100% - 8.5rem)` encoded once its own nav assumption is factored
         * out - 8.5rem was 88px of map plus the 48px the nav was then assumed
         * to be.
         */
        "mobile-sheet": MOBILE_SHEET_HEIGHT,
        /**
         * The detent a drag can land on, halfway up.
         *
         * Half of the expanded height rather than half the viewport, so the
         * map strip and the navigation are reserved once and the two open
         * detents stay in proportion on any device. The drag's own arithmetic
         * uses the same fraction, but takes the pixels from measuring this
         * element rather than from re-deriving the `calc()` - see
         * `useSheetDrag`.
         */
        "mobile-sheet-half": `calc((${MOBILE_SHEET_HEIGHT}) / 2)`,
      },
      maxHeight: {
        /**
         * The map connect portal's desktop card list: the viewport, less the
         * chrome above it.
         *
         * `dvh` rather than `vh`, for the reason `src/styles/globals.css`
         * records at length - `vh` on a mobile browser is the height with the
         * browser chrome retracted, so it over-measures wherever that chrome is
         * showing. That applies to this desktop branch despite the name,
         * because the `desktop` screen and `useIsMobile` are both width-only: a
         * phone held in landscape is 667px wide and takes this branch. This was
         * the last applied `vh` in `src`.
         *
         * A token rather than an arbitrary value at the call site, following
         * the `spacing` block above and for the same reason the list of
         * contributors gives: the budget is a sum of four separate offsets, one
         * of them a percentage of a width, and a literal at the call site is a
         * number nobody can check against them.
         */
        "connect-portal-list": `calc(100dvh - (${CONNECT_PORTAL_LIST_CHROME}))`,
      },
      colors: {
        "northeastern-red": "#C8102E",
        "light-red": "#FFE6E6",
        "busy-red": "#FFA9A9",
        "okay-yellow": "#FFCB11",
        "good-green": "#C7EFB3",
      },
      keyframes: {
        gradientShift: {
          "0%": {
            backgroundSize: "100% 100%, 120% 120%",
          },
          "25%": {
            backgroundSize: "110%% 110%%, 110%% 110%",
          },
          "50%": {
            backgroundSize: "120% 120%, 100% 100%",
          },
          "75%": {
            backgroundSize: "110%% 110%, 110% 110%",
          },
          "100%": {
            backgroundSize: "100% 100%, 120% 120%",
          },
        },
      },
      animation: {
        "gradient-shift-15s": "gradientShift 15s ease-in-out infinite",
      },
      fontFamily: {
        montserrat: ["Montserrat", "sans-serif"],
        lato: ["Lato", "sans-serif"],
      },
      // Tailwind v4 collapsed the drop-shadow scale to a single layer, which
      // makes `drop-shadow-lg` and `-xl` noticeably lighter and flatter. These
      // restate v3's two-layer values, so the request cards, the sign-in panel
      // and the select dropdown that use them are unchanged by the upgrade.
      // `drop-shadow` and `drop-shadow-2xl` are identical across the two
      // versions and are deliberately not listed.
      dropShadow: {
        lg: ["0 10px 8px rgb(0 0 0 / 0.04)", "0 4px 3px rgb(0 0 0 / 0.1)"],
        xl: ["0 20px 13px rgb(0 0 0 / 0.03)", "0 8px 5px rgb(0 0 0 / 0.08)"],
      },
      backgroundImage: {
        floaty:
          "radial-gradient(ellipse 100% 80% at -10% 110% , #C8102E, #FFA9A9, transparent)," +
          "radial-gradient(ellipse 70% 100% at 110% -10% , #C8102E, #FFA9A9, white )",
      },
    },
    // NOTE: this overrides Tailwind's default screens rather than extending
    // them, so `sm` here is 576px and not the stock 640px.
    // This key is load-bearing, which is the distinction worth holding onto
    // after reading this file's docblock: the theme and the screens here do
    // reach Tailwind through `@config`. It was only the scan boundary that
    // never did.
    // Keep these ascending. Tailwind emits the media queries in the order they
    // are declared, so a larger screen listed before a smaller one loses the
    // cascade wherever both set the same property. `breakpoints.test.ts` asserts
    // the ordering.
    screens: {
      sm: "576px",
      // => @media (min-width: 576px) { ... }

      // The mobile/desktop boundary the JavaScript uses, shared with
      // `useIsMobile` from one definition so the CSS and the layout logic cannot
      // drift apart. Named for the side it turns on, since screens
      // are min-width: `desktop:` applies at this width and above.
      [DESKTOP_SCREEN_NAME]: `${MOBILE_BREAKPOINT_PX}px`,
      // => @media (min-width: 640px) { ... }

      // The desktop boundary with a *height* term, for layouts whose desktop
      // arrangement needs vertical room rather than only horizontal. A `raw`
      // query because a screen is otherwise min-width only, which is precisely
      // the gap: a landscape phone is 667px wide and 375px tall, so `desktop:`
      // alone hands it a layout that cannot fit (SCRUM-474).
      //
      // Declared immediately after `desktop` and before `md`, which keeps the
      // ascending order this list requires: its width term is the same 640px,
      // and it is strictly narrower in scope, so where both ever set one
      // property this one has to be emitted second to win.
      //
      // One known artifact, and it is inert. Tailwind's `container` utility
      // derives a `max-width` from every screen, and a `raw` screen has no
      // width to derive one from - so the build emits a `.container` rule whose
      // `max-width` is the media query text, which is not a length and which
      // every browser therefore drops. Nothing in the app uses the bare
      // `container` utility; the rule exists at all only because Tailwind v4
      // scans the whole repository and the *word* appears in prose, which is
      // the effect this file's docblock describes.
      // The same shape as `desktop-tall` and a second height, because the
      // height a layout needs is the layout's own: 844px is the onboarding
      // card's figure and means nothing to the conversation panel, whose
      // full-size chrome stops fitting at 489 (SCRUM-489). Reusing
      // `desktop-tall` here would compact the panel on a 1366x768 laptop,
      // which is the mistake `ADMIN_CONSOLE_MIN_HEIGHT_PX` warns about by
      // name.
      //
      // Declared before `desktop-tall` to keep this list ascending: the two
      // share a width term, and 844 implies 489, so where both ever set one
      // property the taller screen has to be emitted second to win.
      [MESSAGE_PANEL_TALL_SCREEN_NAME]: { raw: MESSAGE_PANEL_TALL_MEDIA_QUERY },
      // => @media (min-width: 640px) and (min-height: 489px) { ... }

      // The complement of the screen above, inside the same width band: wide
      // enough for the desktop panel, too short for its full-size chrome. The
      // first screen here that narrows as a viewport grows, and the reason it
      // has to exist is in `MESSAGE_PANEL_SHORT_SCREEN_NAME` - `SendBar`'s
      // vertical padding is unconditional on a tree shared with mobile, so it
      // cannot be moved to the base the way every other value in this chrome
      // was.
      //
      // Position in this list is the one thing that does *not* matter here, and
      // saying so is worth more than picking a defensible spot: this screen and
      // `message-panel-tall` are exact complements, so no viewport can ever
      // match both and neither can take a property from the other. It is
      // declared adjacent to its complement so the pair reads together, and
      // `breakpoints.test.ts` pins the mutual exclusivity rather than the
      // order.
      [MESSAGE_PANEL_SHORT_SCREEN_NAME]: {
        raw: MESSAGE_PANEL_SHORT_MEDIA_QUERY,
      },
      // => @media (min-width: 640px) and (not (min-height: 489px)) { ... }

      [DESKTOP_TALL_SCREEN_NAME]: { raw: DESKTOP_TALL_MEDIA_QUERY },
      // => @media (min-width: 640px) and (min-height: 844px) { ... }

      // ipad 14 size
      md: "834px",
      // => @media (min-width: 834px) { ... }

      lg: "1440px",
      // => @media (min-width: 1440px) { ... }
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("tailwind-scrollbar")({
      nocompatible: true,
      preferredStrategy: "pseudoelements",
    }),
  ],
};
