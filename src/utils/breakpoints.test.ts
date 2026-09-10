import {
  DESKTOP_SCREEN_NAME,
  MOBILE_BREAKPOINT_PX,
  MOBILE_NAV_HEIGHT_PX,
  MOBILE_NAV_SPACE,
  isMobileWidth,
} from "./breakpoints";

// Required rather than imported: the Tailwind config is CommonJS, and requiring
// it here is what makes this a real drift guard rather than a restated constant.
const tailwindConfig = require("../../tailwind.config.js");

const screens: Record<string, string> = tailwindConfig.theme.screens;
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
   * Tailwind emits media queries in declaration order, so a larger screen
   * declared before a smaller one silently loses the cascade wherever the two
   * set the same property. Easy to reintroduce when adding a screen.
   */
  it("declares screens in ascending order", () => {
    const widths = Object.values(screens).map((value) =>
      Number.parseInt(value, 10),
    );
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
 * The mobile navigation's height (SCRUM-412).
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
