/**
 * On desktop, a `?tab=` in the URL must not override the Explore and
 * Requests buttons.
 *
 * `pages/index.tsx` passes `data` as an object literal, a new object every
 * render, and the mobile nav navigates to `/?tab=requests` - so a tablet
 * rotated across `md` or a window resized past it can arrive on desktop with
 * the param still set. This guards that a desktop click still wins.
 *
 * `Harness` reproduces the caller's shape exactly: it owns the sidebar state
 * and passes `data` as a fresh literal on each render, which is exactly the
 * shape this test needs to exercise. The router mock is one stable object, as
 * Next's is between route changes, so a re-run can only come from `data`.
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
import { routerState } from "../testing/nextRouterStub";

jest.mock("next/router", () =>
  require("../testing/nextRouterStub").buildRouterMock(),
);

/*
 * Set per test before render. `useRouter()` hands back one object for the
 * whole suite, so assigning to `query` on it is visible to the next render.
 */
const setTabQuery = (query: Record<string, string>) => {
  routerState().query = query;
};

/**
 * Both queries `Header`'s tree reaches at these viewports, declared
 * `inertQuery` - a literal result, no fetch, no state machine.
 *
 * That is the right fidelity here and not a shortcut. What this file measures
 * is how many times an effect re-ran, so any query that resolved would be
 * adding renders to the thing being counted. `inertQuery` is stable by
 * construction, which leaves `data` as the only moving part - exactly the
 * variable this test exercises.
 *
 * `realTimeQueryOptions` is exported because `Header` imports it by name
 * alongside `trpc` and spreads it into the unread-count query.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock(
    {
      "user.messages.getUnreadMessageCount": { inertQuery: true },
      "user.getPresignedDownloadUrl": { inertQuery: true },
    },
    { realTimeQueryOptions: {} },
  ),
);

jest.mock("../utils/messages/useUnreadNotifications", () => ({
  useUnreadNotifications: () => undefined,
}));

jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock({
    status: "unauthenticated",
  }),
);

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
  setTabQuery({});
});

describe("Header on desktop with ?tab= in the URL", () => {
  it("keeps Explore when it is clicked", () => {
    setTabQuery({ tab: "requests" });
    render(<Harness initial="explore" />);

    fireEvent.click(desktopTab("Explore"));

    expect(sidebar()).toHaveTextContent("explore");
  });

  /**
   * The param is still honoured on arrival - a fix that simply stopped reading
   * it would pass the case above and fail this one.
   */
  it("control: opens on the tab the URL names", () => {
    setTabQuery({ tab: "requests" });
    render(<Harness initial="explore" />);

    expect(sidebar()).toHaveTextContent("requests");
  });

  it("control: without the param, clicking Explore works", () => {
    render(<Harness initial="requests" />);

    fireEvent.click(desktopTab("Explore"));

    expect(sidebar()).toHaveTextContent("explore");
  });
});
