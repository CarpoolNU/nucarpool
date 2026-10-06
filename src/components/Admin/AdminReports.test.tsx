import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminReports from "./AdminReports";

/**
 * The report queue: `getReports` rows resolved against
 * `getAllUsers`, as `AdminAuditLog` does. Mocked onto a real React Query for
 * the reason `AdminAuditLog.test.tsx` gives.
 */

const reportsQueryFn = jest.fn();
const usersQueryFn = jest.fn();
const resolveReportMutationFn = jest.fn();
const invalidateReports = jest.fn();

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getReports": {
      infiniteQuery: (input: unknown) => reportsQueryFn(input),
      invalidate: () => invalidateReports(),
    },
    "user.admin.getAllUsers": { query: () => usersQueryFn() },
    "user.admin.resolveReport": {
      mutation: (input: unknown) => resolveReportMutationFn(input),
    },
  }),
);

const withClient = (node: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {node}
  </QueryClientProvider>
);

const USERS = [
  { id: "reporter-1", email: "reporter@northeastern.edu", permission: "USER" },
  { id: "reported-1", email: "reported@northeastern.edu", permission: "USER" },
];

const report = (overrides: Record<string, unknown> = {}) => ({
  id: "report-1",
  reporterId: "reporter-1",
  reportedUserId: "reported-1",
  reason: "HARASSMENT",
  message: null,
  requestId: null,
  conversationSnapshot: null,
  status: "OPEN",
  dateCreated: new Date(2026, 8, 1, 10, 30),
  // How many reports concern `reportedUserId`. The row is always in its own
  // group, so one is the floor rather than zero.
  reportsAboutUser: 1,
  ...overrides,
});

/**
 * One `getReports` page, the shape `useInfiniteQuery`'s `queryFn` resolves.
 *
 * `countedStatus` is the scope `reportsAboutUser` was counted over, and the
 * component titles the column from it rather than from its own filter state.
 */
const page = (
  reports: ReturnType<typeof report>[],
  nextCursor: string | null = null,
  countedStatus: string | null = "OPEN",
) => ({ reports, nextCursor, countedStatus });

beforeEach(() => {
  reportsQueryFn.mockReset();
  usersQueryFn.mockReset();
  resolveReportMutationFn.mockReset();
  invalidateReports.mockReset();
});

