/**
 * `ConnectModal`: what closing it by each route refreshes, and how its panel
 * bounds its own height.
 *
 * Two tickets, one per `describe` block, which were two sibling files. The
 * split was not one of the mandatory kinds in `CLAUDE.md`; it was an idiom
 * difference. The height block stubbed `trpc` as a plain object, because all
 * it needed was for the two render-time mutations to exist - the subject is a
 * class list, not a timeline. That is a strict subset of what the harness spec
 * below already provides, so the whole file now runs on the real client and
 * the height block renders inside the same provider. Its one adaptation is
 * that wrapper: a real `useMutation` throws without a `QueryClient`, where the
 * plain stub needed none.
 *
 * The two `otherUser` fixtures were near-identical and are now one. The height
 * assertions do not read it at all - the panel is located from a heading that
 * appears whatever the counterpart looks like - so the surviving fixture is
 * the one the send flow needs.
 *
 * ---
 *
 * Closing "Your request has been sent!" by any route must
 * refresh the request lists, not only by its Close button.
 *
 * `onClose` invalidated `requests.me` and `recommendations.me` only for the
 * `closeAfterSend` action, which only the explicit buttons pass. Esc and a
 * backdrop click reach it through `Dialog`'s `onClose` as `close`, so after
 * either one the Requests tab had no sent card, the explore card still offered
 * Connect, and a second Send ran into the server's CONFLICT.
 *
 * **Real React Query**, per `sendMessageThreadRefresh.test.tsx`: the
 * invalidations are spies that also reach a real `QueryClient`, and a probe
 * component holds a live `requests.me` query - so what is asserted is that the
 * list actually refetched, not merely that a function was called. The request
 * mutation is real too, with a stubbed `mutationFn`, so `requestSent` flips
 * through the component's own `onSuccess`.
 *
 * The action forwarded to the parent is asserted as well: `ConnectCard`
 * collapses the mobile detail sheet on `closeAfterSend`, and invalidating while
 * still reporting `close` would refresh the list out from under it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Role, Status } from "@prisma/client";
import ConnectModal from "./ConnectModal";
import { EnhancedPublicUser, User } from "../../utils/types";

const invalidateRequests = jest.fn();
const invalidateRecommendations = jest.fn();
const requestsQueryFn = jest.fn(async () => []);

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.requests.create": { mutation: async () => ({ id: "request-1" }) },
    "user.emails.sendRequestNotification": { inertMutation: true },
    "user.recommendations.me": {
      invalidate: async () => {
        invalidateRecommendations();
      },
    },
    "user.requests.me": {
      /*
       * Reaches the cache for real, because the point is that the Requests
       * tab refreshes. The key is `RequestsProbe`'s own literal one - that
       * query is a plain `useQuery` in this file, not a harness path, so it
       * must stay `["requests.me"]` rather than follow the harness's scheme.
       */
      invalidate: (queryClient: QueryClient) => {
        invalidateRequests();
        return queryClient.invalidateQueries({ queryKey: ["requests.me"] });
      },
    },
  }),
);

jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

const OTHER_USER = {
  id: "other-1",
  preferredName: "Riley",
  pronouns: "",
  bio: "",
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
} as unknown as EnhancedPublicUser;

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
} as unknown as User;

/** The Requests tab's list, standing in for everything reading `requests.me`. */
const RequestsProbe = () => {
  useQuery({ queryKey: ["requests.me"], queryFn: requestsQueryFn });
  return null;
};

const onClose = jest.fn();

const renderModal = async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RequestsProbe />
      <ConnectModal
        user={VIEWER}
        otherUser={OTHER_USER}
        onClose={onClose}
        onViewRequest={jest.fn()}
      />
    </QueryClientProvider>,
  );
  // The list's first load, so any later call is a refetch.
  await waitFor(() => expect(requestsQueryFn).toHaveBeenCalledTimes(1));
};

const send = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Your request has been sent!");
};

const pressEscape = () => fireEvent.keyDown(document, { key: "Escape" });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("closing the connect modal after a request was sent", () => {
  it("refreshes the request lists when closed with Esc", async () => {
    await renderModal();
    await send();

    pressEscape();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invalidateRequests).toHaveBeenCalledTimes(1);
    expect(invalidateRecommendations).toHaveBeenCalledTimes(1);
    // The invalidation reached the cache and the list fetched again.
    await waitFor(() => expect(requestsQueryFn).toHaveBeenCalledTimes(2));
  });

  it("tells the parent the request was sent, whichever control closed it", async () => {
    await renderModal();
    await send();

    pressEscape();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledWith("closeAfterSend");
  });

  /** The path that always worked, which the fix had to keep. */
  it("control: the Close button still refreshes the lists", async () => {
    await renderModal();
    await send();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith("closeAfterSend"));
    await waitFor(() => expect(requestsQueryFn).toHaveBeenCalledTimes(2));
  });

  /**
   * The control for the Esc cases: nothing was sent, so there is nothing to
   * refresh. A modal that invalidated on every close would pass the cases above
   * and fail this.
   */
  it("control: Esc before sending refreshes nothing and reports a plain close", async () => {
    await renderModal();

    pressEscape();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledWith("close");
    expect(invalidateRequests).not.toHaveBeenCalled();
    expect(invalidateRecommendations).not.toHaveBeenCalled();
    expect(requestsQueryFn).toHaveBeenCalledTimes(1);
  });
});

/**
 * That the connect modal's panel caps its own height, and that the cap is
 * paired with an alignment which leaves the overflow reachable.
 *
 * This was phase 1 of a broader modal-height audit. The panel carried
 * `overflow-y-auto` and no `max-height`, which is a scroller that can never
 * engage: with no ceiling the
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
 * rectangles is observable here. What this file pins is which classes the
 * panel requests.
 *
 * Run against the pre-fix component, the two cases naming this change's
 * classes fail. The other two pass either way on purpose: they guard
 * properties that were already correct and that the fix had to preserve.
 */
describe("the connect modal's panel height", () => {
  /**
   * The panel, found from a control inside it rather than by class name - so
   * the assertions below are about an element the test located structurally.
   *
   * Wrapped in the same client the block above uses, because the harness makes
   * `useMutation` the real one and a real one throws without a `QueryClient`.
   */
  const renderPanel = (): HTMLElement => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ConnectModal
          user={VIEWER}
          otherUser={OTHER_USER}
          onClose={onClose}
          onViewRequest={jest.fn()}
        />
      </QueryClientProvider>,
    );

    const heading = screen.getByText("Send a message to connect!");
    const panel = heading.closest("[class*='max-w-[700px]']");
    if (!(panel instanceof HTMLElement)) {
      throw new Error("the dialog panel is not where this test expects it");
    }
    return panel;
  };

  it("caps itself against the dynamic viewport", () => {
    const panel = renderPanel();

    expect(panel.className).toContain("max-h-[90dvh]");
    // A *bare* `vh`, which `dvh` deliberately does not match. `vh` is the
    // viewport with the mobile browser's chrome retracted.
    expect(panel.className).not.toMatch(/\d+vh\]/);
  });

  it("keeps the scroller that the cap makes meaningful", () => {
    const panel = renderPanel();

    // Inert without the cap above, and the cap is inert without it. Asserted
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
