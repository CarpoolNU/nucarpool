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
 * The share of the viewport the header bar takes, as the percentage
 * `HeaderDiv` declares and as the fraction the arithmetic below needs.
 *
 * Hoisted out of `Header.tsx` for SCRUM-484, which needs the same figure three
 * times: the bar declares it, the logo's font cap is derived from it, and the
 * admin console's height gate is derived from its complement. It was one
 * number in one template before that, and nothing else could read it.
 *
 * **The percentage is the definition and the fraction is derived from it**,
 * rather than the reverse. `0.085 * 100` is `8.500000000000001` in IEEE 754,
 * so composing the CSS string from a fraction would emit a `height` no one
 * wrote; `8.5 / 100` is exactly `0.085`.
 *
 * Worth knowing before reusing these: **the bar is 8.5% of its containing
 * block, which is only the viewport on the pages that give it one.** On `/`,
 * `/profile` and `/admin` the bar's parent is `100dvh`, so 8.5% is 8.5% of the
 * viewport and the content row beside it is the 91.5% remainder. On
 * `/sign-in` the bar sits inside a `w-fit` card in an auto-height flex column
 * (`sign-in.tsx:68`), so the percentage has no definite height to resolve
 * against and falls back to `auto` - measured in Chromium at 667x375, where
 * the bar computes to 111px and takes its height *from* its logo rather than
 * giving one to it. Anything derived from these constants therefore describes
 * the in-page bar and not the sign-in card.
 */
const HEADER_BAR_VIEWPORT_PERCENT = 8.5;

const HEADER_BAR_VIEWPORT_FRACTION = HEADER_BAR_VIEWPORT_PERCENT / 100;

/** The bar's own `height`, which is what `HeaderDiv` declares. */
const HEADER_BAR_HEIGHT = `${HEADER_BAR_VIEWPORT_PERCENT}%`;

/**
 * The share of the viewport left for a page's content row - the 91.5% the
 * desktop rows in `admin.tsx`, `index.tsx` and `profile/index.tsx` each
 * declare.
 *
 * Stated as the complement rather than as a fourth copy of the number, so the
 * bar and the row cannot add up to anything but the viewport.
 */
const CONTENT_ROW_VIEWPORT_FRACTION = 1 - HEADER_BAR_VIEWPORT_FRACTION;

/**
 * The vertical space Chromium reserves for one line of the logo's font, per
 * `1em`.
 *
 * **Measured, not declared**, and the distinction is the same one
 * `WIZARD_NAV_STRIP_SPACE_PX` makes. Read out of
 * `TextMetrics.fontBoundingBoxAscent + fontBoundingBoxDescent` for
 * `700 100px Lato, sans-serif` in Chromium, which came to 115 - and confirmed
 * against the rendered element, whose text box a `Range` measured at 55px for
 * a 48px font. Both the Lato the app loads and the sans-serif it falls back to
 * give 115, so the figure does not depend on whether the webfont has arrived.
 *
 * This is the *font* box and not the glyph ink, which is smaller: the actual
 * inked height of "CarpoolNU" is about 0.94em. Reserving the font box is the
 * conservative choice and the right one, because it is what the browser
 * actually lays out and therefore what decides whether a line overflows its
 * container.
 */
const LOGO_FONT_BOX_RATIO = 1.15;

/**
 * The largest font size the header logo can take and still have its line fit
 * inside the bar.
 *
 * **This is the fix SCRUM-484 exists for, and the shape of the defect is worth
 * stating.** The bar's height is a *percentage* and the logo's was a fixed
 * `111px`, so the two were unrelated: the logo fit only above
 * `111 * 1.15 / 0.085` of viewport height, which is past 1500px and therefore
 * never. Measured at 667x375 the bar is 31.88px around a 111px logo, whose box
 * is clipped 39.56px off the top of the screen and paints the other 39.56px
 * over the content row; at 1440x900 - an ordinary desktop window, not a short
 * one - the bar is 76.5px and the same 111px box still overhangs by 17.25px
 * each way. The visible clipping is landscape-only, but the overflow is not.
 *
 * `100dvh` reconstructs the bar's own basis rather than reading it, and that
 * is a real limitation: a CSS length cannot ask its parent how tall it turned
 * out. It is composed from the same fraction the bar declares, so the two
 * cannot drift; `Header.console.test.tsx`'s sibling
 * `headerLogoFontCap.test.ts` pins the composition. Container query units
 * (`cqh`, against `container-type: size` on the bar) would read the real
 * height and were deliberately not used: sizing containment on the header of
 * every authenticated page is a larger behavioural change than this defect
 * justifies.
 *
 * Used inside `min()` against the design size, so it binds only where the
 * design size does not fit. At 900px tall it computes to 66.5px and 48px wins,
 * which is why desktop is untouched; 48px stops fitting below about 649px of
 * viewport height, and from there down the logo tracks the bar.
 */
