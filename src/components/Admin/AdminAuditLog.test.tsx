import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminAuditLog from "./AdminAuditLog";

/**
 * SCRUM-541's list view: `getAuditLog` rows resolved against `getAllUsers`,
 * the same query `UserManagement` already fetches — no denormalized email on
 * `AdminAuditLog` itself. Mocked onto a real React Query, following
 * `UserManagement.test.tsx`'s reasoning: a render-time spy cannot distinguish
 * "never subscribed" from "subscribed but not yet resolved".
 */

const auditLogQueryFn = jest.fn();
const usersQueryFn = jest.fn();

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        admin: {
          getAuditLog: {
            useQuery: (input: undefined, options: object) =>
              reactQuery.useQuery({
                queryKey: ["getAuditLog", input],
                queryFn: () => auditLogQueryFn(),
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

beforeEach(() => {
  auditLogQueryFn.mockReset();
  usersQueryFn.mockReset();
});

describe("AdminAuditLog", () => {
  it("resolves actor and target ids to the emails getAllUsers already carries", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.updateUserPermission",
        targetId: "user-2",
        metadata: JSON.stringify({ permission: "ADMIN" }),
        dateCreated: new Date(2026, 8, 1, 10, 30),
      },
    ]);
    usersQueryFn.mockResolvedValue([
      {
        id: "manager-1",
        email: "manager@northeastern.edu",
        permission: "MANAGER",
      },
      { id: "user-2", email: "target@northeastern.edu", permission: "ADMIN" },
    ]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("manager@northeastern.edu")).toBeVisible();
    expect(screen.getByText("target@northeastern.edu")).toBeVisible();
    expect(screen.getByText("user.admin.updateUserPermission")).toBeVisible();
  });

  it("falls back to the raw id when getAllUsers has no match", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "deleted-actor",
        action: "user.admin.updateUserPermission",
        targetId: "user-2",
        metadata: null,
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("deleted-actor")).toBeVisible();
  });

  it("shows an empty-state message rather than a blank table", async () => {
    auditLogQueryFn.mockResolvedValue([]);
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    expect(
      await screen.findByText("No admin actions recorded yet."),
    ).toBeVisible();
  });

  it("shows the error state when the audit log fails to load", async () => {
    auditLogQueryFn.mockRejectedValue(new Error("network error"));
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeVisible();
    });
  });
});
