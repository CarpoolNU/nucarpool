import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import ExploreSidebar from "./ExploreSidebar";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, FiltersState, User } from "../../utils/types";
import { QueryState } from "../../utils/queryState";
import {
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * SCRUM-520: a successfully-sent connect request did not return mobile
 * Explore to the Recommendations tab. `curOption` lived only in
 * `ExploreSidebar`, and `SidebarContent.renderUserCard` never passed an
 * `onClose` into the `ConnectCard`s it builds for the Recommendations and
 * Favorites tabs - so nothing downstream of `ConnectModal` could reach it.
 *
 * The proxy used below is deliberate: `curOption` is private to
 * `ExploreSidebar`, so these tests distinguish "reset" from "not reset" by
 * which list backs the still-expanded mobile detail card. `favs` carries the
 * user being connected with; `recs` is empty. A reset to `"recommendations"`
 * therefore makes that person's card disappear - the list it is filtered from
 * became empty - which a real assertion on internal state could not fake.
 */

const mockCreateRequest = jest.fn();

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: {
        recommendations: { me: { invalidate: jest.fn() } },
        requests: { me: { invalidate: jest.fn() } },
      },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
      requests: {
        create: {
          useMutation: (options?: {
            onSuccess?: (request: { id: string }, variables: unknown) => void;
          }) => ({
            mutate: (variables: unknown) => {
              mockCreateRequest(variables);
              options?.onSuccess?.({ id: "request-1" }, variables);
            },
            isPending: false,
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
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

beforeEach(() => {
  mockCreateRequest.mockClear();
  setViewportWidth(MOBILE_WIDTH);
});

const OTHER_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  startCoordLng: -71.09,
  startCoordLat: 42.34,
  companyAddress: "2 Elsewhere Ave",
  companyCoordLng: -71.08,
  companyCoordLat: 42.35,
  daysWorking: "1,1,1,1,1,0,0",
  startTime: new Date("2026-01-05T13:00:00.000Z"),
  endTime: new Date("2026-01-05T22:00:00.000Z"),
  coopStartDate: new Date("2026-01-05T00:00:00.000Z"),
  coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
  carpoolId: null,
  isFavorited: true,
} as unknown as EnhancedPublicUser;

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

const BASE: FiltersState = {
  days: 0,
  flexDays: 1,
  startDistance: 20,
  endDistance: 20,
  daysWorking: "",
  startTime: 4,
  endTime: 4,
  startDate: new Date("2026-01-31T00:00:00.000Z"),
  endDate: new Date("2026-06-30T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: false,
};

const READY: QueryState = { status: "ready", retry: () => undefined };

/**
 * `mobileSelectedUser` is owned by `index.tsx` in the real app, so it has to
 * be a controlled prop here too - this harness is the smallest stand-in for
 * that state, not a stand-in for the fix under test.
 */
const Harness = () => {
  const [mobileSelectedUser, setMobileSelectedUser] = useState<string | null>(
    null,
  );
  return (
    <UserContext.Provider value={VIEWER}>
      <ExploreSidebar
        recs={[]}
        favs={[OTHER_USER]}
        recsState={READY}
        favsState={READY}
        setFilters={() => undefined}
        defaultFilters={BASE}
        setSort={() => undefined}
        sort="any"
        filters={BASE}
        disabled={false}
        viewRoute={() => undefined}
        onViewRequest={() => undefined}
        mobileSelectedUser={mobileSelectedUser}
        handleMobileExpand={(userId) => setMobileSelectedUser(userId ?? null)}
      />
    </UserContext.Provider>
  );
};

const openConnectModalFromFavorites = async () => {
  render(<Harness />);

  await userEvent.click(screen.getByRole("button", { name: "Favorites" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Show Riley's full details" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
};

describe("Explore tab after the connect flow closes", () => {
  it("returns to Recommendations once a request sent from Favorites is closed", async () => {
    await openConnectModalFromFavorites();

    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("heading", { name: "Your request has been sent!" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    // Still filtered to Riley's card by `mobileSelectedUser`, but the list it
    // is drawn from switched to the empty `recs` - proof `curOption` reset.
    expect(screen.queryByText("Riley")).not.toBeInTheDocument();
    expect(
      screen.getByText(/unable to find any recommendations/i),
    ).toBeInTheDocument();
  });

  it("leaves Favorites active when the modal is cancelled before sending", async () => {
    await openConnectModalFromFavorites();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockCreateRequest).not.toHaveBeenCalled();
    // Unaffected: Riley's card, from `favs`, is still the one on screen.
    expect(screen.getByText("Riley")).toBeInTheDocument();
  });
});