const HEADER_LOGO_MAX_FONT_SIZE = `calc(100dvh * ${HEADER_BAR_VIEWPORT_FRACTION} / ${LOGO_FONT_BOX_RATIO})`;

/**
 * The shortest chart the admin console draws, in pixels - the `h-[500px]` on
 * `BarChartDaysFrequency`. The other two chart blocks are `min-h-[600px]`.
 *
 * **This said "declares" until SCRUM-488, and the distinction was a real one
 * rather than a pedantic one.** This is the only one of the three written as a
 * fixed `h-` rather than a `min-h-` floor, and all three are flex items of
 * `AdminData`'s `flex-col` - which always overflows, because its children sum
 * to more than the row at every viewport. `flex-shrink` defaults to 1 and
 * `min-height: auto` does not stop it, so the chart was shrunk to whatever was
 * left: measured at 151.5px at 1440x900 and 24px at 667x582, against a class
 * string that said 500. The `min-h-[600px]` pair resisted, because a minimum
 * is a floor a shrink cannot cross.
 *
 * SCRUM-484 derived the gate from the 500 anyway, on the grounds that a gate
 * is a judgement about the layout as designed and one derived from a defect
 * would have to move when the defect was fixed. SCRUM-488 then added
 * `shrink-0` to that chart, so the figure below is now measured at both
 * viewports rather than merely intended - the derivation did not move, the
 * page came to meet it.
 */
const ADMIN_SHORTEST_CHART_HEIGHT_PX = 500;

/**
 * The vertical space `AdminData`'s `py-4` takes out of the content row: 16px
 * at each end.
 *
 * Named for the space rather than for the utility. It was
 * `ADMIN_DATA_VERTICAL_MARGIN_PX` until SCRUM-488 changed which box the 16px
 * is charged to, and a constant that has to be renamed whenever that changes
 * is naming the wrong thing.
 *
 * The only part of the console's chrome that a scroll cannot reach past.
 * Everything else inside the scroll port - the Download button, the quick
 * stats, the gaps - can be scrolled off, so none of it belongs in a floor.
 *
 * **It was `my-4` when SCRUM-484 wrote this, and the name is the whole of
 * SCRUM-488's second half.** A margin on a `h-full` box inside an
 * `overflow-hidden` parent does not take space out of the row at all - it
 * pushes a full-height port past the row's bottom edge, putting the port's
 * last 16px outside the clip at any scroll position. As padding the 32px is
 * charged to the port's own border box, which is both what this constant
 * always claimed and what the arithmetic below needs: the usable content
 * height at the gate measures 501 against the 500 it solves for.
 */
const ADMIN_DATA_VERTICAL_SPACE_PX = 32;

/**
 * The shortest viewport the admin console is served into, in pixels. Below
 * this, `/admin` renders `AdminMobileNotice` instead.
 *
 * **Derived, and the derivation is a claim about what makes the console
 * unusable rather than merely cramped.** The console scrolls, so no height
 * makes a chart unreachable. What a height does decide is whether any chart
 * can be seen *whole*: the scroll port is the content row less the margin
 * above, and a chart taller than that can never be fully on screen at any
 * scroll position. So the floor is the shortest chart plus that margin, over
 * the row's share of the viewport - below it, not one of the four charts in
 * the console is ever fully visible.
 *
 *   0.915 * H - 32 >= 500   solves to   H >= 581.4
 *
 * **Deliberately not derived from the tallest chart.** `min-h-[600px]` would
 * put the floor at 691px, and the notice is a removal of a capability rather
 * than a cosmetic downgrade - so the cost of setting it too high is that a
 * manager on a 1366x768 laptop, whose browser viewport is around 650px, loses
 * a console that works for them today by scrolling. That is a worse outcome
 * than the cropping this ticket is about.
 *
 * 582 clears both bounds with room: the tallest phone in landscape is 430px
 * (a 932x430 iPhone), and the shortest desktop viewport worth serving is that
 * ~650px laptop. It is not a device figure, it is the layout's - but it was
 * checked against both before being accepted, because a threshold that is
 * derived and also wrong is still wrong.
 *
 * Opt-in at one call site, which is `admin.tsx`. `MOBILE_BREAKPOINT_PX` is
 * untouched: SCRUM-477 records why giving that constant a height term would
 * move all twelve of its survey sites across the line at once, and SCRUM-474
 * is the pattern this follows instead.
 */
