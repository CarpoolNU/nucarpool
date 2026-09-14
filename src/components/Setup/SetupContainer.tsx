import React from "react";
import { CSSProperties } from "styled-components";

/**
 * The wizard's white card.
 *
 * **The width is owned here, mobile-first, and no caller overrides it.** It was
 * an unconditional 600px, and `src/pages/profile/setup.tsx` appended a mobile
 * width to `className` to correct that - which put two `width` declarations of
 * equal specificity on one element. CSS resolves that by position in the
 * stylesheet, not by position in the attribute, and Tailwind sorts arbitrary
 * values when it emits them: it sorted the override ahead of the 600px, so the
 * override lost and every phone rendered this card 600px wide inside a viewport
 * commonly 375px. The card is centred by a flex parent, so the left overflow
 * was not even reachable by scrolling.
 *
 * Declaring a base value plus a `desktop:` override removes the contest instead
 * of reordering it. A media-query rule is emitted after the unprefixed
 * utilities it overrides, so which of the two applies is guaranteed by the
 * cascade rather than left to the compiler's sort - and the value has one owner,
 * so there is no override left to lose. Styling-only differences go through
 * `desktop:` rather than an `isMobile` ternary, per SCRUM-415.
 *
 * `h-[500px]` stays a desktop figure and is deliberately *not* paired with a
 * `desktop:` prefix: the caller overrides the height with an inline `style` per
 * step on mobile, and an inline declaration beats any class regardless of
 * stylesheet order, so that one is unambiguous already.
 */
export const SetupContainer = ({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: CSSProperties;
}) => {
  return (
    <div
      className={`desktop:w-[600px] z-50 h-[500px] w-[90%] bg-white p-4 ${className}`}
      style={style}
    >
      {children}
    </div>
  );
};
