import { isMember, isModerator, requireModerator } from "../../community/actor";
import { NotModeratorError } from "../../community/shared/errors";
import { resolveActor } from "./actorResolution";

const profile = { id: "p1", handle: "HuskyCommuter" };

describe("resolveActor", () => {
  it("is a student with no profile, whatever their permission", () => {
    const actor = resolveActor({ id: "user-1", permission: "ADMIN" }, null);
    expect(actor.kind).toBe("student");
    expect(isMember(actor)).toBe(false);
  });

  it("is a member with a profile and the ordinary permission", () => {
    const actor = resolveActor({ id: "user-1", permission: "USER" }, profile);
    expect(actor.kind).toBe("member");
    expect(isModerator(actor)).toBe(false);
  });

  it.each(["ADMIN", "MANAGER"] as const)(
    "is a moderator for %s",
    (permission) => {
      const actor = resolveActor({ id: "user-1", permission }, profile);
      expect(isModerator(actor)).toBe(true);
    },
  );

  it("carries only the handle, never the platform identity", () => {
    const actor = resolveActor({ id: "user-1", permission: "USER" }, profile);
    // The transport layer never sees `handleNormalized` or the join date:
    // `ProfileRef` is what the actor carries, and it holds what gets rendered.
    expect(isMember(actor) && actor.profile).toEqual({
      id: "p1",
      handle: "HuskyCommuter",
    });
  });
});

describe("requireModerator", () => {
  it("returns the actor when they are a moderator", () => {
    const actor = resolveActor({ id: "u1", permission: "ADMIN" }, profile);
    expect(requireModerator(actor)).toBe(actor);
  });

  it("refuses a member", () => {
    const actor = resolveActor({ id: "u1", permission: "USER" }, profile);
    expect(() => requireModerator(actor)).toThrow(NotModeratorError);
  });

  it("refuses a student, who has no handle at all", () => {
    const actor = resolveActor({ id: "u1", permission: "USER" }, null);
    expect(() => requireModerator(actor)).toThrow(NotModeratorError);
  });

  it("accepts a MANAGER, matching the platform's adminRouter predicate", () => {
    const actor = resolveActor({ id: "u1", permission: "MANAGER" }, profile);
    expect(requireModerator(actor)).toBe(actor);
  });
});