const ADMIN_CONSOLE_MIN_HEIGHT_PX = Math.ceil(
  (ADMIN_SHORTEST_CHART_HEIGHT_PX + ADMIN_DATA_VERTICAL_SPACE_PX) /
    CONTENT_ROW_VIEWPORT_FRACTION,
);

/**
 * The name of the screen that means "wide enough for the desktop message panel
 * *and* tall enough to lay its full-size chrome out".
 *
 * A third screen rather than a height term on `MOBILE_BREAKPOINT_PX`, for the
 * reason `DESKTOP_TALL_SCREEN_NAME` gives and SCRUM-477 records: that constant
 * is read by `useIsMobile`, by the `desktop:` screen and by
 * `DESKTOP_MEDIA_QUERY`, so giving it a height would move every page at once.
 * And not `desktop-tall` either - 844px is the onboarding card's figure and
 * means nothing here, so reusing it would hand the compact chrome to a 1366x768
 * laptop as well.
 */
const MESSAGE_PANEL_TALL_SCREEN_NAME = "message-panel-tall";

/**
 * The desktop conversation header's height, in pixels - `p-8` around an
 * `h-20 w-20` avatar, plus its `border-b`.
 *
 * **Measured, not declared**, like `WIZARD_NAV_STRIP_SPACE_PX`: 64 of padding
 * and an 80px avatar predict 144, and Chromium reports 145. The extra pixel is
 * the border, and it is the kind of term that is easier to measure than to
 * remember to add.
 */
const MESSAGE_PANEL_HEADER_PX = 145;

/**
 * The `Message`/`Map` tab strip's height - `py-3` around one line of `text-lg`,
 * plus its own `border-b`. Measured at 53.
 */
const MESSAGE_PANEL_TAB_STRIP_PX = 53;

/**
 * The send bar's height with its composer on one line, in pixels.
 *
 * **Measured at a wide panel, and that qualifier is load-bearing.** The bar is
 * 24px of padding either side of a row whose height is the send button's 46px
 * plus 2px of border - 97 in total - but only while the composer fits that row.
 * The composer is `flex-1`, so its width is the panel's, and a composer
 * narrower than 160.77px wraps the `.placeholder:empty:before` hint in
 * `globals.css` onto a second line: at 667x489, where the row's 40px side
 * margins leave it 78px, the hint takes three lines and the bar measures 131.5.
 *
 * That band is the only place the figure is still width-dependent. Below the
 * threshold the compact chrome drops both the margins and 12px of the padding
 * (SCRUM-494), which leaves the composer 174px at the same 267px panel - one
 * line of hint, and a 73px bar.
 *
 * So this figure describes the panel the full-size chrome was designed for,
 * which is the panel a viewport above the threshold below has - and it is the
 * only chrome that threshold is about. (Named as a length rather than as the
 * utility that sets it, here and in the paragraph above: Tailwind v4 scans this
 * file, so writing either class out would emit it as real CSS with nothing
 * using it - the effect `tailwind.config.js` describes at length, and one a
 * selector-set diff caught here.)
 */
const MESSAGE_PANEL_SEND_BAR_PX = 97;

/**
 * The conversation list's own `p-4`, top and bottom.
 *
 * Declared rather than measured, and it is the whole of the box at a landscape
 * phone today: `message-content` measures 32px tall with `contentHeight` 0.
 */
const MESSAGE_CONTENT_PADDING_PX = 32;

