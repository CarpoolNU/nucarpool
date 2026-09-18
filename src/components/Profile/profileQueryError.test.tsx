/**
 * SCRUM-509: that a failed `user.me` on `/profile` says so.
 *
 * The guard was `if (isLoading || !user)`, returning a `fixed inset-0 z-50`
 * white overlay with a spinner in it, and it returns *before* `Header` - so on
 * a failure the overlay was the entire page, with no navigation to leave by.
 * `isError` went unread, so `data` stayed undefined behind it for good. `/`
 * had already fixed exactly this, and its comment records the bug: "a failed
 * `user.me` used to leave `data` undefined behind this spinner forever". The
 * fix was never carried across to either profile route.
 *
 * `user.me` throws `UNAUTHORIZED` on a lapsed session and `NOT_FOUND` with no
 * `User` row; both are in `NON_RETRYABLE_CODES`, so React Query errors at once
 * rather than retrying, and there is no error boundary in `_app.tsx`.
 *
 * **The real page, not a reproduction of its shape** - `Header` and the three
 * sections are stubbed to markers, as `AdminPage.test.tsx` stubs its page's
 * children, because the subject is one guard and rendering the real tree would
 * put it behind a presigned-URL query and the profile-picture cropper. Not
 * co-located, because a test file under `src/pages/` is also a route.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    events: { on: jest.fn(), off: jest.fn() },
  }),
}));
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
  trackProfileCompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: jest.fn(),
  useEditUserMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));
jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: null,
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));

jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => <header>PROFILE HEADER</header>,
}));
jest.mock("../../components/Profile/UserSection", () => ({
  __esModule: true,
  default: () => <div>user section</div>,
}));
jest.mock("../../components/Profile/CarpoolSection", () => ({
  __esModule: true,
  default: () => <div>carpool section</div>,
}));
jest.mock("../../components/Profile/AccountSection", () => ({
  __esModule: true,
  default: () => <div>account section</div>,
}));

import Profile from "../../pages/profile/index";

/** The fields the page's effects read before rendering a section. */
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

const renderProfile = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Profile />
    </QueryClientProvider>,
  );

const spinner = () => screen.queryByText("Loading...");

beforeEach(() => {
  queryFn.mockClear();
  behaviour = async () => BASE_USER;
});

describe("/profile when user.me fails", () => {
  it("renders the error treatment instead of a permanent overlay", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderProfile();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load your profile.");

    // The defect itself: the overlay spinner used to stay for the session.
    expect(spinner()).not.toBeInTheDocument();
  });

  it("recovers the page when retry is pressed and the session is back", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderProfile();
    await screen.findByRole("alert");

    behaviour = async () => BASE_USER;

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });

    await waitFor(() =>
      expect(screen.getByText("PROFILE HEADER")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  /**
   * The control, and the mutation test for the two cases above: a page
   * rendering `QueryError` unconditionally passes both and fails this.
   */
  it("control: a resolving query renders the page and no error", async () => {
    renderProfile();

    await waitFor(() =>
      expect(screen.getByText("PROFILE HEADER")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(spinner()).not.toBeInTheDocument();
  });

  it("control: shows the spinner while user.me is still in flight", () => {
    behaviour = () => new Promise(() => undefined);

    renderProfile();

    expect(spinner()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
