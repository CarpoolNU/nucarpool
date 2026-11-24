import superjson from "superjson";
import type { Member } from "../../community/actor";
import type { CommunityServices } from "../../community/composition";
import { ContentTargets } from "../../community/content/targets";
import { FakeCommunityHost } from "../../community/host/fakeHost";
import {
  ProfileService,
  asProfileReader,
} from "../../community/identity/service";
import {
  ModerationService,
  ReportService,
} from "../../community/moderation/service";
import { FakeCommentRepository } from "../../community/testing/fakeCommentRepository";
import { FakePostRepository } from "../../community/testing/fakeContentRepositories";
import { FakeProfileRepository } from "../../community/testing/fakeProfileRepository";
import { FakeReportRepository } from "../../community/testing/fakeReportRepository";
import type { Context } from "../context";
import { communityRouter } from "./index";

/**
 * What the moderation queue puts on the wire.
 *
 * **This asserts on the serialized payload, not on the type**, for the reason
 * `profileWireShape.test.ts` gives: `QueuedReport` having no user ids is the
 * §13.1 mechanism, but a type is exactly what a future change widens quietly.
 * Serializing through `superjson`, the transformer `createRouter.ts` installs,
 * and walking the result is the assertion that cannot be satisfied by accident.
 *
 * The queue is the one surface in this module whose whole purpose is
 * privileged reading: a moderator is sent here precisely to look at what other
 * people reported. That makes it the one where a leaked id is a map from a
 * public handle to a real Northeastern account — and the stored report carries
 * both ends of that map, the reporter's id and the reported user's. The
 * service reads the full row, so nothing but `toQueuedReport` stands between
 * those ids and the moderator's browser.
 */

const REPORTER: Member = {
  kind: "member",
  userId: "nucarpool-user-id-reporter",
  profile: { id: "profile-row-reporter", handle: "Reporter" },
};
const AUTHOR: Member = {
  kind: "member",
  userId: "nucarpool-user-id-author",
  profile: { id: "profile-row-author", handle: "GarageGuru" },
};
const MODERATOR = {
  userId: "nucarpool-user-id-moderator",
  handle: "Morgan",
};

/**
 * Every string that must never reach a client, whatever key it hides under.
 * Both ends of the report: the person who filed it and the person it is about.
 */
const FORBIDDEN_VALUES = [REPORTER.userId, AUTHOR.userId];

/** Every key name that must never appear, whatever it happens to hold. */
const FORBIDDEN_KEYS = [
  "authorId",
  "author_id",
  "userId",
  "user_id",
  "reporterId",
  "reporter_id",
  "reportedUserId",
  "reported_user_id",
  "reviewedById",
  "email",
  "name",
  "handleNormalized",
  "handle_normalized",
];

/** Collects every key and every string leaf in a serialized payload. */
const walk = (
  value: unknown,
  keys: string[] = [],
  strings: string[] = [],
): { keys: string[]; strings: string[] } => {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, strings);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      walk(item, keys, strings);
    }
  }
  return { keys, strings };
};

const onTheWire = (payload: unknown) =>
  walk(JSON.parse(JSON.stringify(superjson.serialize(payload))));

