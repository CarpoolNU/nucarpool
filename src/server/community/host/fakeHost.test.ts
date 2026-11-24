import { FakeCommunityHost } from "./fakeHost";

describe("FakeCommunityHost moderation members", () => {
  it("records every moderator action in order", async () => {
    const host = new FakeCommunityHost();
    await host.recordModeratorAction({
      moderatorId: "m1",
      action: "community.moderation.queue",
      targetId: "OPEN",
    });
    await host.recordModeratorAction({
      moderatorId: "m1",
      action: "community.moderation.review",
      targetId: "r1",
    });
    expect(host.auditEntries.map((e) => e.targetId)).toEqual(["OPEN", "r1"]);
  });

  it("resolves only the identities it was given, and audits the resolution", async () => {
    const host = new FakeCommunityHost().withIdentity("u1", {
      name: "Avery",
      email: "a@northeastern.edu",
    });
    const resolved = await host.resolvePlatformIdentities("m1", ["u1", "u2"]);
    expect(resolved.get("u1")).toEqual({
      userId: "u1",
      name: "Avery",
      email: "a@northeastern.edu",
    });
    expect(resolved.has("u2")).toBe(false);
    expect(host.auditEntries).toHaveLength(1);
    expect(host.auditEntries[0]).toMatchObject({
      moderatorId: "m1",
      action: "community.moderation.identify",
    });
  });

  it("keeps the resolved ids auditable in metadata, with a bounded targetId", async () => {
    const host = new FakeCommunityHost();
    // Far more ids than fit in a VARCHAR(191) target column when joined.
    const userIds = Array.from(
      { length: 20 },
      (_, i) => `ckxxxxxxxxxxxxxxxxxxxxxx${i}`,
    );
    await host.resolvePlatformIdentities("m1", userIds);
    expect(host.auditEntries).toHaveLength(1);
    const [entry] = host.auditEntries;
    expect(entry?.metadata).toEqual({ userIds });
    expect(entry?.targetId).toBe("m1");
    expect(entry?.targetId.length).toBeLessThanOrEqual(191);
  });
});
