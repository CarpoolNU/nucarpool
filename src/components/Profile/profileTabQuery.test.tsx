/**
 * `/profile` must open on the tab `?tab=` names.
 *
 * The page initialised its tab to "user" unconditionally, so the one button
 * `InactiveBlocker` offers a deactivated user landed them two tabs from the
 * status toggle. SCRUM-667.
 *
 * **The real page and the real sidebar.** Only the three section bodies are
 * stubbed, each to a marker, so what is asserted is which tab the page chose
 * and not a prop passed to a fake. `ProfileSidebar` is real because it is
 * what renders `aria-pressed` and because its two arms carry *different*
 * labels - "Account" on mobile, "Account Status" on desktop - and the defect
 * was reported on mobile. Running both viewports is therefore the check, not
 * thoroughness for its own sake.
 *
 * Not co-located under `src/pages/`, because a test file there is also a
 * route.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";
import { routerState } from "../../testing/nextRouterStub";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.me": { query: async () => VIEWER_USER },
    "user.edit": { mutation: async () => ({}) },
    "user.recommendations.me": {},
    "mapbox.geoJsonUserList": {},
  }),
);

jest.mock("../../utils/mixpanel", () => ({
  trackProfileCompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/profile/useRemoveProfilePicture", () => ({
  useRemoveProfilePicture: () => ({ removeProfilePicture: jest.fn() }),
}));
jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: { center: [0, 0], street: "", city: "", state: "" },
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));
jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => null,
}));

// One marker per section, so the assertion reads the page's choice rather
// than a prop handed to a fake.
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
jest.mock("../../components/Profile/BlockedUsersSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/ReportsFiledSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/SafetySection", () => ({
  __esModule: true,
  default: () => null,
}));

import Profile from "../../pages/profile/index";

/**
 * A VIEWER with null co-op dates, so `planCoopRangeNotice` returns null and
 * cannot move the tab. The one test that *wants* the notice sets its own
 * dates; everywhere else this keeps the query the only thing choosing.
 */
const VIEWER_USER = {
  role: "VIEWER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "INACTIVE",
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: "Sam",
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
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: {} },
        })
      }
    >
      <Profile />
    </QueryClientProvider>,
  );

/** `useRouter()` hands back one object all suite, so this is visible next render. */
const setQuery = (query: Record<string, string | string[]>) => {
  routerState().query = query;
};

restoreViewportAfterEach();

beforeEach(() => {
  jest.clearAllMocks();
  setQuery({});
  setViewportWidth(DESKTOP_WIDTH);
});

const viewports = [
  ["mobile", MOBILE_WIDTH],
  ["desktop", DESKTOP_WIDTH],
] as const;

describe("the tab the page opens on", () => {
  it.each(viewports)(
    "is the Account tab on %s when the URL asks for it",
    async (_name, width) => {
      setViewportWidth(width);
      setQuery({ tab: "account" });

      renderProfile();

      expect(await screen.findByText("account section")).toBeInTheDocument();
      expect(screen.queryByText("user section")).not.toBeInTheDocument();
    },
  );

  it("is the Carpool tab when the URL asks for that instead", async () => {
    // Guards against a fix that special-cases "account" rather than reading
    // the parameter - that would pass every assertion above and still leave
    // the page undeep-linkable.
    setQuery({ tab: "carpool" });

    renderProfile();

    expect(await screen.findByText("carpool section")).toBeInTheDocument();
    expect(screen.queryByText("user section")).not.toBeInTheDocument();
  });

  it.each(viewports)(
    "is unchanged on %s for a bare /profile",
    async (_name, width) => {
      setViewportWidth(width);

      renderProfile();

      expect(await screen.findByText("user section")).toBeInTheDocument();
      expect(screen.queryByText("account section")).not.toBeInTheDocument();
    },
  );

  it("falls back to the default for a tab name that does not exist", async () => {
    setQuery({ tab: "../../etc/passwd" });

    renderProfile();

    expect(await screen.findByText("user section")).toBeInTheDocument();
  });

  it("falls back to the default for a repeated parameter", async () => {
    setQuery({ tab: ["account", "carpool"] });

    renderProfile();

    expect(await screen.findByText("user section")).toBeInTheDocument();
  });
});

describe("the sidebar", () => {
  /**
   * The control for the Account tab, and proof of which arm drew it.
   *
   * Without the exact-name assertion the two `it.each` rows would be the same
   * test run twice: if `useIsMobile` did not see the width, both would render
   * the desktop arm and both would pass. The labels are the one thing that
   * differs - "Account" on mobile, "Account Status" on desktop - so checking
   * them is the positive control that the mobile row is really mobile.
   */
  const accountControlOn = async (name: "mobile" | "desktop") => {
    const control = await screen.findByRole("button", { name: /^Account/ });
    expect(control).toHaveAccessibleName(
      name === "mobile" ? "Account" : "Account Status",
    );
    return control;
  };

  it.each(viewports)(
    "marks the Account control pressed on %s, so the tab is visibly selected",
    async (name, width) => {
      setViewportWidth(width);
      setQuery({ tab: "account" });

      renderProfile();

      const account = await accountControlOn(name);
      await waitFor(() =>
        expect(account).toHaveAttribute("aria-pressed", "true"),
      );
    },
  );

  it.each(viewports)(
    "leaves it unpressed on %s for a bare /profile",
    async (name, width) => {
      setViewportWidth(width);

      renderProfile();

      const account = await accountControlOn(name);
      expect(account).toHaveAttribute("aria-pressed", "false");
    },
  );
});
