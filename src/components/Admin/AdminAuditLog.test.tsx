import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminAuditLog from "./AdminAuditLog";

/**
 * The audit log's list view: `getAuditLog` rows resolved against `getAllUsers`,
 * the same query `UserManagement` already fetches — no denormalized email on
 * `AdminAuditLog` itself. Mocked onto a real React Query, following
 * `UserManagement.test.tsx`'s reasoning: a render-time spy cannot distinguish
 * "never subscribed" from "subscribed but not yet resolved".
 */

const auditLogQueryFn = jest.fn();
const usersQueryFn = jest.fn();

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getAuditLog": { query: () => auditLogQueryFn() },
    "user.admin.getAllUsers": { query: () => usersQueryFn() },
  }),
);

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
  });

  it("words the action and its metadata rather than printing either raw", async () => {
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
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("Permission changed")).toBeVisible();
    expect(screen.getByText("Set to ADMIN")).toBeVisible();
    expect(
      screen.queryByText("user.admin.updateUserPermission"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('{"permission":"ADMIN"}'),
    ).not.toBeInTheDocument();
  });

  it("labels a report target, which getAllUsers can never resolve", async () => {
    // `resolveReport` writes a *report* id as `targetId`, so resolving it
    // against the user map misses by construction — not because the user is
    // missing.
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "clx3k9a0b0000qwertyuiop12",
        metadata: JSON.stringify({ status: "REVIEWED" }),
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([
      {
        id: "manager-1",
        email: "manager@northeastern.edu",
        permission: "MANAGER",
      },
    ]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("Report …tyuiop12")).toBeVisible();
    expect(screen.getByText("Report resolved")).toBeVisible();
    expect(screen.getByText("Marked REVIEWED")).toBeVisible();
    expect(
      screen.queryByText("clx3k9a0b0000qwertyuiop12"),
    ).not.toBeInTheDocument();
  });

  it("keeps the full target id reachable through the cell's title", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: "clx3k9a0b0000qwertyuiop12",
        metadata: null,
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    expect(
      await screen.findByTitle("clx3k9a0b0000qwertyuiop12"),
    ).toHaveTextContent("Report …tyuiop12");
  });

  it("marks an unresolvable user target instead of printing a bare id", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "deleted-actor",
        action: "user.admin.updateUserPermission",
        targetId: "clx3k9a0b0000qwertyuiop12",
        metadata: null,
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("Unknown user (…tyuiop12)")).toBeVisible();
    // Actor is always a user, so it keeps the plain raw-id fallback.
    expect(screen.getByText("deleted-actor")).toBeVisible();
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
