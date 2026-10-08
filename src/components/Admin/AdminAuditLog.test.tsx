import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminAuditLog from "./AdminAuditLog";

/**
 * The audit log's list view: `getAuditLog` rows resolved against `getAllUsers`,
 * the same query `UserManagement` already fetches — no denormalized email on
 * `AdminAuditLog` itself. Mocked onto a real React Query, following
 * `UserManagement.test.tsx`'s reasoning: a render-time spy cannot distinguish
 * "never subscribed" from "subscribed but not yet resolved".
 *
 * Every row fixture carries `targetUserId`, because the real `getAuditLog`
 * always does — `null` where the target is a user already.
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

/** A report id and a reported user id, distinguishable by their last 8. */
const REPORT_ID = "clx3k9a0b0000qwertyuiop12";
const REPORTED_USER_ID = "clx3k9a0b0000asdfghjkl345";

const MANAGER = {
  id: "manager-1",
  email: "manager@northeastern.edu",
  permission: "MANAGER",
};

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
        targetUserId: null,
        metadata: JSON.stringify({ permission: "ADMIN" }),
        dateCreated: new Date(2026, 8, 1, 10, 30),
      },
    ]);
    usersQueryFn.mockResolvedValue([
      MANAGER,
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
        targetUserId: null,
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

  it("names the reported user on a report-resolution row", async () => {
    // SCRUM-653: `resolveReport` writes a *report* id as `targetId`, so the
    // person the row is about reaches the client as `targetUserId`. Target
    // names them; the report id moves to Details.
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: REPORT_ID,
        targetUserId: REPORTED_USER_ID,
        metadata: JSON.stringify({ status: "REVIEWED" }),
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([
      MANAGER,
      {
        id: REPORTED_USER_ID,
        email: "reported@northeastern.edu",
        permission: "USER",
      },
    ]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("reported@northeastern.edu")).toBeVisible();
    expect(screen.getByText("Report resolved")).toBeVisible();
    expect(
      screen.getByText("Marked REVIEWED · report …tyuiop12"),
    ).toBeVisible();
    // Neither id is printed in full anywhere in the row's text.
    expect(screen.queryByText(REPORT_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(REPORTED_USER_ID)).not.toBeInTheDocument();
  });

  it("keeps the full report id reachable through the details cell's title", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: REPORT_ID,
        targetUserId: REPORTED_USER_ID,
        metadata: JSON.stringify({ status: "DISMISSED" }),
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([
      {
        id: REPORTED_USER_ID,
        email: "reported@northeastern.edu",
        permission: "USER",
      },
    ]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByTitle(REPORT_ID)).toHaveTextContent(
      "Marked DISMISSED · report …tyuiop12",
    );
  });

  it("marks a reported user getAllUsers cannot name, by their own id", async () => {
    // A deleted or email-less account. The report still names them, so the
    // cell says which user it cannot resolve rather than naming the report.
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: REPORT_ID,
        targetUserId: REPORTED_USER_ID,
        metadata: JSON.stringify({ status: "REVIEWED" }),
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([MANAGER]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("Unknown user (…ghjkl345)")).toBeVisible();
    // The report is still identified, so the row remains traceable.
    expect(
      screen.getByText("Marked REVIEWED · report …tyuiop12"),
    ).toBeVisible();
  });

  it("falls back to the report id when no report survives under the target", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "manager-1",
        action: "user.admin.resolveReport",
        targetId: REPORT_ID,
        targetUserId: null,
        metadata: null,
        dateCreated: new Date(2026, 8, 1),
      },
    ]);
    usersQueryFn.mockResolvedValue([MANAGER]);

    render(withClient(<AdminAuditLog />));

    expect(await screen.findByText("Report …tyuiop12")).toBeVisible();
    expect(screen.queryByText(REPORT_ID)).not.toBeInTheDocument();
  });

  it("marks an unresolvable user target instead of printing a bare id", async () => {
    auditLogQueryFn.mockResolvedValue([
      {
        id: "log-1",
        actorId: "deleted-actor",
        action: "user.admin.updateUserPermission",
        targetId: REPORT_ID,
        targetUserId: null,
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
