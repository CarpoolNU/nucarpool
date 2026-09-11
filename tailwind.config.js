const {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_SCREEN_NAME,
  MOBILE_NAV_SPACE,
} = require("./src/utils/breakpoints");

/** @type {import('tailwindcss').Config} */
/**
 * The theme and the screens. **Not the scan surface** - and this file used to
 * look as though it controlled that too.
 *
 * A `content` array restricting the class scan to `src/pages` and
 * `src/components` stood at the top of this object and had no effect
 * whatsoever. Tailwind v4 is reached through the `@import` in
 * `src/styles/globals.css`, which turns on automatic source detection, and that
 * supersedes the legacy key this config carries in through `@config`. It was
 * deleted rather than corrected, because a key that reads as configuration and
 * configures nothing is worse than no key at all: two separate sessions
 * reasoned from it and reached a false conclusion, one of them writing that
 * conclusion into source comments before a build probe caught it.
 *
 * The boundary actually in force is **the whole repository, minus whatever
 * `.gitignore` excludes**, and it is not limited to JavaScript and TypeScript.
 * Established by building with single-use probe utilities rather than inferred
 * from documentation: probes placed in `src/utils`, at the repository root, in
 * `scripts/` and inside a markdown file under `docs/` were every one of them
 * emitted, while one inside the build directory was not.
 *
 * Two consequences, both of which have already cost time:
 *
 *  - **Naming a utility in prose emits that utility.** A code comment, a
 *    markdown document, or this docblock will do it. So "utility X no longer
 *    appears in the compiled CSS" is not a usable acceptance criterion unless
 *    nothing in the repository mentions X - including the sentence explaining
 *    why it was removed. SCRUM-412 wrote that criterion and was defeated by its
 *    own comment.
 *  - **There is no configured restriction to design against.** SCRUM-413 shaped
 *    a helper partly on the strength of the deleted key's promise.
 *
 * Narrowing the scan for real is possible - `@source` in `globals.css` - and is
 * deliberately **not** done here. It is a separate change because deleting an
 * inert key is provably a no-op and narrowing a scan is not: bundled together,
 * a diff of the compiled stylesheets could no longer say which change caused
 * what.
 *
 * The weight it would save was measured rather than left as a guess. Building
 * with detection narrowed to the two directories the deleted key named drops
 * **8 utilities and 601 bytes** from the larger stylesheet before compression -
 * around 0.8% - and none of the 8 is used in any markup. Four come from the
 * comments in this very file, one from a comment in `breakpoints.js`, one from
 * an animation *value* rather than any prose at all, and two are ordinary
 * English words that happen to also be utility names, emitted because those
 * words appear in unrelated comments elsewhere in the repository.
 *
 * So the case for narrowing is not weight. It is that it would make "utility X
 * is gone from the CSS" a checkable claim again, which is the thing this
 * currently costs.
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
      },
      height: {
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
         * Deliberately not a token, which is unchanged reasoning from
         * the banner is still scheduled for removal, and giving a
         * thing about to be deleted its own name in the design system would be
         * work done twice. The two sites are instead cross-referenced, here
         * and there.
         */
        "mobile-row": `calc(100% - 1.5rem - ${MOBILE_NAV_SPACE})`,
        /**
         * The expanded explore sheet. `5.5rem` is the strip of map left visible
         * above it, which is what the previous `calc(100% - 8.5rem)` encoded
         * once its own nav assumption is factored out - 8.5rem was 88px of map
         * plus the 48px the nav was then assumed to be.
         */
        "mobile-sheet": `calc(100% - 5.5rem - ${MOBILE_NAV_SPACE})`,
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
