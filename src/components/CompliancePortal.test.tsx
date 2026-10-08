/**
 * The Terms and Conditions gate, and whether assistive technology can see it.
 *
 * `aria-hidden` applies to the whole subtree and no descendant can opt back
 * in, so the backdrop and the `Dialog.Panel` must never share one wrapping
 * element carrying it - that would remove every control in the dialog from
 * the accessibility tree while it still renders, is still visible, and is
 * still clickable with a mouse.
 *
 * That matters more here than anywhere else in the app: this dialog is
 * rendered over everything for any user who has not accepted the terms, its
 * `onClose` is a deliberate no-op, and "I Agree" is the only way past it. A
 * screen-reader user excluded from it would have no announced exit.
 *
 * **What makes these tests work at all**: Testing Library resolves `*ByRole`
 * against the accessibility tree, so `getByRole` *without* `{ hidden: true }`
 * would fail if `aria-hidden` ever applied here, for markup that is
 * byte-identical to `getByText` either way. That difference is the whole
 * assertion - a `getByText` here would pass regardless.
 *
 * The backdrop assertions are not decoration. Deleting `aria-hidden` outright
 * would also make the role queries pass, so the invariant needs pinning from
 * both sides: the panel reachable, the blur layer still hidden.
 *
 * jsdom computes no layout and no `backdrop-filter`, so the blur is asserted as
 * the class that produces it and nothing more. See `src/testing/viewport.ts`.
 */

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ComplianceModal } from "./CompliancePortal";

// `utils/mixpanel` initialises the SDK at module scope from `browserEnv`, which
// `envsafe` validates on import - so importing it for real would make this file
// depend on the environment rather than on the component.
jest.mock("../utils/mixpanel", () => ({
  trackEvent: jest.fn(),
}));

/**
 * `acceptTerms` is declared `inertMutation`: the component wires it up on every
 * render, but nothing in this file clicks "I Agree", so it never fires. That
 * the dialog stays up until the write succeeds is a different claim, and not
 * this file's subject.
 *
 * `user.me` is declared with no hooks at all, because the component never
 * queries it. It is here for `useUtils`, which mirrors the spec's paths: the
 * `onSuccess` above reaches `utils.user.me.invalidate`, and a path the spec
 * omits is absent from `useUtils` too.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock({
    "user.acceptTerms": { inertMutation: true },
    "user.me": {},
  }),
);

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

/**
 * A real `QueryClientProvider`, which the harness's `useUtils` requires: it
 * calls `useQueryClient()` unconditionally, as tRPC's own `useUtils` does, so a
 * component reaching for utils outside a provider fails here the way it would
 * in the app rather than silently working. `ComplianceGate` mounts this dialog
 * inside `_app`'s provider, so this is the real shape.
 */
const renderModal = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ComplianceModal />
    </QueryClientProvider>,
  );

describe("the compliance gate's accessibility tree", () => {
  it("offers 'I Agree' as a button to assistive technology", () => {
    renderModal();

    // No `{ hidden: true }`, deliberately. This is the query that failed.
    expect(screen.getByRole("button", { name: "I Agree" })).toBeInTheDocument();
  });

  it("announces the dialog's title", () => {
    renderModal();

    expect(
      screen.getByRole("heading", { name: "Carpool Terms and Conditions" }),
    ).toBeInTheDocument();
  });

  it("puts no aria-hidden on any ancestor of the panel", () => {
    renderModal();

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
    const { baseElement } = renderModal();

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
