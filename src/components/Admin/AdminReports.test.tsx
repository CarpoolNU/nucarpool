import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminReports from "./AdminReports";

/**
 * The report queue (SCRUM-555): `getReports` rows resolved against
 * `getAllUsers`, as `AdminAuditLog` does. Mocked onto a real React Query for
 * the reason `AdminAuditLog.test.tsx` gives.
 */

const reportsQueryFn = jest.fn();
const usersQueryFn = jest.fn();

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        admin: {
          getReports: {
            useInfiniteQuery: (input: unknown, options: object) =>
              reactQuery.useInfiniteQuery({
                queryKey: ["getReports", input],
                queryFn: () => reportsQueryFn(input),
                initialPageParam: undefined,
                ...options,
              }),
          },
          getAllUsers: {
            useQuery: (input: undefined, options: object) =>
              reactQuery.useQuery({
                queryKey: ["getAllUsers", input],
                queryFn: () => usersQueryFn(),
                ...options,
              }),
          },
        },
      },
    },
  };
});

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
  ...overrides,
});

/** One `getReports` page, the shape `useInfiniteQuery`'s `queryFn` resolves. */
const page = (
  reports: ReturnType<typeof report>[],
  nextCursor: string | null = null,
) => ({ reports, nextCursor });

beforeEach(() => {
  reportsQueryFn.mockReset();
  usersQueryFn.mockReset();
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

  it("loads another page on demand, rather than all at once (SCRUM-562)", async () => {
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
});
