/**
 * SCRUM-561 item 4: on desktop, a `?tab=` in the URL must not override the
 * Explore and Requests buttons.
 *
 * The effect applying `router.query.tab` listed `props.data` among its
 * dependencies, and `pages/index.tsx` passes `data` as an object literal - a
 * new object every render. So the effect re-ran on every render, and the
 * render that a desktop tab click caused put the URL's tab straight back. The
 * mobile nav navigates to `/?tab=requests`, so a tablet rotated across `md` or
 * a window resized past it arrived on desktop with the param set, and Explore
 * then did nothing.
 *
 * `Harness` reproduces the caller's shape exactly: it owns the sidebar state
 * and passes `data` as a fresh literal on each render, which is the whole
 * precondition of the defect. The router mock is one stable object, as Next's
 * is between route changes, so a re-run can only come from `data`.
 */

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import Header, { HeaderOptions } from "./Header";
import { UserContext } from "../utils/userContext";
import { User } from "../utils/types";
import {
  DESKTOP_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

/** Set per test before render; the router object itself never changes. */
let mockQuery: Record<string, string> = {};
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  pathname: "/",
  get query() {
    return mockQuery;
  },
};

jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}));

jest.mock("../utils/trpc", () => ({
  trpc: {
    user: {
      messages: {
        getUnreadMessageCount: { useQuery: () => ({ data: undefined }) },
      },
      groups: { me: { useQuery: () => ({ data: undefined }) } },
      me: { useQuery: () => ({ data: undefined }) },
      getPresignedDownloadUrl: {
        useQuery: () => ({ data: undefined, error: null, isLoading: false }),
      },
    },
  },
}));

jest.mock("../utils/messages/useUnreadNotifications", () => ({
  useUnreadNotifications: () => undefined,
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signOut: jest.fn(),
}));

restoreViewportAfterEach();

const USER = {
  id: "user-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  permission: "USER",
  preferredName: "Sam",
} as unknown as User;

/** `pages/index.tsx`'s shape: its own state, and `data` as a new literal. */
const Harness = ({ initial }: { initial: HeaderOptions }) => {
  const [sidebarType, setSidebarType] = useState<HeaderOptions>(initial);
  return (
    <UserContext.Provider value={USER}>
      <Header
        data={{
          sidebarValue: sidebarType,
          setSidebar: setSidebarType,
          disabled: false,
        }}
        onViewGroupRoute={() => undefined}
      />
      <output data-testid="sidebar">{sidebarType}</output>
    </UserContext.Provider>
  );
};

const sidebar = () => screen.getByTestId("sidebar");
const desktopTab = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  setViewportWidth(DESKTOP_WIDTH);
  mockQuery = {};
});

describe("Header on desktop with ?tab= in the URL", () => {
  it("keeps Explore when it is clicked", () => {
    mockQuery = { tab: "requests" };
    render(<Harness initial="explore" />);

    fireEvent.click(desktopTab("Explore"));

    expect(sidebar()).toHaveTextContent("explore");
  });

  /**
   * The param is still honoured on arrival - a fix that simply stopped reading
   * it would pass the case above and fail this one.
   */
  it("control: opens on the tab the URL names", () => {
    mockQuery = { tab: "requests" };
    render(<Harness initial="explore" />);

    expect(sidebar()).toHaveTextContent("requests");
  });

  it("control: without the param, clicking Explore works", () => {
    render(<Harness initial="requests" />);

    fireEvent.click(desktopTab("Explore"));

    expect(sidebar()).toHaveTextContent("explore");
  });
});
