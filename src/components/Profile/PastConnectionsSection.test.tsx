import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import PastConnectionsSection from "./PastConnectionsSection";
import { BLOCK_GROUP_MEMBER_MESSAGE } from "../../server/router/user/blocks";
import { PAIRING_RETENTION_MONTHS } from "../../server/db/carpoolPairing";
import { toastSpies } from "../../testing/toastStub";

/**
 * The profile's past-carpools list (SCRUM-623).
 *
 * This is the only surface from which someone can be reported or blocked
 * after the connection has ended - every other entry point to
 * `UserActionsMenu` needs a live card or a live conversation, and a parting
 * destroys both. So what this file pins is mostly that the row survives the
 * things that could silently remove it:
 *
 *   - every query state reads as itself, and a failure is not an empty list;
 *   - a refused block leaves the row, and the menu, exactly where they were;
 *   - so does a failed report.
 *
 * The real `UserActionsMenu` is rendered rather than a stand-in, because the
 * refusal path runs through its mutation options and a stand-in would prove
 * nothing about it. Its own behaviour is pinned in `UserActionsMenu.test.tsx`;
 * what is new here is that this list keeps its row when that behaviour fails.
 */

type Entry = { userId: string; name: string; endedAt: Date };

const mockQuery: {
  isPending: boolean;
  isError: boolean;
  data: Entry[] | undefined;
  refetch: jest.Mock;
} = { isPending: false, isError: false, data: [], refetch: jest.fn() };

const mockBlock = jest.fn();
const mockReport = jest.fn();
const mockBlockOptions: {
  onSuccess?: () => Promise<void>;
  onError?: (error: { message: string }) => void;
} = {};
const mockReportOptions: {
  onSuccess?: (data: unknown) => void | Promise<void>;
  onError?: (error: { message: string }) => void;
} = {};
const mockInvalidate = jest.fn();

jest.mock("../../utils/trpc", () => {
  const invalidatable = () => ({ invalidate: mockInvalidate });
  return {
    trpc: {
      useUtils: () => ({
        user: {
          blocks: { me: invalidatable() },
          recommendations: { me: invalidatable() },
          favorites: { me: invalidatable() },
          requests: { me: invalidatable() },
          messages: {
            getUnreadMessageCount: invalidatable(),
            conversation: invalidatable(),
          },
        },
        mapbox: { geoJsonUserList: invalidatable() },
      }),
      user: {
        carpoolPairings: {
          me: { useQuery: () => mockQuery },
        },
        blocks: {
          block: {
            useMutation: (options: typeof mockBlockOptions) => {
              Object.assign(mockBlockOptions, options);
              return { mutate: mockBlock, isPending: false };
            },
          },
        },
        reports: {
          create: {
            useMutation: (options: typeof mockReportOptions) => {
              Object.assign(mockReportOptions, options);
              return { mutate: mockReport, isPending: false };
            },
          },
        },
      },
    },
  };
});

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);
const mockToast = toastSpies();

// `MenuItems anchor` positions through Floating UI, which observes the
// trigger once the menu opens. jsdom does no layout, so an inert stand-in is
// enough - the same one `UserActionsMenu.test.tsx` installs.
(global as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/*
 * Fixed instants, midday UTC, as `BlockedUsersSection.test.tsx` uses: the
 * rendered date is asserted and `format` is local-time, so midday keeps the
 * calendar day the same in both timezones CI runs under.
 */
const TAYLOR = {
  userId: "user-taylor",
  name: "Taylor",
  endedAt: new Date("2026-03-04T12:00:00.000Z"),
};
const JORDAN = {
  userId: "user-jordan",
  name: "Jordan",
  endedAt: new Date("2025-11-19T12:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockQuery, { isPending: false, isError: false, data: [] });
});

const openMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(
    screen.getByRole("button", { name: `More actions for ${name}` }),
  );
};

