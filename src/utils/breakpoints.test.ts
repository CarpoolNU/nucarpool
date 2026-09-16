import {
  DESKTOP_MEDIA_QUERY,
  DESKTOP_SCREEN_NAME,
  DESKTOP_TALL_MEDIA_QUERY,
  DESKTOP_TALL_SCREEN_NAME,
  WIZARD_CARD_HEIGHT_PX,
  WIZARD_DESKTOP_MIN_HEIGHT_PX,
  WIZARD_NAV_STRIP_SPACE_PX,
  HEADER_BAR_VIEWPORT_PERCENT,
  HEADER_BAR_VIEWPORT_FRACTION,
  HEADER_BAR_HEIGHT,
  CONTENT_ROW_VIEWPORT_FRACTION,
  LOGO_FONT_BOX_RATIO,
  HEADER_LOGO_MAX_FONT_SIZE,
  ADMIN_SHORTEST_CHART_HEIGHT_PX,
  ADMIN_DATA_VERTICAL_MARGIN_PX,
  ADMIN_CONSOLE_MIN_HEIGHT_PX,
  MESSAGE_PANEL_TALL_SCREEN_NAME,
  MESSAGE_PANEL_TALL_MEDIA_QUERY,
  MESSAGE_PANEL_HEADER_PX,
  MESSAGE_PANEL_TAB_STRIP_PX,
  MESSAGE_PANEL_SEND_BAR_PX,
  MESSAGE_CONTENT_PADDING_PX,
  MESSAGE_PANEL_DATED_MESSAGE_PX,
  MESSAGE_PANEL_MIN_HEIGHT_PX,
  MOBILE_BREAKPOINT_PX,
  MOBILE_NAV_HEIGHT_PX,
  MOBILE_NAV_SPACE,
  MOBILE_SHEET_MAP_STRIP,
  MOBILE_SHEET_MAP_STRIP_REM,
  isMobileWidth,
} from "./breakpoints";

// Required rather than imported: the Tailwind config is CommonJS, and requiring
// it here is what makes this a real drift guard rather than a restated constant.
const tailwindConfig = require("../../tailwind.config.js");

/**
 * A screen is either a plain `min-width` string or a `raw` media query. Only
 * `desktop-tall` is the latter, because a screen cannot otherwise express a
 * height term - see `DESKTOP_TALL_MEDIA_QUERY`.
 */
type Screen = string | { raw: string };

const screens: Record<string, Screen> = tailwindConfig.theme.screens;

/** The screens that are a width, which is all of them bar `desktop-tall`. */
const widthScreens = Object.entries(screens).filter(
  (entry): entry is [string, string] => typeof entry[1] === "string",
);
const spacing: Record<string, string> = tailwindConfig.theme.extend.spacing;
const height: Record<string, string> = tailwindConfig.theme.extend.height;

/**
 * The app used to decide "is mobile" twice, at 640 in `useIsMobile`
 * and at 768 inside `Header`, so every viewport between them got the desktop
 * layout and the mobile bottom navigation at once. These tests guard the two
 * things that would bring that back: the constant drifting from the Tailwind
 * screen, and the boundary comparison being written the wrong way round.
 */

