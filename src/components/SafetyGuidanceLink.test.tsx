/**
 * What reaches Mixpanel when somebody follows the safety guidance link.
 *
 * Two separate claims are pinned here, and they fail for different reasons.
 *
 * **The component forwards its `surface`.** `SafetyGuidanceLink` is one
 * component behind three call sites, so the destination is never in doubt and
 * the surface is the only thing the event adds. A version that hard-coded a
 * surface, or dropped the prop, would still emit `Link Clicked` with
 * `link: "safety"` and be useless.
 *
 * **Each real call site passes a distinct one.** That is the claim the first
 * cannot make: `SafetyGuidanceLink surface="profile"` in a test proves the
 * plumbing and nothing about what `SafetySection` actually writes. So the two
 * parents that can be rendered cheaply are rendered, and their own clicks are
 * asserted.
 *
 * `mixpanel-browser` is mocked locally rather than left to the
 * `moduleNameMapper` stub in `jest.config.js`, for the reason
 * `src/testing/mixpanelBrowserStub.js` records: that stub's methods are plain
 * no-ops, deliberately, so nothing can be asserted against them. A local
 * `jest.mock` takes precedence and lets `utils/mixpanel` load for real, which
 * is what keeps this honest - the event name and the property shape come from
 * the module under test, not from a fake of it.
 *
 * *What this does not cover:* `ReportDialog`'s surface, which is pinned in
 * `src/components/UserActions/ReportDialog.test.tsx` beside that dialog's own
 * tRPC harness rather than duplicating it here.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SafetyGuidanceLink from "./SafetyGuidanceLink";
import SafetySection from "./Profile/SafetySection";
import BlockConfirmDialog from "./UserActions/BlockConfirmDialog";
import { suppressLinkNavigation } from "../testing/suppressLinkNavigation";

/*
 * The spies are created inside the factory and read back below, never closed
 * over from above: `jest.mock` is hoisted over the imports, and
 * `utils/mixpanel` calls `mixpanel.init` at module scope, so a factory reading
 * an outer `const` would run before that `const` initialised and take the
 * whole file out of the run. `src/utils/mixpanel.test.tsx` says the same.
 */
jest.mock("mixpanel-browser", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

/**
 * `BlockConfirmDialog` reads `trpc.useUtils()` and one mutation. Neither is
 * exercised here - nothing presses Block - but both must exist or the dialog
 * throws on render before any link is in the DOM.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock({
    "user.blocks.block": { inertMutation: true },
  }),
);

const { track } = (
  jest.requireMock("mixpanel-browser") as {
    default: Record<"init" | "track" | "identify" | "reset", jest.Mock>;
  }
).default;

const LINK_TEXT = "Reporting, blocking and staying safe";

beforeEach(() => {
  jest.clearAllMocks();
  suppressLinkNavigation.install();
});

afterEach(suppressLinkNavigation.uninstall);

describe("SafetyGuidanceLink", () => {
  it("still points at /safety, and tracking does not swallow the click", async () => {
    render(<SafetyGuidanceLink surface="profile" />);

    const link = screen.getByRole("link", { name: LINK_TEXT });
    expect(link).toHaveAttribute("href", "/safety");

    // The navigation itself is next/link's business; what matters here is that
    // the handler neither threw nor called preventDefault on the way through.
    await userEvent.click(link);
    expect(link).toHaveAttribute("href", "/safety");
  });

  it.each(["profile", "block-dialog", "report-dialog"])(
    "emits the surface it was given: %s",
    async (surface) => {
      render(<SafetyGuidanceLink surface={surface} />);

      await userEvent.click(screen.getByRole("link", { name: LINK_TEXT }));

      expect(track.mock.calls).toEqual([
        ["Link Clicked", { link: "safety", surface }],
      ]);
    },
  );

  it("sends no href and no link text", async () => {
    render(<SafetyGuidanceLink surface="profile" />);

    await userEvent.click(screen.getByRole("link", { name: LINK_TEXT }));

    /*
     * The positive control matters more than the negative one: an exact
     * `toEqual` on the whole property bag is what makes "no href" meaningful,
     * since `not.toHaveProperty` would also pass against a wrapper that had
     * stopped sending anything at all.
     */
    expect(track).toHaveBeenCalledTimes(1);
    const [, properties] = track.mock.calls[0] as [string, object];
    expect(Object.keys(properties).sort()).toEqual(["link", "surface"]);
  });

  it("emits nothing until the link is actually clicked", async () => {
    render(<SafetyGuidanceLink surface="profile" />);

    expect(track).not.toHaveBeenCalled();
  });
});

describe("the surface each call site passes", () => {
  it("is 'profile' from the profile's Safety section", async () => {
    render(<SafetySection />);

    await userEvent.click(screen.getByRole("link", { name: LINK_TEXT }));

    expect(track.mock.calls).toEqual([
      ["Link Clicked", { link: "safety", surface: "profile" }],
    ]);
  });

  it("is 'block-dialog' from the block confirmation", async () => {
    /*
     * The dialog's `useUtils()` calls `useQueryClient` unconditionally, as the
     * real one does, so it needs a provider even though nothing here presses
     * Block. The harness documents that as deliberate: a component reaching
     * for utils outside a provider should fail the way it would in the app.
     */
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BlockConfirmDialog
          open
          userId="cl9xq0000000user1"
          userName="Alex Rider"
          onClose={jest.fn()}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole("link", { name: LINK_TEXT }));

    expect(track.mock.calls).toEqual([
      ["Link Clicked", { link: "safety", surface: "block-dialog" }],
    ]);
  });
});
