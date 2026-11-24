import type { CommunityServices } from "../../community/composition";
import { ContentTargets } from "../../community/content/targets";
import { FakeCommunityHost } from "../../community/host/fakeHost";
import {
  ProfileService,
  asProfileReader,
} from "../../community/identity/service";
import { ModerationService } from "../../community/moderation/service";
import { FakeCommentRepository } from "../../community/testing/fakeCommentRepository";
import { FakePostRepository } from "../../community/testing/fakeContentRepositories";
import { FakeProfileRepository } from "../../community/testing/fakeProfileRepository";
import { FakeReportRepository } from "../../community/testing/fakeReportRepository";
import type { Context } from "../context";
import { communityRouter } from "./index";

/**
 * The moderator tier, asserted on every moderation procedure.
 *
 * **A loop rather than a representative test, and that is the point.**
 * `MODERATION_PROCEDURES` is read off the router itself, so a procedure added
 * under `moderation.` later is in this list without anyone editing this file —
 * and the first test below fails the moment it is, because `inputs` has no
 * entry for it. Someone adding a moderation procedure and forgetting to guard
 * it is the failure this exists for: with a hand-picked pair of procedures the
 * third would sail through unchecked, and with the derived list it cannot be
 * added without this file being told. That is what turns `describe.each` from
 * a convenience into a guard.
 *
 * The test is not "does the guard work", which `actorResolution.test.ts` and
 * the service tests already answer. It is "is the guard on this procedure".
 *
 * **What it catches, and what it does not.** It catches a moderation procedure
 * added to the router and not to this file (the first test), and any procedure
 * whose observable outcome for a member or a student is not `FORBIDDEN`. It
 * does not catch removal of the procedure-level guard while the service's own
 * `requireModerator` remains, because both refuse with the same `FORBIDDEN`:
 * a green run means the tier holds, not that it holds at the transport layer
 * specifically. That is defence in depth working, and pinning which layer
 * refuses would mean asserting on tRPC middleware internals. This was measured
 * rather than inferred: swapping `moderation.queue` to
 * `communityStudentProcedure` left every test here green.
 */
const MODERATION_PROCEDURES = Object.keys(
  communityRouter._def.procedures,
).filter((path) => path.startsWith("moderation."));

/**
 * One valid input per procedure, built from the report the fixture filed.
 *
 * **`review` is given that report's real id, not a literal.** The fake
 * repository mints its own ids, so a made-up one would make a moderator's call
 * fail with `ContentUnavailableError` — which "admits a moderator" would then
 * read as a refusal by the tier, the exact inverse of what it checks.
 */
const inputsFor = (reportId: string): Record<string, unknown> => ({
  "moderation.queue": {},
  "moderation.review": { reportId, action: "DISMISS" },
  "moderation.identify": { reportId },
});

type Session = {
  id: string;
  permission: "USER" | "ADMIN" | "MANAGER";
  /** Absent means no profile row, which is what makes someone a student. */
  handle?: string;
};

/**
 * A fresh world per call, because `review` is a mutation: sharing one would
 * let the first moderator case resolve the report the next one is given.
 */
const contextFor = async (session: Session) => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const contentTargets = new ContentTargets(posts, comments);
  const reports = new FakeReportRepository();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  const author = await profileRepo.insert({
    userId: "author-user",
    handle: "GarageGuru",
    handleNormalized: "garageguru",
    dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  });
  if (session.handle) {
    await profileRepo.insert({
      userId: session.id,
      handle: session.handle,
      handleNormalized: session.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const post = await posts.insert({
    authorId: author.userId,
    categoryId: "cat-parking",
    title: "Parking deck rates",
    content: "Anyone know what the deck costs now?",
    dateCreated: new Date("2026-02-01T00:00:00.000Z"),
  });
  await reports.upsert({
    reporterId: "reporter-user",
    reportedUserId: author.userId,
    targetType: "POST",
    targetId: post.id,
    reason: "SPAM",
    message: null,
    contentSnapshot: "snapshot",
    dateCreated: new Date("2026-10-09T12:00:00.000Z"),
  });

  // Only what the moderation procedures reach: the tier reads `profiles`, the
  // handlers read `moderation`. The composition root takes a Prisma store, so
  // this wires the same services over the fakes instead.
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
    session: { user: { id: session.id, permission: session.permission } },
    community,
  } as unknown as Context;

  return { ctx, reportId: reports.rows[0]!.id };
};

/** Calls a procedure by its dotted path, which is all the loop has. */
const call = (
  caller: unknown,
  path: string,
  input: unknown,
): Promise<unknown> => {
  const fn = path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      caller,
    );
  return (fn as (input: unknown) => Promise<unknown>)(input);
};

it("knows about every moderation procedure", async () => {
  const { reportId } = await contextFor({ id: "u", permission: "USER" });

  expect([...MODERATION_PROCEDURES].sort()).toEqual([
    "moderation.identify",
    "moderation.queue",
    "moderation.review",
  ]);
  for (const path of MODERATION_PROCEDURES) {
    expect(inputsFor(reportId)).toHaveProperty([path]);
  }
});

describe.each(MODERATION_PROCEDURES)("%s", (path) => {
  it("refuses a member with FORBIDDEN", async () => {
    const { ctx, reportId } = await contextFor({
      id: "member-user",
      permission: "USER",
      handle: "Avery",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(
      call(caller, path, inputsFor(reportId)[path]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a student with FORBIDDEN", async () => {
    // No handle, so `resolveActor` makes this a student whatever the permission.
    const { ctx, reportId } = await contextFor({
      id: "student-user",
      permission: "USER",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(
      call(caller, path, inputsFor(reportId)[path]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  /**
   * **The one refusal that names a remedy, because this one has one.**
   * `resolveActor` yields a moderator only for someone who already has a
   * profile, so an admin who has not claimed a handle arrives as a `student`
   * and is refused — correctly, but with "Only moderators can do that.", which
   * is false to the one person it is shown to. They *are* a moderator by the
   * platform's predicate and are one handle away from being able to act.
   *
   * It stays `FORBIDDEN`. Only the sentence changes, so nothing about the tier
   * or the retry policy moves; a member, who has a handle and still may not
   * moderate, keeps the refusal that names the rule, since for them there is
   * no step to take.
   */
  it("tells an admin with no handle what the missing step is", async () => {
    const { ctx, reportId } = await contextFor({
      id: "handleless-admin",
      permission: "ADMIN",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(
      call(caller, path, inputsFor(reportId)[path]),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Claim a community handle before moderating.",
    });
  });

  it("admits a moderator", async () => {
    // A platform permission *and* a handle: either alone is not a moderator.
    const { ctx, reportId } = await contextFor({
      id: "moderator-user",
      permission: "ADMIN",
      handle: "Morgan",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(
      call(caller, path, inputsFor(reportId)[path]),
    ).resolves.toBeDefined();
  });
});
