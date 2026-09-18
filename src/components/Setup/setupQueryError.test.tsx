/**
 * SCRUM-509: that a failed `user.me` on `/profile/setup` says so.
 *
 * The wizard's guard was `if (isLoading || !user)`, returning a
 * `fixed inset-0 z-50` white overlay with a spinner in it. `isError` went
 * unread, so a failure left `data` undefined behind that overlay for good -
 * and this is the first screen a new account ever sees, drawn before `Header`,
 * covering the viewport, with no navigation to leave by and nothing to do but
 * reload by hand.
 *
 * `user.me` reaches that state on ordinary events rather than exotic ones: it
 * throws `UNAUTHORIZED` on a lapsed session and `NOT_FOUND` with no `User`
 * row, both of which are in `NON_RETRYABLE_CODES`, so React Query errors
 * immediately instead of retrying. There is no error boundary in `_app.tsx` to
 * catch it one level up.
 *
 * **The real page, not a reproduction of its shape.** It is importable with the
 * mocks `setupViewerRoleDefault.test.tsx` established, so this pins the
 * shipped guard rather than a copy of it - the limitation that file's siblings
 * document. Deliberately not co-located: a test file under `src/pages/` is
 * also a route.
 *
 * **Real React Query with a rejecting `queryFn`**, so the rejection reaches the
 * page as the flags it actually reads, and so the retry can be shown to
 * recover rather than asserted to exist.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

/** Set per test: what the one `user.me` fetch does. */
let behaviour: () => Promise<unknown> = async () => ({});
const queryFn = jest.fn(() => behaviour());

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      mapbox: {
        search: { useQuery: () => ({ data: undefined, error: null }) },
      },
      user: {
        me: {
          useQuery: (input: unknown, options: object) =>
            reactQuery.useQuery({
              queryKey: ["user.me", input],
              queryFn: () => queryFn(),
              ...options,
            }),
        },
      },
    },
  };
});

jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: jest.fn(),
  trackFTUECompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: jest.fn(),
  useEditUserMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));

import Setup from "../../pages/profile/setup";

/** The fields the wizard's `initialLoad` effect and step 0 actually read. */
const BASE_USER = {
  role: "RIDER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: "",
  pronouns: "",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  bio: "",
  startCoordLng: 0,
  startCoordLat: 0,
  companyCoordLng: 0,
  companyCoordLat: 0,
};

const renderSetup = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Setup />
    </QueryClientProvider>,
  );

const spinner = () => screen.queryByText("Loading...");

beforeEach(() => {
  queryFn.mockClear();
  behaviour = async () => BASE_USER;
});

describe("/profile/setup when user.me fails", () => {
  it("renders the error treatment instead of a permanent overlay", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderSetup();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load your profile.");

    // The defect itself: the overlay spinner used to stay for the session.
    expect(spinner()).not.toBeInTheDocument();
  });

  it("recovers the wizard when retry is pressed and the session is back", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderSetup();
    await screen.findByRole("alert");

    behaviour = async () => BASE_USER;

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Get Started" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  /**
   * The control, and the mutation test for the two cases above: a page
   * rendering `QueryError` unconditionally passes both and fails this.
   */
  it("control: a resolving query renders the wizard and no error", async () => {
    renderSetup();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Get Started" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(spinner()).not.toBeInTheDocument();
  });

  it("control: shows the spinner while user.me is still in flight", () => {
    behaviour = () => new Promise(() => undefined);

    renderSetup();

    expect(spinner()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