/**
 * The vertical space one message needs to be seen whole, in pixels - the date
 * separator every group carries, plus one message block.
 *
 * **Measured in Chromium at 1440x900**, because none of it is declared
 * anywhere: the separator is `text-md my-2` (24 + 16 of margin = 40), and a
 * block is a `text-xs` timestamp with `mb-1` (20) plus a one-line bubble at
 * `px-4 py-2` (44) plus the block's own `mb-4` (16). 120 together.
 *
 * Width-dependent, like the send bar above, and for a sharper reason: the
 * bubble is capped at half the width of the conversation column, so a narrow
 * panel wraps it rather than widening it. The same 26-character message
 * measures 44px tall at a 1040px panel and **112px** at a 267px one. 120 is
 * therefore the wide-panel figure, which is the right one for a threshold that
 * decides whether the *full-size* chrome still fits.
 */
const MESSAGE_PANEL_DATED_MESSAGE_PX = 120;

/**
 * The shortest viewport the desktop message panel's full-size chrome is served
 * into, in pixels. Below this, the panel takes the compact chrome instead.
 *
 * **Derived, and the derivation is a claim about being able to read a message
 * rather than about the layout looking tidy.** The panel fills the content row,
 * and its header and tab strip come off the top before the conversation and the
 * send bar divide what is left:
 *
 *   0.915 * H - HEADER - TABS - SEND_BAR >= PADDING + DATED_MESSAGE
 *
 * which solves to `H >= 447 / 0.915`, or 489. Below it the newest message
 * cannot be seen whole at any scroll position; below about 395 - SCRUM-485's
 * figure - the conversation has no content height at all and the send bar
 * leaves the screen, which is the defect SCRUM-489 was filed for.
 *
 * Verified at the threshold and at the width it was derived for: at 1440x489
 * the conversation measures exactly 120px of content height against a dated
 * message of exactly 120, so the inequality is tight rather than
 * approximately right. One pixel below, the compact chrome takes over.
 *
 * **Two of the five terms are width-dependent** (see `MESSAGE_PANEL_SEND_BAR_PX`
 * and `MESSAGE_PANEL_DATED_MESSAGE_PX`), so this is the threshold for a panel
 * wide enough to hold a one-line composer and an unwrapped bubble, and a
 * narrow desktop window crosses the same line higher. Measured at 667x489,
 * where the send bar is 131.5 rather than 97 because the row's side margins
 * are restored alongside it: the conversation gets 86px, not the 120 the
 * inequality
 * promises. Nothing overflows and the send bar stays on screen, so that band
 * is cramped rather than broken - and the alternative, stacking each term's
 * worst case, walks the threshold up past a real laptop, which costs a desktop
 * user their layout to buy a landscape phone nothing it can measure.
 *
 * Checked against both bounds before being accepted, because a derived figure
 * can still be the wrong one:
 *
 *  - every phone in landscape is below it - 375, 390 and 430 for the three
 *    iPhones `breakpoints.test.ts` names - so all of them get the compact
 *    chrome, which is the band SCRUM-485 measured the defect in;
 *  - every desktop viewport worth serving is above it, including the ~650px a
 *    1366x768 laptop leaves and the ~695px an iPad in landscape leaves. So the
 *    full-size chrome is what desktop keeps rendering.
 *
 * Opt-in at its own call sites, which are `MessageHeader`, `SendBar` and
 * `MessageContent`; SCRUM-474 is the pattern this follows.
 */
const MESSAGE_PANEL_MIN_HEIGHT_PX = Math.ceil(
  (MESSAGE_PANEL_HEADER_PX +
    MESSAGE_PANEL_TAB_STRIP_PX +
    MESSAGE_PANEL_SEND_BAR_PX +
    MESSAGE_CONTENT_PADDING_PX +
    MESSAGE_PANEL_DATED_MESSAGE_PX) /
    CONTENT_ROW_VIEWPORT_FRACTION,
);

/**
 * The same pair of conditions as a media query, which is what
 * `tailwind.config.js` registers as a screen.
 *
 * Both terms `min-`, matching the other two queries in this file. That
 * direction is what keeps the compact chrome out of the mobile tree: the
 * conversation's insets are declared compact as the base and restored inside
 * here, and the base is also what a phone in portrait gets - so `SendBar` and
 * `MessageContent`, which are one tree on both platforms, can only be reached
 * by this screen where they are already above the width breakpoint.
 */
const MESSAGE_PANEL_TALL_MEDIA_QUERY =
  `(min-width: ${MOBILE_BREAKPOINT_PX}px) and ` +
  `(min-height: ${MESSAGE_PANEL_MIN_HEIGHT_PX}px)`;

