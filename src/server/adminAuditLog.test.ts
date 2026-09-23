import { AdminAuditAction, buildAuditLogEntry } from "./adminAuditLog";

/**
 * `buildAuditLogEntry`'s construction, isolated from Prisma (SCRUM-541's
 * "unit: log-entry construction" testing requirement). The real-database
 * round trip through `updateUserPermission` lives in `admin.db.test.ts`.
 */
describe("buildAuditLogEntry", () => {
  it("carries the actor, action and target through unchanged", () => {
    const entry = buildAuditLogEntry({
      actorId: "actor-1",
      action: AdminAuditAction.UPDATE_USER_PERMISSION,
      targetId: "target-1",
    });

    expect(entry.actorId).toBe("actor-1");
    expect(entry.action).toBe("user.admin.updateUserPermission");
    expect(entry.targetId).toBe("target-1");
  });

  it("serializes metadata to a JSON string", () => {
    const entry = buildAuditLogEntry({
      actorId: "actor-1",
      action: AdminAuditAction.UPDATE_USER_PERMISSION,
      targetId: "target-1",
      metadata: { permission: "ADMIN" },
    });

    expect(entry.metadata).toBe(JSON.stringify({ permission: "ADMIN" }));
    // Guards against a JSON string that only looks right by construction.
    expect(JSON.parse(entry.metadata as string)).toEqual({
      permission: "ADMIN",
    });
  });

  it("stores null metadata rather than an empty string when none is given", () => {
    const entry = buildAuditLogEntry({
      actorId: "actor-1",
      action: AdminAuditAction.UPDATE_USER_PERMISSION,
      targetId: "target-1",
    });

    expect(entry.metadata).toBeNull();
  });
});