describe("the shared mobile breakpoint", () => {
  it("is a whole number of pixels", () => {
    expect(Number.isInteger(MOBILE_BREAKPOINT_PX)).toBe(true);
    expect(MOBILE_BREAKPOINT_PX).toBeGreaterThan(0);
  });

  it("is registered in the Tailwind config, so the CSS and the JS agree", () => {
    expect(screens[DESKTOP_SCREEN_NAME]).toBe(`${MOBILE_BREAKPOINT_PX}px`);
  });

  it("does not shadow an existing screen", () => {
    const others = Object.keys(screens).filter(
      (name) => name !== DESKTOP_SCREEN_NAME,
    );
    expect(others).not.toContain(DESKTOP_SCREEN_NAME);
    expect(others.map((name) => screens[name])).not.toContain(
      `${MOBILE_BREAKPOINT_PX}px`,
    );
  });

  /**
   * `desktop-tall` reuses the breakpoint's width and adds a height, so a
   * reader could reasonably expect it to be a second definition of "desktop".
   * It is not: it has to *compose* the same constant, or the two would answer
   * differently about where mobile ends.
   */
  it("builds the tall desktop screen from the same width constant", () => {
    expect(screens[DESKTOP_TALL_SCREEN_NAME]).toEqual({
      raw: DESKTOP_TALL_MEDIA_QUERY,
    });
    expect(DESKTOP_TALL_MEDIA_QUERY).toContain(
      `(min-width: ${MOBILE_BREAKPOINT_PX}px)`,
    );
    expect(DESKTOP_TALL_MEDIA_QUERY).toContain(
      `(min-height: ${WIZARD_DESKTOP_MIN_HEIGHT_PX}px)`,
    );
  });

  /**
   * Both terms `min-`, for the reason `DESKTOP_MEDIA_QUERY` spells out: the
   * mobile-first arrangement is the base and this overrides it. A `max-` term
   * here would mean the inversion had been undone, and would need a fractional
   * pixel to avoid claiming the boundary itself for the wrong side.
   */
  it("states the tall desktop screen as two min- terms", () => {
    expect(DESKTOP_TALL_MEDIA_QUERY).not.toContain("max-width");
    expect(DESKTOP_TALL_MEDIA_QUERY).not.toContain("max-height");
  });

  /**
   * Declaration order again, and it matters more here than elsewhere: this
   * screen's width term is *equal* to `desktop`'s, so the two overlap
   * completely above the height. Emitted first it would lose the cascade to
   * `desktop:` wherever both set one property, which is silent.
   */
  it("declares the tall desktop screen after the plain one", () => {
    const names = Object.keys(screens);
    expect(names.indexOf(DESKTOP_TALL_SCREEN_NAME)).toBeGreaterThan(
      names.indexOf(DESKTOP_SCREEN_NAME),
    );
  });

  /**
   * Tailwind emits media queries in declaration order, so a larger screen
   * declared before a smaller one silently loses the cascade wherever the two
   * set the same property. Easy to reintroduce when adding a screen.
   */
  it("declares screens in ascending order", () => {
    // Only the width-valued screens can be ordered by width. `desktop-tall` is
    // a `raw` query and is checked for its own position separately, below.
    const widths = widthScreens.map(([, value]) => Number.parseInt(value, 10));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(widths.every((width) => Number.isFinite(width))).toBe(true);
  });

  /**
   * Pinned because it is the trap that made this bug hard to see: 640 and 768
   * are Tailwind's *default* `sm` and `md`, but this config replaces the default
   * screens rather than extending them. Anyone reading `window.innerWidth < 640`
   * and assuming it lines up with `sm:` would be wrong.
   */
  it("documents that Tailwind's default screens are overridden", () => {
    expect(screens.sm).toBe("576px");
    expect(screens.md).toBe("834px");
    expect(screens.sm).not.toBe("640px");
    expect(screens.md).not.toBe("768px");
  });
});

/**
 * The boundary as CSS sees it, for the templates that cannot reach a `desktop:`
 * utility.
 *
 * This is the half of the original defect the constant did not reach.
 * `useIsMobile` and the Tailwind screen were unified on 640, but `Header` kept
 * three hand-written `@media (max-width: 768px)` blocks, so between 640 and 768
 * the desktop header rendered with the padding and logo size written for a
 * phone. These tests guard the two ways that comes back: the query drifting
 * from the constant, and the query being written in the direction that
 * disagrees with `isMobileWidth` at the boundary itself.
 */
describe("the shared breakpoint as a media query", () => {
  it("is built from the constant rather than restating it", () => {
    expect(DESKTOP_MEDIA_QUERY).toContain(`${MOBILE_BREAKPOINT_PX}px`);
  });

  /**
   * The direction is the whole point. `isMobileWidth` is strictly below the
   * breakpoint, so at exactly 640 the desktop styling has to apply - which a
   * `min-width: 640px` query gives for free and a `max-width: 640px` query gets
   * wrong by one pixel. A template therefore states its mobile values as the
   * base and overrides them inside this query; a `max-width` here would mean
   * the inversion had been undone.
   */
  it("turns on at the breakpoint, not below it", () => {
    expect(DESKTOP_MEDIA_QUERY).toBe(`(min-width: ${MOBILE_BREAKPOINT_PX}px)`);
    expect(DESKTOP_MEDIA_QUERY).not.toContain("max-width");
  });

  /**
   * The same query Tailwind emits for `desktop:`, so a styled-components
   * template and a utility class change at the same width. Written against the
   * screen rather than the constant because it is the *emitted CSS* that has to
   * match, and the screen is what Tailwind emits from.
   */
  it("is the query the desktop screen emits", () => {
    expect(DESKTOP_MEDIA_QUERY).toBe(
      `(min-width: ${screens[DESKTOP_SCREEN_NAME]})`,
    );
  });

  /**
   * Interpolated straight after `@media`, so it has to carry its own
   * parentheses. Without them the rule is invalid and styled-components drops
   * the whole block silently - the failure mode is missing styling, not an
   * error.
   */
  it("is usable as written directly after @media", () => {
    expect(DESKTOP_MEDIA_QUERY).toMatch(/^\(.+\)$/);
  });
});

