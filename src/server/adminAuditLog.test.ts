import {
  AdminAuditAction,
  buildAuditLogEntry,
  writeAuditLog,
} from "./adminAuditLog";

/**
 * `writeAuditLog` is the single writer every audit row goes through: the
 * admin mutations and Community's moderation actions alike (SCRUM-742).
 */
describe("writeAuditLog", () => {
  it("creates exactly the row buildAuditLogEntry describes", async () => {
    const create = jest.fn(async () => ({}));
    const input = {
      actorId: "actor-1",
      action: AdminAuditAction.RESOLVE_REPORT,
      targetId: "report-1",
      metadata: { status: "RESOLVED" },
    };

    await writeAuditLog({ adminAuditLog: { create } } as never, input);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: buildAuditLogEntry(input) });
  });

  it("rejects when the write fails, so a transaction around it rolls back", async () => {
    const create = jest.fn(async () => {
      throw new Error("db down");
    });

    await expect(
      writeAuditLog({ adminAuditLog: { create } } as never, {
        actorId: "actor-1",
        action: AdminAuditAction.UPDATE_USER_PERMISSION,
        targetId: "user-1",
      }),
    ).rejects.toThrow("db down");
  });
});

/**
 * `buildAuditLogEntry`'s construction, isolated from Prisma (the
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
