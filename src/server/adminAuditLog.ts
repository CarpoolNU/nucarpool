import { Prisma } from "@prisma/client";

/**
 * Every admin/manager mutation this codebase logs, named by the tRPC
 * procedure path that performs it. A string rather than a Prisma enum: a new
 * admin mutation (the account-suspension action this ticket's Jira issue
 * mentions) can start writing here without a schema change, which is the
 * whole point of SCRUM-541 covering "any future admin mutation".
 */
export const AdminAuditAction = {
  UPDATE_USER_PERMISSION: "user.admin.updateUserPermission",
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