describe("isMobileWidth", () => {
  it("is false exactly at the breakpoint, where the desktop utilities start", () => {
    expect(isMobileWidth(MOBILE_BREAKPOINT_PX)).toBe(false);
  });

  it("is true one pixel below it", () => {
    expect(isMobileWidth(MOBILE_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("covers the band that used to render a mixed layout", () => {
    // 640-768 was the broken range: desktop layout, mobile navigation. All of
    // it must now resolve to desktop, and one call decides that for every
    // consumer.
    for (const width of [640, 641, 700, 767, 768, 769]) {
      expect(isMobileWidth(width)).toBe(false);
    }
  });

  it("still treats phone widths as mobile", () => {
    for (const width of [320, 375, 390, 414, 430, 576, 639]) {
      expect(isMobileWidth(width)).toBe(true);
    }
  });
});

/**
 * The mobile navigation's height.
 *
 * The defect these guard is the same one the breakpoint had, in a second
 * quantity: `MobileNav` declared no height, so the bar measured whatever its
 * children summed to, and three files each hard-coded a different guess at it -
 * 48px for the explore sheet, 64px for the profile content, 64px for floating
 * controls, against a bar that rendered at about 59px. Nothing connected any of
 * them, so all four could be edited independently and none would fail.
 *
 * These tests hold the connection rather than the values. What matters is that
 * the Tailwind offsets are *derived from* `MOBILE_NAV_HEIGHT_PX` - a test that
 * restated `60px` would pass with the derivation removed, which is exactly the
 * failure mode being guarded against.
 */
describe("the shared mobile navigation height", () => {
  it("is a whole number of pixels", () => {
    expect(Number.isInteger(MOBILE_NAV_HEIGHT_PX)).toBe(true);
    expect(MOBILE_NAV_HEIGHT_PX).toBeGreaterThan(0);
  });

  it("reserves the home-indicator inset on top of the bar itself", () => {
    expect(MOBILE_NAV_SPACE).toContain(`${MOBILE_NAV_HEIGHT_PX}px`);
    expect(MOBILE_NAV_SPACE).toContain("env(safe-area-inset-bottom");
  });

  /**
   * `env()` with no fallback resolves to nothing where the variable is unknown,
   * which invalidates the whole `calc()` and drops the declaration - so the
   * offset would collapse to zero rather than merely losing the inset. The
   * fallback is the difference between degrading and breaking.
   */
  it("gives env() a fallback, so an unknown inset costs the inset and not the offset", () => {
    expect(MOBILE_NAV_SPACE).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("is what the Tailwind offsets are built from", () => {
    expect(spacing["mobile-nav"]).toBe(MOBILE_NAV_SPACE);
    expect(spacing["above-mobile-nav"]).toContain(MOBILE_NAV_SPACE);
    expect(height["mobile-row"]).toContain(MOBILE_NAV_SPACE);
    expect(height["mobile-sheet"]).toContain(MOBILE_NAV_SPACE);
  });

  /**
   * The two offsets encode the two intents the old hard-coded numbers
   * conflated: flush against the bar, versus clear of it. Reading `48` or `64`
   * told you nothing about which was meant, and the difference between them was
   * not deliberate.
   */
  it("distinguishes flush-with the bar from clear-of it", () => {
    expect(spacing["above-mobile-nav"]).not.toBe(spacing["mobile-nav"]);
    expect(spacing["above-mobile-nav"]).toMatch(/\+\s*0\.5rem/);
  });

  /**
   * Every one of these is a `calc()` over a percentage and an `env()`, so a
   * stray `px` suffix or a missing operator produces CSS that is silently
   * dropped rather than CSS that fails loudly. Balanced parentheses is the
   * cheapest check that catches the common way of getting that wrong.
   */
  it("emits balanced calc() expressions", () => {
    for (const value of [
      spacing["mobile-nav"],
      spacing["above-mobile-nav"],
      height["mobile-row"],
      height["mobile-sheet"],
    ]) {
      expect(value).toBeDefined();
      const opens = (value!.match(/\(/g) ?? []).length;
      const closes = (value!.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

/**
 * The strip of map left visible above the expanded explore sheet.
 *
 * The third quantity to move into this file, and for a new reason: the drag
 * gesture needs it as a *number*. `useSheetDrag` derives the sheet's expanded
 * height as its measured bottom edge less this strip, which is what lets a
 * drag start from a collapsed sheet instead of only after an expanded render
 * (SCRUM-459). A figure defined twice - once as CSS here and once as
 * arithmetic there - would let the gesture and the layout drift apart with
 * nothing failing, which is the same defect the navigation height had.
 */
describe("the shared explore-sheet map strip", () => {
  it("is a positive number of rem", () => {
    expect(Number.isFinite(MOBILE_SHEET_MAP_STRIP_REM)).toBe(true);
    expect(MOBILE_SHEET_MAP_STRIP_REM).toBeGreaterThan(0);
  });

  /**
   * The rem figure is the definition and the CSS length is derived from it.
   * The other direction - parsing `"5.5rem"` at the point of use - is the one
   * that yields `NaN` the day someone writes the value in another unit, and a
   * `NaN` range makes every comparison in `snapToDetent` false rather than
   * throwing.
   */
  it("derives its CSS length from the number, in rem", () => {
    expect(MOBILE_SHEET_MAP_STRIP).toBe(`${MOBILE_SHEET_MAP_STRIP_REM}rem`);
    expect(parseFloat(MOBILE_SHEET_MAP_STRIP)).toBe(MOBILE_SHEET_MAP_STRIP_REM);
  });

  it("is what the sheet's own Tailwind tokens are built from", () => {
    // `h-mobile-sheet` is the height the drag treats as the top of its range,
    // and `sheet-handle` is where the pill rests against it. Both have to
    // reserve the same strip or the handle floats off the sheet's edge.
    expect(height["mobile-sheet"]).toContain(MOBILE_SHEET_MAP_STRIP);
    expect(height["mobile-sheet-half"]).toContain(MOBILE_SHEET_MAP_STRIP);
    expect(spacing["sheet-handle"]).toContain(MOBILE_SHEET_MAP_STRIP);
    expect(spacing["half-sheet-handle"]).toContain(MOBILE_SHEET_MAP_STRIP);
  });

  /**
   * The substitution the gesture relies on: `expanded = bottom - MAP_STRIP`
   * holds only because the sheet's height token subtracts the strip *and* the
   * navigation from a viewport percentage, while its bottom offset is that
   * same navigation space. If the height ever stopped being a percentage of
   * the viewport, the drag's range would be measuring against the wrong box.
   */
  it("subtracts the strip from a viewport percentage, which is what the drag assumes", () => {
    expect(height["mobile-sheet"]).toContain("100%");
    expect(height["mobile-sheet"]).toContain(MOBILE_NAV_SPACE);
    expect(spacing["mobile-nav"]).toBe(MOBILE_NAV_SPACE);
  });
});

/**
 * The height the onboarding wizard's desktop arrangement needs.
 *
 * The defect (SCRUM-474) was that it needed one at all and nothing said so:
 * `desktop:` is a `min-width`, so a phone in landscape - 667px wide, 375px tall
 * - took the desktop branch and got a 500px card centred in a 375px viewport,
 * clipped at both ends with the navigation strip across what was left.
 *
 * These guard the derivation rather than the number. A test that restated `844`
 * would still pass on the day someone changes the card's height, which is
 * precisely the day the threshold stops being true.
 */
describe("the onboarding wizard's minimum desktop height", () => {
  it("is composed from the card and the strip, not written down", () => {
    expect(WIZARD_DESKTOP_MIN_HEIGHT_PX).toBe(
      WIZARD_CARD_HEIGHT_PX + 2 * WIZARD_NAV_STRIP_SPACE_PX,
    );
  });

  /**
   * The doubling is the part that is easy to get wrong, and it is not a safety
   * margin. The card is *centred*, so the space the strip occupies at the
   * bottom has an unusable mirror image at the top: every pixel the strip takes
   * costs the card two.
   */
  it("doubles the strip's share, because the card is centred", () => {
    const wrong = WIZARD_CARD_HEIGHT_PX + WIZARD_NAV_STRIP_SPACE_PX;
    expect(WIZARD_DESKTOP_MIN_HEIGHT_PX).toBeGreaterThan(wrong);
    expect(WIZARD_DESKTOP_MIN_HEIGHT_PX - wrong).toBe(
      WIZARD_NAV_STRIP_SPACE_PX,
    );
  });

  it("is a whole number of pixels taller than the card it has to fit", () => {
    expect(Number.isInteger(WIZARD_DESKTOP_MIN_HEIGHT_PX)).toBe(true);
    expect(WIZARD_DESKTOP_MIN_HEIGHT_PX).toBeGreaterThan(WIZARD_CARD_HEIGHT_PX);
  });

  /**
   * At the threshold the two exactly touch, which is what makes it the
   * threshold. Restating the inequality the constant was solved from is the
   * cheapest way to catch a sign or a factor going astray in the composition
   * above.
   */
  it("is the height at which the card's bottom edge meets the strip's top", () => {
    const cardBottom =
      (WIZARD_DESKTOP_MIN_HEIGHT_PX + WIZARD_CARD_HEIGHT_PX) / 2;
    const stripTop = WIZARD_DESKTOP_MIN_HEIGHT_PX - WIZARD_NAV_STRIP_SPACE_PX;
    expect(cardBottom).toBe(stripTop);
  });

  /**
   * One pixel either side of it, to pin the direction: shorter overlaps, taller
   * clears. The measured numbers behind these are in the constant's docblock -
   * 22px of overlap at 800, 28px of clearance at 900.
   */
  it("overlaps below the threshold and clears above it", () => {
    const overlapAt = (viewport: number) =>
      (viewport + WIZARD_CARD_HEIGHT_PX) / 2 -
      (viewport - WIZARD_NAV_STRIP_SPACE_PX);

    expect(overlapAt(WIZARD_DESKTOP_MIN_HEIGHT_PX - 2)).toBeGreaterThan(0);
    expect(overlapAt(WIZARD_DESKTOP_MIN_HEIGHT_PX)).toBe(0);
    expect(overlapAt(WIZARD_DESKTOP_MIN_HEIGHT_PX + 2)).toBeLessThan(0);
  });

  /**
   * A landscape phone is the case the ticket was filed for, and it has to land
   * below the threshold on height while still being above it on width - that
   * combination is the whole defect.
   */
  it("excludes a phone held in landscape, which is above the width breakpoint", () => {
    for (const [width, height] of [
      [667, 375], // iPhone SE2 / 8
      [844, 390], // iPhone 12/13/14
      [932, 430], // iPhone 14 Pro Max
    ]) {
      expect(isMobileWidth(width)).toBe(false);
      expect(height).toBeLessThan(WIZARD_DESKTOP_MIN_HEIGHT_PX);
    }
  });
});

/**
 * The header bar's share of the viewport, and the two things SCRUM-484 derived
 * from it.
 *
 * The bar declares a percentage and its logo declared a fixed `111px`, so the
 * two were unrelated numbers and the child overflowed the parent at every
 * realistic viewport - measured at 31.88px of bar around a 111px logo at
 * 667x375, and still 76.5px around 111px at 1440x900. These pin the
 * composition that replaced it. The resulting *geometry* is a browser question
 * and lives on the `header-logo-bar` fixture.
 */
describe("the header bar's share of the viewport", () => {
  it("states the percentage and derives the fraction from it, not the reverse", () => {
    /*
     * `0.085 * 100` is `8.500000000000001` in IEEE 754, so composing the CSS
     * string from a fraction would emit a `height` nobody wrote. This is that
     * ordering, asserted - the string has to be exact, because it is what
     * reaches the browser.
     */
    expect(HEADER_BAR_HEIGHT).toBe("8.5%");
    expect(HEADER_BAR_VIEWPORT_FRACTION).toBe(0.085);
    expect(`${HEADER_BAR_VIEWPORT_PERCENT}%`).toBe(HEADER_BAR_HEIGHT);
  });

  it("leaves the content row exactly the remainder", () => {
    /* 91.5%, the figure `admin.tsx`, `index.tsx` and `profile/index.tsx` each
       declare. Stated as the complement so the bar and the row cannot add up
       to anything but the viewport. */
    expect(CONTENT_ROW_VIEWPORT_FRACTION).toBe(0.915);
    expect(HEADER_BAR_VIEWPORT_FRACTION + CONTENT_ROW_VIEWPORT_FRACTION).toBe(
      1,
    );
  });

  it("caps the logo's font against the bar, composed from that same fraction", () => {
    expect(HEADER_LOGO_MAX_FONT_SIZE).toBe("calc(100dvh * 0.085 / 1.15)");
    expect(HEADER_LOGO_MAX_FONT_SIZE).toContain(
      `${HEADER_BAR_VIEWPORT_FRACTION}`,
    );
    expect(HEADER_LOGO_MAX_FONT_SIZE).toContain(`${LOGO_FONT_BOX_RATIO}`);
  });

  /**
   * The arithmetic behind the cap, checked at the heights it was measured at.
   *
   * The cap is the bar's height over `LOGO_FONT_BOX_RATIO`, so the design size
   * survives wherever its line box fits the bar. Both figures below came back
   * from Chromium: 48px at 900 tall and at 650 tall, 27.7174px at 375.
   */
  it("keeps the desktop design size wherever the bar can hold its line", () => {
    const capAt = (viewportHeight: number) =>
      (viewportHeight * HEADER_BAR_VIEWPORT_FRACTION) / LOGO_FONT_BOX_RATIO;

    // Measured: font-size came back as 48px at both of these.
    expect(capAt(900)).toBeGreaterThan(48);
    expect(capAt(650)).toBeGreaterThan(48);

    // Measured: 27.7174px, against a bar of 31.875px.
    expect(capAt(375)).toBeCloseTo(27.7174, 3);
    expect(capAt(375) * LOGO_FONT_BOX_RATIO).toBeCloseTo(
      375 * HEADER_BAR_VIEWPORT_FRACTION,
      6,
    );
  });

  /**
   * The boundary, which is where the cap takes over from the design size.
   *
   * Worth an assertion rather than a comment because it is the answer to "does
   * this change my laptop": everything above it renders what it rendered
   * before.
   */
  it("starts binding below about 650px of viewport height", () => {
    const heightWhereDesignSizeJustFits =
      (48 * LOGO_FONT_BOX_RATIO) / HEADER_BAR_VIEWPORT_FRACTION;

    expect(heightWhereDesignSizeJustFits).toBeCloseTo(649.4, 1);

    /* So a 1366x768 laptop, which leaves about 650px of viewport, is on the
       unchanged side of it - and a landscape phone is not. */
    expect(heightWhereDesignSizeJustFits).toBeLessThan(650);
    expect(heightWhereDesignSizeJustFits).toBeGreaterThan(430);
  });
});

/**
 * The admin console's height gate.
 *
 * SCRUM-484's other half: `showMobileNotice` was width-only, so a landscape
 * phone was served the console into a 343px row. The threshold is the
 * console's own, read at that one call site, and `MOBILE_BREAKPOINT_PX` is
 * untouched - SCRUM-477 records why a height term on that constant would move
 * all twelve of its survey sites at once.
 */
describe("the admin console's minimum height", () => {
  it("is composed from the console's own numbers, not chosen", () => {
    expect(ADMIN_CONSOLE_MIN_HEIGHT_PX).toBe(
      Math.ceil(
        (ADMIN_SHORTEST_CHART_HEIGHT_PX + ADMIN_DATA_VERTICAL_MARGIN_PX) /
          CONTENT_ROW_VIEWPORT_FRACTION,
      ),
    );
  });

  it("is the height at which the shortest chart first fits the scroll window", () => {
    /*
     * The claim the threshold makes, restated as the inequality it solves. At
     * the threshold the row less the margin is at least the chart; one pixel
     * below, it is not. That one-pixel check is what makes this a boundary
     * rather than a plausible number.
     */
    const windowAt = (viewportHeight: number) =>
      viewportHeight * CONTENT_ROW_VIEWPORT_FRACTION -
      ADMIN_DATA_VERTICAL_MARGIN_PX;

    expect(windowAt(ADMIN_CONSOLE_MIN_HEIGHT_PX)).toBeGreaterThanOrEqual(
      ADMIN_SHORTEST_CHART_HEIGHT_PX,
    );
    expect(windowAt(ADMIN_CONSOLE_MIN_HEIGHT_PX - 1)).toBeLessThan(
      ADMIN_SHORTEST_CHART_HEIGHT_PX,
    );
  });

  it("is a whole number of pixels", () => {
    // Compared against `window.innerHeight`, which is an integer.
    expect(Number.isInteger(ADMIN_CONSOLE_MIN_HEIGHT_PX)).toBe(true);
  });

  /**
   * The two bounds the figure was accepted against, because the arithmetic
   * alone cannot say whether the answer is usable. The notice removes a
   * capability, so a threshold set too high costs a real user their console.
   */
  it("excludes every phone in landscape while keeping every desktop window", () => {
    for (const [width, height] of [
      [667, 375], // iPhone SE2 / 8
      [844, 390], // iPhone 12/13/14
      [932, 430], // iPhone 14 Pro Max
    ]) {
      // Above the width breakpoint and below the height gate: the defect.
      expect(isMobileWidth(width)).toBe(false);
      expect(height).toBeLessThan(ADMIN_CONSOLE_MIN_HEIGHT_PX);
    }

    /* And the side that must not regress. ~650 is a 1366x768 laptop after
       browser chrome, ~695 an iPad in landscape in Safari. */
    for (const height of [650, 695, 800, 900]) {
      expect(height).toBeGreaterThan(ADMIN_CONSOLE_MIN_HEIGHT_PX);
    }
  });

  /**
   * Not the wizard's, and this is the assertion that would have caught the
   * mistake SCRUM-484's ticket warns about by name: copying 844px to a place
   * it means nothing.
   */
  it("is its own figure, not the onboarding wizard's", () => {
    expect(ADMIN_CONSOLE_MIN_HEIGHT_PX).not.toBe(WIZARD_DESKTOP_MIN_HEIGHT_PX);
  });
});

/**
 * The message panel's height gate.
 *
 * The third of these, and the defect is the same shape as the other two:
 * `desktop:` is a `min-width`, so a phone in landscape is served the desktop
 * conversation panel into a 343px row. What made this one worse than a crowded
 * layout is that the chrome does not shrink - 145px of header and a 53px tab
 * strip came off the top, and `SendBar`'s min-content height took the rest, so
 * the conversation was left with its own padding and nothing else:
 * `contentHeight` 0, with a `scrollHeight` of 220 behind it (SCRUM-489).
 *
 * These guard the derivation rather than the number, for the reason the
 * wizard's docblock gives: a test restating 489 would still pass on the day one
 * of the five measured terms changes, which is the day the threshold stops
 * being true.
 */
describe("the message panel's minimum height", () => {
  it("is composed from the panel's own blocks, not chosen", () => {
    expect(MESSAGE_PANEL_MIN_HEIGHT_PX).toBe(
      Math.ceil(
        (MESSAGE_PANEL_HEADER_PX +
          MESSAGE_PANEL_TAB_STRIP_PX +
          MESSAGE_PANEL_SEND_BAR_PX +
          MESSAGE_CONTENT_PADDING_PX +
          MESSAGE_PANEL_DATED_MESSAGE_PX) /
          CONTENT_ROW_VIEWPORT_FRACTION,
      ),
    );
  });

  /**
   * The inequality the constant was solved from, restated at the boundary. At
   * the threshold the conversation has room for one dated message; one pixel
   * below, it does not. That one-pixel check is what makes this a boundary
   * rather than a plausible number.
   */
  it("is the height at which one whole message first fits beside the chrome", () => {
    const conversationAt = (viewportHeight: number) =>
      viewportHeight * CONTENT_ROW_VIEWPORT_FRACTION -
      MESSAGE_PANEL_HEADER_PX -
      MESSAGE_PANEL_TAB_STRIP_PX -
      MESSAGE_PANEL_SEND_BAR_PX -
      MESSAGE_CONTENT_PADDING_PX;

    expect(conversationAt(MESSAGE_PANEL_MIN_HEIGHT_PX)).toBeGreaterThanOrEqual(
      MESSAGE_PANEL_DATED_MESSAGE_PX,
    );
    expect(conversationAt(MESSAGE_PANEL_MIN_HEIGHT_PX - 1)).toBeLessThan(
      MESSAGE_PANEL_DATED_MESSAGE_PX,
    );
  });

  it("is a whole number of pixels", () => {
    // Emitted into a media query, and compared against viewport heights that
    // are integers.
    expect(Number.isInteger(MESSAGE_PANEL_MIN_HEIGHT_PX)).toBe(true);
  });

  /**
   * The two bounds the figure was accepted against. Unlike the admin console's
   * gate this one removes no capability - the panel still renders, with
   * compacted chrome - but setting it too high would restyle a real desktop,
   * and setting it too low would leave a landscape phone on the arrangement
   * that shows nothing.
   */
  it("excludes every phone in landscape while keeping every desktop window", () => {
    for (const [width, height] of [
      [667, 375], // iPhone SE2 / 8
      [844, 390], // iPhone 12/13/14
      [932, 430], // iPhone 14 Pro Max
    ]) {
      // Above the width breakpoint and below the height gate: the defect.
      expect(isMobileWidth(width)).toBe(false);
      expect(height).toBeLessThan(MESSAGE_PANEL_MIN_HEIGHT_PX);
    }

    /* And the side that must not regress. ~650 is a 1366x768 laptop after
       browser chrome, ~695 an iPad in landscape in Safari. */
    for (const height of [650, 695, 800, 900]) {
      expect(height).toBeGreaterThan(MESSAGE_PANEL_MIN_HEIGHT_PX);
    }
  });

  /**
   * Neither of the other two, and this is the assertion that keeps the three
   * from being quietly collapsed into one "short desktop" figure. They answer
   * different questions about different layouts, and the wizard's 844 would
   * compact this panel on an ordinary laptop.
   */
  it("is its own figure, not the wizard's or the console's", () => {
    expect(MESSAGE_PANEL_MIN_HEIGHT_PX).not.toBe(WIZARD_DESKTOP_MIN_HEIGHT_PX);
    expect(MESSAGE_PANEL_MIN_HEIGHT_PX).not.toBe(ADMIN_CONSOLE_MIN_HEIGHT_PX);
    expect(MESSAGE_PANEL_MIN_HEIGHT_PX).toBeLessThan(
      WIZARD_DESKTOP_MIN_HEIGHT_PX,
    );
  });
});

/**
 * The message panel's screen, which is the gate above plus the width
 * breakpoint.
 *
 * Both terms matter and the width one is the less obvious. `SendBar` and
 * `MessageContent` are a single tree on both platforms, so their compact
 * values are the *base* - and without the width term this screen would reach a
 * phone held in portrait, restoring insets written for a desktop panel onto a
 * 375px screen. `MessageHeader` is the exception that proves it: its desktop
 * arrangement is a separate branch, so its base classes are unreachable from
 * mobile whatever this query says.
 */
describe("the message panel's screen", () => {
  it("is registered in the Tailwind config, so the CSS and the JS agree", () => {
    expect(screens[MESSAGE_PANEL_TALL_SCREEN_NAME]).toEqual({
      raw: MESSAGE_PANEL_TALL_MEDIA_QUERY,
    });
  });

  it("composes both terms rather than restating either", () => {
    expect(MESSAGE_PANEL_TALL_MEDIA_QUERY).toContain(
      `(min-width: ${MOBILE_BREAKPOINT_PX}px)`,
    );
    expect(MESSAGE_PANEL_TALL_MEDIA_QUERY).toContain(
      `(min-height: ${MESSAGE_PANEL_MIN_HEIGHT_PX}px)`,
    );
  });

  /**
   * Both `min-`, matching the other two queries in this file. A `max-` term
   * here would mean the mobile-first inversion had been undone, and would need
   * a fractional pixel to avoid claiming the boundary itself for the wrong
   * side.
   */
  it("states both terms as min-", () => {
    expect(MESSAGE_PANEL_TALL_MEDIA_QUERY).not.toContain("max-width");
    expect(MESSAGE_PANEL_TALL_MEDIA_QUERY).not.toContain("max-height");
  });

  it("does not shadow an existing screen", () => {
    const others = Object.keys(screens).filter(
      (name) => name !== MESSAGE_PANEL_TALL_SCREEN_NAME,
    );
    expect(others).not.toContain(MESSAGE_PANEL_TALL_SCREEN_NAME);
  });

  /**
   * Declaration order, and it bites harder here than anywhere else in this
   * list: this screen and `desktop-tall` share a width term, and every viewport
   * that matches `desktop-tall` also matches this one. Emitted after it, this
   * screen would win the cascade wherever both set a property - so a desktop
   * window would get the compact chrome, which is the opposite of the intent.
   */
  it("is declared after the plain desktop screen and before the tall one", () => {
    const names = Object.keys(screens);

    expect(names.indexOf(MESSAGE_PANEL_TALL_SCREEN_NAME)).toBeGreaterThan(
      names.indexOf(DESKTOP_SCREEN_NAME),
    );
    expect(names.indexOf(MESSAGE_PANEL_TALL_SCREEN_NAME)).toBeLessThan(
      names.indexOf(DESKTOP_TALL_SCREEN_NAME),
    );
  });

  /**
   * The ordering test above is only meaningful while the heights really are
   * ascending, so pin the relation it depends on rather than the positions
   * alone.
   */
  it("gates on a shorter viewport than the tall desktop screen does", () => {
    expect(MESSAGE_PANEL_MIN_HEIGHT_PX).toBeLessThan(
      WIZARD_DESKTOP_MIN_HEIGHT_PX,
    );
  });
});
