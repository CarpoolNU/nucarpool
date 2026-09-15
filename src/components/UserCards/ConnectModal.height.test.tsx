/**
 * That the connect modal's panel caps its own height, and that the cap is
 * paired with an alignment which leaves the overflow reachable.
 *
 * SCRUM-482 (phase 1 of SCRUM-477). The panel carried `overflow-y-auto` and no
 * `max-height`, which is a scroller that can never engage: with no ceiling the
 * box simply grows to its content, so the content never exceeds it. Centred
 * inside a `fixed inset-0` wrapper, it then overflowed off both edges with no
 * page scroll to recover it.
 *
 * **Two distinct failures were measured, and only the second is the one the
 * survey named.** At 667x375 - a small phone in landscape - `md:` is not even
 * active, since `md` is 834px in this project's theme: the panel was simply its
 * natural 802px tall, putting `Cancel` and `Send` 198px past the bottom edge.
 * At 932x430 - a large phone in landscape, above `md` - `md:aspect-square`
 * derived a 700px height from the 700px width and the action row sat 96px
 * below the fold. So `aspect-square` makes it worse above 834px but is not the
 * cause below it; the missing cap is.
 *
 * **Why `justify-center-safe` is asserted here and not left as styling.** A
 * flex container that centres on the main axis overflows *symmetrically*, and
 * a scroll container has no negative scroll range - so adding `max-h` alone
 * would have traded an unreachable bottom for an unreachable top. Measured in
 * Chromium: with plain `justify-center` and the cap applied, the panel's first
 * child sat at -197px against a panel top of 19px, 216px above the scrollable
 * origin. With `safe` it sits at 35px and the whole panel scrolls. The class
 * is load-bearing, which is precisely why a class-name assertion is worth
 * having.
 *
 * jsdom performs no layout and resolves no media query, so none of those
 * rectangles is observable here; they are recorded on the ticket. What this
 * file pins is which classes the panel requests.
 *
 * Run against the pre-fix component, the two cases naming this change's
 * classes fail. The other two pass either way on purpose: they guard
 * properties that were already correct and that the fix had to preserve.
 */

import { render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import ConnectModal from "./ConnectModal";
import { EnhancedPublicUser, User } from "../../utils/types";

/**
 * `ConnectModal` calls both mutations at render, so both have to exist or the
 * render throws. The subject here is the panel's class list, so the client is
 * mocked as a shape rather than driven through a real provider - the same
 * approach as `ConnectCard.test.tsx`.
 */
jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: {
        recommendations: { me: { invalidate: jest.fn() } },
        requests: { me: { invalidate: jest.fn() } },
      },
    }),
    user: {
      requests: {
        create: {
          useMutation: () => ({ mutate: jest.fn(), isPending: false }),
        },
      },
      emails: {
        sendRequestNotification: {
          useMutation: () => ({ mutate: jest.fn() }),
        },
      },
    },
  },
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

const OTHER_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "Looking for a carpool.",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  companyAddress: "2 Elsewhere Ave",
  daysWorking: "1,1,1,1,1,0,0",
  startTime: new Date("2026-01-05T13:00:00.000Z"),
  endTime: new Date("2026-01-05T22:00:00.000Z"),
  coopStartDate: new Date("2026-01-05T00:00:00.000Z"),
  coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
  carpoolId: null,
  isFavorited: false,
} as unknown as EnhancedPublicUser;

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

/**
 * The panel, found from a control inside it rather than by class name - so the
 * assertions below are about an element the test located structurally.
 */
const renderPanel = (): HTMLElement => {
  render(
    <ConnectModal
      user={VIEWER}
      otherUser={OTHER_USER}
      onClose={jest.fn()}
      onViewRequest={jest.fn()}
    />,
  );

  const heading = screen.getByText("Send a message to connect!");
  const panel = heading.closest("[class*='max-w-[700px]']");
  if (!(panel instanceof HTMLElement)) {
    throw new Error("the dialog panel is not where this test expects it");
  }
  return panel;
};

describe("the connect modal's panel height", () => {
  it("caps itself against the dynamic viewport", () => {
    const panel = renderPanel();

    expect(panel.className).toContain("max-h-[90dvh]");
    // A *bare* `vh`, which `dvh` deliberately does not match. `vh` is the
    // viewport with the mobile browser's chrome retracted.
    expect(panel.className).not.toMatch(/\d+vh\]/);
  });

  it("keeps the scroller that the cap makes meaningful", () => {
    const panel = renderPanel();

    // Present before this ticket, and inert without the cap above. Asserted
    // together because either alone is a no-op.
    expect(panel.className).toContain("overflow-y-auto");
  });

  it("aligns safely, so the overflow does not go off the unreachable end", () => {
    const panel = renderPanel();

    expect(panel.className).toContain("justify-center-safe");
    // The bare utility would re-break the top. `-safe` is a different class,
    // so this has to exclude the unsuffixed spelling explicitly.
    expect(panel.className).not.toMatch(/justify-center(?!-safe)/);
  });

  it("keeps the square proportion it had, for viewports with room for it", () => {
    const panel = renderPanel();

    // `aspect-ratio` yields to `max-height`, so the cap does not cost the
    // desktop look - verified in Chromium at 1440x900, where the panel is
    // 700x700 both before and after this change.
    expect(panel.className).toContain("md:aspect-square");
  });
});