/**
 * The name of the screen that means "wide enough for the desktop message panel
 * but too *short* for its full-size chrome" - the complement of
 * `message-panel-tall` inside the same width band.
 *
 * **The first `max-`-shaped screen in this repository, and a deliberate
 * precedent rather than a convenience (SCRUM-494).** Every other screen here is
 * mobile-first: a compact base, restored inside a `min-` query. That direction
 * works whenever the compact value can also be the base, which is what
 * `MESSAGE_PANEL_TALL_MEDIA_QUERY` describes above - and it is exactly what
 * `SendBar`'s vertical padding cannot do. The padding is declared
 * unconditionally on a tree shared with the mobile branch, so reducing the base
 * to reach a landscape phone would reduce it on a phone in portrait too, where
 * the vertical budget is not tight and where most of the traffic is. A screen
 * that can say "short" is the only way to reach one without the other.
 *
 * So the two screens are not alternatives: `message-panel-tall` restores what a
 * compact base gave away, and this one takes away what an unconditional base
 * insists on. Reach for this one only when the value cannot move to the base,
 * because it is the direction that does not compose.
 */
const MESSAGE_PANEL_SHORT_SCREEN_NAME = "message-panel-short";

/**
 * The same band as a media query: at or above the width breakpoint, below the
 * height the full-size chrome needs.
 *
 * **`not (min-height:)` rather than `max-height:`, and the boundary is the
 * whole reason.** A `max-height: 488px` term leaves every viewport taller than
 * 488 and shorter than 489 matching *neither* screen, and fractional viewport
 * heights are routine rather than hypothetical - a browser zoom or a fractional
 * device pixel ratio produces them. The usual answer is a fractional bound,
 * `max-height: 488.98px`, which narrows the gap without closing it (488.99
 * still matches neither) and writes a magic number next to the constant it was
 * derived from. Negating the tall screen's own term closes it exactly: every
 * viewport is on one side or the other by construction, and the two screens
 * cannot drift apart because there is one figure between them rather than two.
 *
 * Valid Media Queries Level 4, and inside Tailwind v4's browser baseline -
 * Safari 16.4+, Chrome 111+ and Firefox 128+ all support `not` in a media
 * condition. **Measured rather than assumed**, because a media query a browser
 * fails to parse is dropped silently and would present as the padding simply
 * not changing: SCRUM-494 confirmed in Chromium that the query survives
 * `matchMedia` verbatim rather than collapsing to `not all`, that it matches at
 * 667x375 while the tall screen does not, and that the layout it gates really
 * does change at 488 and not at 489.
 *
 * The width term stays `min-`, and that is what keeps this screen out of the
 * mobile tree: a phone in portrait is 375px wide, so it cannot match this
 * screen however short it is.
 */
const MESSAGE_PANEL_SHORT_MEDIA_QUERY =
  `(min-width: ${MOBILE_BREAKPOINT_PX}px) and ` +
  `(not (min-height: ${MESSAGE_PANEL_MIN_HEIGHT_PX}px))`;

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
  HEADER_BAR_VIEWPORT_PERCENT,
  HEADER_BAR_VIEWPORT_FRACTION,
  HEADER_BAR_HEIGHT,
  CONTENT_ROW_VIEWPORT_FRACTION,
  LOGO_FONT_BOX_RATIO,
  HEADER_LOGO_MAX_FONT_SIZE,
  ADMIN_SHORTEST_CHART_HEIGHT_PX,
  ADMIN_DATA_VERTICAL_SPACE_PX,
  ADMIN_CONSOLE_MIN_HEIGHT_PX,
  MESSAGE_PANEL_TALL_SCREEN_NAME,
  MESSAGE_PANEL_TALL_MEDIA_QUERY,
  MESSAGE_PANEL_SHORT_SCREEN_NAME,
  MESSAGE_PANEL_SHORT_MEDIA_QUERY,
  MESSAGE_PANEL_HEADER_PX,
  MESSAGE_PANEL_TAB_STRIP_PX,
  MESSAGE_PANEL_SEND_BAR_PX,
  MESSAGE_CONTENT_PADDING_PX,
  MESSAGE_PANEL_DATED_MESSAGE_PX,
  MESSAGE_PANEL_MIN_HEIGHT_PX,
  isMobileWidth,
  MOBILE_NAV_HEIGHT_PX,
  MOBILE_NAV_SPACE,
  MOBILE_SHEET_MAP_STRIP_REM,
  MOBILE_SHEET_MAP_STRIP,
};