describe("AdminReports", () => {
  it("names both users by email and the reason by its label", async () => {
    reportsQueryFn.mockResolvedValue(page([report()]));
    usersQueryFn.mockResolvedValue(USERS);

    render(withClient(<AdminReports />));

    expect(await screen.findByText("reporter@northeastern.edu")).toBeVisible();
    expect(screen.getByText("reported@northeastern.edu")).toBeVisible();
    expect(screen.getByText("Harassment")).toBeVisible();
    expect(screen.getByText("OPEN")).toBeVisible();
  });

  it("keeps the snapshot folded until opened, labelling who said what", async () => {
    reportsQueryFn.mockResolvedValue(
      page([
        report({
          requestId: "req-1",
          conversationSnapshot: [
            {
              senderId: "reporter-1",
              content: "Please stop.",
              sentAt: new Date(2026, 8, 1, 9, 0),
            },
            {
              senderId: "reported-1",
              content: "No.",
              sentAt: new Date(2026, 8, 1, 9, 1),
            },
          ],
        }),
      ]),
    );
    usersQueryFn.mockResolvedValue(USERS);
    const user = userEvent.setup();

    render(withClient(<AdminReports />));

    const summary = await screen.findByText("Conversation (2 messages)");
    expect(screen.getByText(/Please stop\./)).not.toBeVisible();

    await user.click(summary);

    const lines = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(lines.map((line) => line.textContent)).toEqual([
      "Reporter Sep 01 2026 09:00: Please stop.",
      "Reported Sep 01 2026 09:01: No.",
    ]);
  });

  it("renders markup in stored text as characters, never as elements", async () => {
    const payload = '<img src="x" onerror="alert(1)">';
    reportsQueryFn.mockResolvedValue(
      page([
        report({
          message: payload,
          conversationSnapshot: [
            {
              senderId: "reported-1",
              content: payload,
              sentAt: new Date(2026, 8, 1, 9, 0),
            },
          ],
        }),
      ]),
    );
    usersQueryFn.mockResolvedValue(USERS);

    const { container } = render(withClient(<AdminReports />));

    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows no conversation for a report made from a card", async () => {
    reportsQueryFn.mockResolvedValue(
      page([report({ message: "Rude at pickup." })]),
    );
    usersQueryFn.mockResolvedValue(USERS);

    render(withClient(<AdminReports />));

    expect(await screen.findByText("Rude at pickup.")).toBeVisible();
    expect(screen.queryByText(/^Conversation/)).not.toBeInTheDocument();
  });

  it("shows an empty-state message rather than a blank table", async () => {
    reportsQueryFn.mockResolvedValue(page([]));
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminReports />));

    expect(await screen.findByText("No reports yet.")).toBeVisible();
  });

  it("shows the error state when the reports fail to load", async () => {
    reportsQueryFn.mockRejectedValue(new Error("network error"));
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminReports />));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeVisible();
    });
  });

  it("loads another page on demand, rather than all at once", async () => {
    reportsQueryFn.mockResolvedValueOnce(
      page([report({ id: "report-1" })], "report-1"),
    );
    usersQueryFn.mockResolvedValue(USERS);
    const user = userEvent.setup();

    render(withClient(<AdminReports />));

    expect(await screen.findByText("Load more")).toBeVisible();
    expect(reportsQueryFn).toHaveBeenCalledTimes(1);

    reportsQueryFn.mockResolvedValueOnce(page([report({ id: "report-2" })]));
    await user.click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.queryByText("Load more")).not.toBeInTheDocument();
    });
    expect(reportsQueryFn).toHaveBeenCalledTimes(2);
  });

  it("re-queries when the status filter changes, defaulting to Open", async () => {
    reportsQueryFn.mockResolvedValue(page([report()]));
    usersQueryFn.mockResolvedValue(USERS);
    const user = userEvent.setup();

    render(withClient(<AdminReports />));
    await screen.findByText("reporter@northeastern.edu");

    expect(reportsQueryFn).toHaveBeenLastCalledWith({ status: "OPEN" });

    await user.click(screen.getByText("Dismissed"));

    await waitFor(() => {
      expect(reportsQueryFn).toHaveBeenLastCalledWith({
        status: "DISMISSED",
      });
    });
  });

  it("resolves an OPEN report as Reviewed and refreshes the queue", async () => {
    reportsQueryFn.mockResolvedValue(page([report()]));
    usersQueryFn.mockResolvedValue(USERS);
    resolveReportMutationFn.mockResolvedValue({
      id: "report-1",
      status: "REVIEWED",
    });
    const user = userEvent.setup();

    render(withClient(<AdminReports />));
    await screen.findByText("reporter@northeastern.edu");

    await user.click(screen.getByText("Mark reviewed"));

    await waitFor(() => {
      expect(resolveReportMutationFn).toHaveBeenCalledWith({
        reportId: "report-1",
        status: "REVIEWED",
      });
    });
    await waitFor(() => {
      expect(invalidateReports).toHaveBeenCalled();
    });
  });

  it("dismisses an OPEN report", async () => {
    reportsQueryFn.mockResolvedValue(page([report()]));
    usersQueryFn.mockResolvedValue(USERS);
    resolveReportMutationFn.mockResolvedValue({
      id: "report-1",
      status: "DISMISSED",
    });
    const user = userEvent.setup();

    render(withClient(<AdminReports />));
    await screen.findByText("reporter@northeastern.edu");

    await user.click(screen.getByText("Dismiss"));

    await waitFor(() => {
      expect(resolveReportMutationFn).toHaveBeenCalledWith({
        reportId: "report-1",
        status: "DISMISSED",
      });
    });
  });

  it("shows no resolve actions for a report that is already resolved", async () => {
    reportsQueryFn.mockResolvedValue(page([report({ status: "REVIEWED" })]));
    usersQueryFn.mockResolvedValue(USERS);

    render(withClient(<AdminReports />));

    await screen.findByText("reporter@northeastern.edu");
    expect(screen.queryByText("Mark reviewed")).not.toBeInTheDocument();
    expect(screen.queryByText("Dismiss")).not.toBeInTheDocument();
  });

  /**
   * The per-user count, and the heading that says what it counted.
   *
   * A number without its scope is worse than no number: "three open reports
   * about this person" and "three reports ever, two already dismissed" call
   * for different things from an admin. The heading is driven by the page's
   * own `countedStatus`, so these assert the pairing and not just the digit.
   */
  describe("the per-reported-user count", () => {
    it("shows the count and titles the column with the status it covers", async () => {
      reportsQueryFn.mockResolvedValue(
        page([report({ reportsAboutUser: 3 })], null, "OPEN"),
      );
      usersQueryFn.mockResolvedValue(USERS);

      render(withClient(<AdminReports />));

      expect(
        await screen.findByRole("columnheader", {
          name: "Open reports about them",
        }),
      ).toBeVisible();
      const row = screen.getByText("reported@northeastern.edu").closest("tr");
      expect(within(row as HTMLElement).getByText("3")).toBeVisible();
    });

    it("says so explicitly when the count covers every status", async () => {
      reportsQueryFn.mockResolvedValue(
        page([report({ reportsAboutUser: 4 })], null, null),
      );
      usersQueryFn.mockResolvedValue(USERS);

      render(withClient(<AdminReports />));

      expect(
        await screen.findByRole("columnheader", {
          name: "Reports about them (all statuses)",
        }),
      ).toBeVisible();
      // The control for the test above: the open-only heading is absent, so
      // that one is not passing on a heading this component always renders.
      expect(
        screen.queryByRole("columnheader", {
          name: "Open reports about them",
        }),
      ).not.toBeInTheDocument();
    });

    it("names the resolved slice when a resolved status is being viewed", async () => {
      reportsQueryFn.mockResolvedValue(
        page(
          [report({ status: "REVIEWED", reportsAboutUser: 2 })],
          null,
          "REVIEWED",
        ),
      );
      usersQueryFn.mockResolvedValue(USERS);

      render(withClient(<AdminReports />));

      expect(
        await screen.findByRole("columnheader", {
          name: "Reviewed reports about them",
        }),
      ).toBeVisible();
    });

    it("emphasises a repeat subject and leaves a single report plain", async () => {
      reportsQueryFn.mockResolvedValue(
        page([
          report({ id: "report-1", reportsAboutUser: 1 }),
          report({
            id: "report-2",
            reportedUserId: "reported-2",
            reportsAboutUser: 5,
          }),
        ]),
      );
      usersQueryFn.mockResolvedValue([
        ...USERS,
        {
          id: "reported-2",
          email: "repeat@northeastern.edu",
          permission: "USER",
        },
      ]);

      render(withClient(<AdminReports />));

      await screen.findByText("repeat@northeastern.edu");
      // The cell rather than its text, because the styling is the signal
      // here: a bold 5 beside a plain 1 is what an admin scanning the queue
      // actually reads.
      expect(screen.getByText("5").closest("td")).toHaveClass("font-bold");
      expect(screen.getByText("1").closest("td")).not.toHaveClass("font-bold");
    });
  });
});
