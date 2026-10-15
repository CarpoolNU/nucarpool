import { Prisma } from "@prisma/client";

/**
 * Every admin/manager mutation this codebase logs, named by the tRPC
 * procedure path that performs it. A string rather than a Prisma enum: a new
 * admin mutation (the account-suspension action this ticket's Jira issue
 * mentions) can start writing here without a schema change, which is the
 * whole point of this file covering "any future admin mutation".
 *
 * `SET_USER_TO_VIEWER` is the first action to take that offer up, and SCRUM-679
 * cost no schema change because of it.
 */
export const AdminAuditAction = {
  UPDATE_USER_PERMISSION: "user.admin.updateUserPermission",
  RESOLVE_REPORT: "user.admin.resolveReport",
  /**
   * A manager dropping someone's `CarpoolSearch.role` to `VIEWER`, which takes
   * them out of matching. Its metadata carries `previousRole` as well as the
   * new one, and that is not redundant: the target can set their own role back
   * from the profile form, so once they do, this row is the only surviving
   * evidence of what the role was when the manager acted. See SCRUM-619 for the
   * locked version that would make this a real suspension.
   */
  SET_USER_TO_VIEWER: "user.admin.setUserToViewer",
} as const;

export type AdminAuditAction =
  (typeof AdminAuditAction)[keyof typeof AdminAuditAction];

export type AdminAuditLogInput = {
  /** `ctx.session.user.id` of the admin/manager who performed the action. */
  actorId: string;
  action: AdminAuditAction;
  /** The id of whatever the action was performed on — a user today. */
  targetId: string;
  /** Action-specific detail. Serialized to JSON; omitted when there is none. */
  metadata?: Record<string, unknown>;
};

/**
 * The pure half of writing an audit entry: turns the caller's intent into the
 * exact `AdminAuditLog` row to create, with no database access, so its shape
 * can be unit-tested without a real or mocked Prisma client.
 */
export const buildAuditLogEntry = (
  input: AdminAuditLogInput,
): Prisma.AdminAuditLogUncheckedCreateInput => ({
  actorId: input.actorId,
  action: input.action,
  targetId: input.targetId,
  metadata: input.metadata ? JSON.stringify(input.metadata) : null,
});
