import { FakeCommunityHost } from "../host/fakeHost";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import type { CommunityActor, Member } from "../actor";
import {
  ContentUnavailableError,
  HandleInvalidError,
  HandleTakenError,
  NotEligibleError,
  ProfileExistsError,
} from "../shared/errors";
import { ProfileService } from "./service";

const STUDENT: CommunityActor = { kind: "student", userId: "user-1" };
const OTHER_STUDENT: CommunityActor = { kind: "student", userId: "user-2" };

const build = () => {
  const profiles = new FakeProfileRepository();
  const host = new FakeCommunityHost()
    .withAccount("user-1")
    .withAccount("user-2");
  return { profiles, host, service: new ProfileService(profiles, host) };
};

describe("ProfileService.create", () => {
  it("claims a handle and returns only public fields", async () => {
    const { service } = build();

    const profile = await service.create(STUDENT, "HuskyCommuter");

    expect(profile).toEqual({
      handle: "HuskyCommuter",
      memberSince: "2026-10",
    });
    // The platform identity must not ride along.
    expect(Object.keys(profile)).not.toContain("userId");
  });

  it("refuses a handle already taken in a different casing", async () => {
    const { service } = build();
    await service.create(STUDENT, "Husky");

    await expect(service.create(OTHER_STUDENT, "HUSKY")).rejects.toThrow(
      HandleTakenError,
    );
  });

  it("refuses a second handle for the same user", async () => {
    const { service } = build();
    await service.create(STUDENT, "husky");

    // Still a `student` actor here — the caller re-submitted rather than
    // re-resolving — so the userId index is what catches it.
    await expect(service.create(STUDENT, "different")).rejects.toThrow(
      ProfileExistsError,
    );
  });

  it("refuses an actor who already resolved as a member", async () => {
    const { service } = build();
    const member: CommunityActor = {
      kind: "member",
      userId: "user-1",
      profile: { id: "p1", handle: "husky" },
    };

    await expect(service.create(member, "another")).rejects.toThrow(
      ProfileExistsError,
    );
  });

  it("validates the handle before doing any I/O", async () => {
    const { service, host } = build();

    await expect(service.create(STUDENT, "no spaces")).rejects.toThrow(
      HandleInvalidError,
    );
    // A pure refusal should not have cost a host round trip.
    expect(host.blockLookups).toBe(0);
  });

  it.each([
    ["an unknown account", { exists: false }, /not found/i],
    ["an un-onboarded account", { isOnboarded: false }, /setting up/i],
    [
      "an account that has not accepted terms",
      { termsAccepted: false },
      /terms/i,
    ],
  ])("refuses %s", async (_label, standing, expected) => {
    const profiles = new FakeProfileRepository();
    const host = new FakeCommunityHost().withAccount("user-1", standing);
    const service = new ProfileService(profiles, host);

    await expect(service.create(STUDENT, "husky")).rejects.toThrow(
      NotEligibleError,
    );
    await expect(service.create(STUDENT, "husky")).rejects.toThrow(expected);
    // Eligibility is the platform's answer, not Community's: nothing was stored.
    expect(await profiles.findByUserId("user-1")).toBeNull();
  });

  it("lets exactly one of two concurrent claims on one handle win", async () => {
    const { service } = build();

    const results = await Promise.allSettled([
      service.create(STUDENT, "husky"),
      service.create(OTHER_STUDENT, "husky"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      HandleTakenError,
    );
  });

  it("stamps dateCreated from the injected clock, not the wall clock", async () => {
    const { service, host } = build();
    host.setNow(new Date("2027-03-15T00:00:00.000Z"));

    expect((await service.create(STUDENT, "husky")).memberSince).toBe(
      "2027-03",
    );
  });
});

describe("ProfileService.me", () => {
  it("returns null before a handle is claimed", async () => {
    const { service } = build();
    expect(await service.me(STUDENT)).toBeNull();
  });

  it("returns the public profile once claimed", async () => {
    const { service } = build();
    await service.create(STUDENT, "husky");
    expect(await service.me(STUDENT)).toEqual({
      handle: "husky",
      memberSince: "2026-10",
    });
  });
});

describe("ProfileService.byHandle", () => {
  /**
   * A viewer who has claimed a handle, which is what the member tier means.
   *
   * Spelled out in every test here rather than hidden in `build()`, because
   * "the browser is as identifiable as the browsed" is the whole reason this
   * endpoint is member-only.
   */
  const VIEWER: Member = {
    kind: "member",
    userId: "user-2",
    profile: { id: "p2", handle: "viewer" },
  };

  it("resolves a handle through the same normalizer that claimed it", async () => {
    const { service } = build();
    await service.create(STUDENT, "Avery");

    // `Avery` and `avery` are one handle, because `handleNormalized` is what
    // carries uniqueness. A lookup that did not normalize would make them two.
    expect(await service.byHandle(VIEWER, "avery")).toEqual({
      handle: "Avery",
      memberSince: "2026-10",
    });
  });

  it("returns only public fields", async () => {
    const { service } = build();
    await service.create(STUDENT, "avery");

    const profile = await service.byHandle(VIEWER, "avery");

    expect(Object.keys(profile).sort()).toEqual(["handle", "memberSince"]);
  });

  it("refuses a handle nobody has claimed", async () => {
    const { service } = build();

    await expect(service.byHandle(VIEWER, "nobody")).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it.each([
    ["a handle with a space in it", "no spaces"],
    ["a reserved handle", "admin"],
    ["a handle past the column width", "x".repeat(25)],
  ])("refuses %s as absent rather than as invalid", async (_label, handle) => {
    const { service } = build();

    // **NOT_FOUND, not BAD_REQUEST.** Every stored handle passed this same
    // parser, so one that fails it cannot name a profile. Reporting it as a
    // validation error would be a second, distinguishable refusal.
    await expect(service.byHandle(VIEWER, handle)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a handle the viewer has a block with, identically to an absent one", async () => {
    const { service, host } = build();
    await service.create(STUDENT, "avery");
    host.withBlocksFor(VIEWER.userId, ["user-1"]);

    const blocked = await service.byHandle(VIEWER, "avery").catch((e) => e);
    const absent = await service.byHandle(VIEWER, "nobody").catch((e) => e);

    // Same class, same message. A reader who can tell these apart can probe
    // handles for the people they have blocks with (spec §7.2).
    expect(blocked).toBeInstanceOf(ContentUnavailableError);
    expect(blocked.message).toBe(absent.message);
  });

  it("resolves a viewer's own handle", async () => {
    const { service } = build();
    await service.create(STUDENT, "avery");
    const self: Member = {
      kind: "member",
      userId: "user-1",
      profile: { id: "p1", handle: "avery" },
    };

    expect((await service.byHandle(self, "avery")).handle).toBe("avery");
  });
});