describe("PastConnectionsSection", () => {
  it("says so when there are no past carpools", () => {
    render(<PastConnectionsSection />);

    expect(
      screen.getByRole("heading", { name: "People You've Carpooled With" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You haven't finished a carpool yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("reports a failed load as a failure with a retry, not as an empty list", async () => {
    Object.assign(mockQuery, { isError: true, data: undefined });
    render(<PastConnectionsSection />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText("You haven't finished a carpool yet."),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(mockQuery.refetch).toHaveBeenCalled();
  });

  it("lists each former groupmate with the date and their own actions menu", async () => {
    mockQuery.data = [TAYLOR, JORDAN];
    render(<PastConnectionsSection />);

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "TaylorCarpooled until Mar 04 2026",
      "JordanCarpooled until Nov 19 2025",
    ]);

    expect(
      screen.getByRole("button", { name: "More actions for Taylor" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for Jordan" }),
    ).toBeInTheDocument();
  });

  /*
   * The machine-readable instant, asserted separately from the visible text:
   * the two carry different things, and `superjson` means `endedAt` arrives as
   * a real `Date` rather than a string to reparse.
   */
  it("carries the end date as a machine-readable instant", () => {
    mockQuery.data = [TAYLOR];
    render(<PastConnectionsSection />);

    expect(
      within(screen.getByRole("listitem")).getByText(/^Carpooled until/),
    ).toHaveAttribute("datetime", TAYLOR.endedAt.toISOString());
  });

  it("offers Report and Block for a former groupmate", async () => {
    mockQuery.data = [TAYLOR];
    render(<PastConnectionsSection />);
    const user = userEvent.setup();

    await openMenu(user, "Taylor");

    expect(
      await screen.findByRole("menuitem", { name: "Report" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Block" })).toBeInTheDocument();
  });

  /**
   * A past connection can also be a *current* groupmate: two people carpool,
   * part, and later form a new group. `applyBlock` refuses that with
   * `BLOCK_GROUP_MEMBER_MESSAGE`, and the refusal must not cost the reader the
   * row - they may still want to report, and the list is a record of history
   * rather than of who is currently blockable.
   */
  it("keeps the row and the menu when a block is refused", async () => {
    mockQuery.data = [TAYLOR];
    render(<PastConnectionsSection />);
    const user = userEvent.setup();

    await openMenu(user, "Taylor");
    await user.click(await screen.findByRole("menuitem", { name: "Block" }));
    // Scoped to the dialog: its confirm button is labelled "Block" too, and
    // the heading is what distinguishes the two.
    const dialog = await screen.findByRole("dialog", {
      name: "Block Taylor?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Block" }));

    act(() => {
      mockBlockOptions.onError?.({ message: BLOCK_GROUP_MEMBER_MESSAGE });
    });

    expect(mockToast.error).toHaveBeenCalledWith(BLOCK_GROUP_MEMBER_MESSAGE);
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "More actions for Taylor" }),
    ).toBeInTheDocument();
  });

  /**
   * The note quotes the retention window as a number of months, and the
   * component hardcodes it rather than importing `PAIRING_RETENTION_MONTHS` -
   * that module pulls `@prisma/client` in for `Role`, which has no business
   * in a client bundle. The constant is imported *here* instead, where the
   * bundle does not matter, so a change to the retention policy fails this
   * test rather than quietly leaving the screen telling users the wrong
   * number.
   */
  it("quotes the retention window the server actually applies", () => {
    render(<PastConnectionsSection />);

    expect(
      screen.getByText(
        new RegExp(`in the last ${PAIRING_RETENTION_MONTHS} months`),
      ),
    ).toBeInTheDocument();
  });

  it("keeps the row when a report fails", async () => {
    mockQuery.data = [TAYLOR, JORDAN];
    render(<PastConnectionsSection />);

    act(() => {
      mockReportOptions.onError?.({ message: "Something went wrong." });
    });

    await waitFor(() =>
      expect(
        within(screen.getByRole("list")).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
  });
});
