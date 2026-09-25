/**
 * SCRUM-561 item 2: closing "Your request has been sent!" by any route must
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

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      useUtils: () => {
        const queryClient = reactQuery.useQueryClient();
        return {
          user: {
            recommendations: {
              me: {
                invalidate: async () => {
                  invalidateRecommendations();
                },
              },
            },
            requests: {
              me: {
                invalidate: () => {
                  invalidateRequests();
                  return queryClient.invalidateQueries({
                    queryKey: ["requests.me"],
                  });
                },
              },
            },
          },
        };
      },
      user: {
        requests: {
          create: {
            useMutation: (options: object) =>
              reactQuery.useMutation({
                mutationFn: async () => ({ id: "request-1" }),
                ...options,
              }),
          },
        },
        emails: {
          sendRequestNotification: {
            useMutation: () => ({ mutate: jest.fn() }),
          },
        },
      },
    },
  };
});

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

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