const build = async () => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const contentTargets = new ContentTargets(posts, comments);
  const reports = new FakeReportRepository();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const [userId, handle] of [
    [AUTHOR.userId, AUTHOR.profile.handle],
    [REPORTER.userId, REPORTER.profile.handle],
    [MODERATOR.userId, MODERATOR.handle],
  ] as const) {
    host.withAccount(userId);
    // **Both ends get a resolvable account on purpose.** A test where only the
    // author can be unmasked would pass whether or not the service asked for
    // the reporter as well; giving the reporter a name and an email is what
    // makes its absence below evidence rather than a coincidence.
    host.withIdentity(userId, {
      name: `${handle} RealName`,
      email: `${handle.toLowerCase()}@northeastern.edu`,
    });
    await profileRepo.insert({
      userId,
      handle,
      handleNormalized: handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const post = await posts.insert({
    authorId: AUTHOR.userId,
    categoryId: "cat-parking",
    title: "Parking deck rates",
    content: "Anyone know what the deck costs now?",
    dateCreated: new Date("2026-02-01T00:00:00.000Z"),
  });

  // Filed through the service, so the stored row is the one a real report
  // produces rather than one the test shaped.
  await new ReportService(reports, contentTargets, contentTargets, host).create(
    REPORTER,
    { targetType: "POST", targetId: post.id, reason: "SPAM" },
  );

  const community: Pick<CommunityServices, "profiles" | "moderation"> = {
    profiles: new ProfileService(profileRepo, host),
    moderation: new ModerationService(
      reports,
      contentTargets,
      asProfileReader(profileRepo),
      host,
    ),
  };
  const ctx = {
    session: { user: { id: MODERATOR.userId, permission: "ADMIN" } },
    community,
  } as unknown as Context;

  return { caller: communityRouter.createCaller(ctx), reports };
};

const IDENTITY_OF = (handle: string) => ({
  name: `${handle} RealName`,
  email: `${handle.toLowerCase()}@northeastern.edu`,
});

describe("the moderation queue on the wire", () => {
  it("serializes a report with no reporter and no user id on either end", async () => {
    const { caller, reports } = await build();

    const page = await caller.moderation.queue({});
    const { keys, strings } = onTheWire(page);

    // The stored row does carry both ids, and the queue is not empty, or this
    // would assert nothing at all.
    expect(reports.rows[0]).toMatchObject({
      reporterId: REPORTER.userId,
      reportedUserId: AUTHOR.userId,
    });
    expect(page.reports).toHaveLength(1);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(strings).not.toContain(forbidden);
    }
  });

  /**
   * The filter is a second route to the same serializer, and a narrowed query
   * is exactly the kind of change that gets a bespoke mapping written for it.
   * This asserts the narrowed page goes through `toQueuedReport` like the
   * wide one.
   */
  it("leaks nothing on a queue narrowed to the urgent reports", async () => {
    const { caller, reports } = await build();
    await reports.upsert({
      reporterId: REPORTER.userId,
      reportedUserId: AUTHOR.userId,
      targetType: "POST",
      targetId: "post-002",
      reason: "SAFETY_CONCERN",
      message: null,
      contentSnapshot: "snapshot",
      dateCreated: new Date("2026-03-01T00:00:00.000Z"),
    });

    const page = await caller.moderation.queue({ urgentOnly: true });
    const { keys, strings } = onTheWire(page);

    expect(page.reports).toHaveLength(1);
    expect(page.reports[0]!.urgent).toBe(true);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(strings).not.toContain(forbidden);
    }
  });

  it("puts the reported handle on the wire, which is the one identity a moderator gets", async () => {
    const { caller } = await build();

    const { strings } = onTheWire(await caller.moderation.queue({}));

    expect(strings).toContain(AUTHOR.profile.handle);
    expect(strings).not.toContain(REPORTER.profile.handle);
  });
});

/**
 * What `moderation.identify` puts on the wire.
 *
 * **This is the inverse of the suite above, and both are needed.** The queue
 * asserts that identity never crosses; this asserts that it crosses in exactly
 * one direction, for exactly one person. A boundary stated only as "no names
 * anywhere" would be contradicted by this procedure existing at all, so the
 * rule it actually encodes has to be written down as a pair: the reported
 * party is resolvable from a report, and the reporter is resolvable by nobody.
 *
 * **The reporter has a name and an email in this fixture.** That is what makes
 * the absence below an assertion rather than a tautology: `ReportService`
 * filed the report, so the stored row carries `reporterId`, the host can
 * resolve it, and the only thing keeping it off this payload is what the
 * service chooses to publish.
 *
 * **What this catches is a leak into the response, and not a leak to the
 * host.** Measured rather than assumed: making `identify` ask the host for
 * both ids leaves both tests here green, because the second identity is
 * resolved and then dropped. The test that fails on that mutation is
 * `ModerationService.identify`'s "asks the host for the reported user and
 * nobody else", which reads the disclosure entry the port writes. The two are
 * a pair — this one pins what is published, that one pins what is looked up at
 * all — and neither alone is the claim that unmasking reaches one person.
 */
describe("moderation.identify on the wire", () => {
  it("resolves the reported party's real name and email", async () => {
    const { caller, reports } = await build();

    const result = await caller.moderation.identify({
      reportId: reports.rows[0]!.id,
    });

    expect(result.account).toEqual({
      userId: AUTHOR.userId,
      ...IDENTITY_OF(AUTHOR.profile.handle),
    });
  });

  it("carries nothing of the reporter — not an id, a handle, a name or an email", async () => {
    const { caller, reports } = await build();

    // The stored row knows who filed it, and that person is resolvable, or
    // this test would hold whatever the service did.
    expect(reports.rows[0]).toMatchObject({ reporterId: REPORTER.userId });

    const payload = await caller.moderation.identify({
      reportId: reports.rows[0]!.id,
    });
    const { strings } = onTheWire(payload);

    for (const forbidden of [
      REPORTER.userId,
      REPORTER.profile.handle,
      IDENTITY_OF(REPORTER.profile.handle).name,
      IDENTITY_OF(REPORTER.profile.handle).email,
    ]) {
      expect(strings).not.toContain(forbidden);
    }
  });
});
