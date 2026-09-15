/**
 * The Terms and Conditions gate, and whether assistive technology can see it.
 *
 * `ComplianceModal` used to wrap both its backdrop and its `Dialog.Panel` in a
 * single `div` carrying `aria-hidden="true"`. `aria-hidden` applies to the
 * whole subtree and no descendant can opt back in, so every control in the
 * dialog was removed from the accessibility tree - while still rendering,
 * still being visible, and still being clickable with a mouse. SCRUM-475.
 *
 * That mattered more here than anywhere else in the app. This dialog is
 * rendered over everything for any user who has not accepted the terms, its
 * `onClose` is a deliberate no-op, and "I Agree" is the only way past it. A
 * screen-reader user was handed a dialog with no announced exit.
 *
 * **What makes these tests work at all**: Testing Library resolves `*ByRole`
 * against the accessibility tree, so `getByRole` *without* `{ hidden: true }`
 * fails on the defect and passes on the fix, for markup that is byte-identical
 * to `getByText` either way. That difference is the whole assertion - a
 * `getByText` here would have passed against the bug.
 *
 * The backdrop assertions are not decoration. Deleting `aria-hidden` outright
 * would also make the role queries pass, so the fix needs pinning from both
 * sides: the panel reachable, the blur layer still hidden.
 *
 * jsdom computes no layout and no `backdrop-filter`, so the blur is asserted as
 * the class that produces it and nothing more. See `src/testing/viewport.ts`.
 */

import { render, screen } from "@testing-library/react";
import { ComplianceModal } from "./CompliancePortal";

const invalidate = jest.fn();
const mutateAsync = jest.fn();

// `utils/mixpanel` initialises the SDK at module scope from `browserEnv`, which
// `envsafe` validates on import - so importing it for real would make this file
// depend on the environment rather than on the component.
jest.mock("../utils/mixpanel", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({ user: { me: { invalidate } } }),
    user: {
      acceptTerms: {
        useMutation: () => ({ mutateAsync, isPending: false }),
      },
    },
  },
}));

/** Every ancestor of `element` up to `<body>`, nearest first. */
const ancestorsOf = (element: HTMLElement): HTMLElement[] => {
  const chain: HTMLElement[] = [];

  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    chain.push(node);
  }

  return chain;
};

describe("the compliance gate's accessibility tree", () => {
  it("offers 'I Agree' as a button to assistive technology", () => {
    render(<ComplianceModal />);

    // No `{ hidden: true }`, deliberately. This is the query that failed.
    expect(screen.getByRole("button", { name: "I Agree" })).toBeInTheDocument();
  });

  it("announces the dialog's title", () => {
    render(<ComplianceModal />);

    expect(
      screen.getByRole("heading", { name: "Carpool Terms and Conditions" }),
    ).toBeInTheDocument();
  });

  it("puts no aria-hidden on any ancestor of the panel", () => {
    render(<ComplianceModal />);

    const hiddenAncestors = ancestorsOf(
      screen.getByRole("button", { name: "I Agree" }),
    ).filter((node) => node.getAttribute("aria-hidden") === "true");

    expect(hiddenAncestors).toHaveLength(0);
  });

  /**
   * The other half of the pin. The backdrop is genuinely decorative and has to
   * stay out of the accessibility tree; a fix that simply deleted the attribute
   * would satisfy every assertion above and fail this one.
   */
  it("keeps the backdrop hidden, and still blurring", () => {
    const { baseElement } = render(<ComplianceModal />);

    // Selected by the class that draws the blur rather than by `aria-hidden`,
    // for two reasons. It keeps "the blur still exists" and "the blur is
    // hidden" as two separate claims instead of assuming one from the other,
    // and `[aria-hidden="true"]` alone does not identify this element -
    // Headless UI marks internal nodes of its own with it, and that is what
    // the first version of this query returned.
    const backdrops = baseElement.querySelectorAll(".backdrop-blur-xs");

    expect(backdrops).toHaveLength(1);
    expect(backdrops[0]).toHaveAttribute("aria-hidden", "true");
    // A sibling of the panel rather than its ancestor: the defect was the
    // containment, not the attribute.
    expect(backdrops[0]).not.toContainElement(
      screen.getByRole("button", { name: "I Agree" }),
    );
  });
});
