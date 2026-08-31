import {
  DESKTOP_SCREEN_NAME,
  MOBILE_BREAKPOINT_PX,
  isMobileWidth,
} from "./breakpoints";

// Required rather than imported: the Tailwind config is CommonJS, and requiring
// it here is what makes this a real drift guard rather than a restated constant.
const tailwindConfig = require("../../tailwind.config.js");

const screens: Record<string, string> = tailwindConfig.theme.screens;

/**
 * SCRUM-237: the app used to decide "is mobile" twice, at 640 in `useIsMobile`
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
