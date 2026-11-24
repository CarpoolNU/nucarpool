import type { CommunityServices } from "../../community/composition";
import { BudgetService } from "../../community/budget/service";
import { CommentService, PostService } from "../../community/content/service";
import { FakeCommunityHost } from "../../community/host/fakeHost";
import {
  ProfileService,
  asProfileReader,
} from "../../community/identity/service";
import { FakeBudgetRepository } from "../../community/testing/fakeBudgetRepository";
import { FakeCommentRepository } from "../../community/testing/fakeCommentRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../../community/testing/fakeContentRepositories";
import { FakeProfileRepository } from "../../community/testing/fakeProfileRepository";
import type { Context } from "../context";
import { communityRouter } from "./index";

/**
 * The author tier and the budget, asserted on every procedure that changes
 * content somebody already wrote.
 *
 * **The list is derived from the router, not typed out.** Any procedure whose
 * last segment is `edit` or `delete` is one of these by construction, so a
 * fifth added later is in this list without anyone editing this file — and the
 * first test fails the moment it is, because `INPUTS` has no entry for it.
 * That is the same guard `moderationTier.test.ts` builds for the moderator
 * tier, and it exists for the same failure: a write procedure added without
 * the authorship check or without a budget is invisible until someone looks.
 *
 * **What it catches.** A procedure on the wrong tier (a student reaching it),
 * a missing authorship check (a non-author's edit succeeding), and — the one
 * the service tests cannot see — a write procedure that claims no budget.
 *
 * **What it does not.** Like the moderator tier's test, it cannot tell the
 * procedure-level guard from the service's own: `NOT_AUTHOR` arrives as
 * `FORBIDDEN` either way. A green run means the refusal happens, not which
 * layer refused.
 */
const AUTHOR_WRITE_PROCEDURES = Object.keys(
  communityRouter._def.procedures,
).filter((path) => /\.(edit|delete)$/.test(path));

/** One valid input per procedure, filled in with the fixture's real ids. */
const inputsFor = (
  postId: string,
  commentId: string,
): Record<string, unknown> => ({
  "posts.edit": { postId, title: "Edited title", content: "Edited body." },
  "posts.delete": { postId },
  "comments.edit": { commentId, content: "Edited reply." },
  "comments.delete": { commentId },
});

type Session = {
  id: string;
  /** Absent means no profile row, which is what makes someone a student. */
  handle?: string;
};

const AUTHOR_ID = "author-user";

/**
 * A fresh world per call: every procedure here is a mutation, so a shared one
 * would let the first case delete the row the next is given.
 *
 * The post and the comment are both authored by {@link AUTHOR_ID}, so a
 * session with that id is the author and any other session is not.
 */
const contextFor = async (session: Session) => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();
  const budgets = new BudgetService(new FakeBudgetRepository(), host);

  await profileRepo.insert({
    userId: AUTHOR_ID,
    handle: "GarageGuru",
    handleNormalized: "garageguru",
    dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  });
  if (session.handle && session.id !== AUTHOR_ID) {
    await profileRepo.insert({
      userId: session.id,
      handle: session.handle,
      handleNormalized: session.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const post = await posts.insert({
    authorId: AUTHOR_ID,
    categoryId: "cat-parking",
    title: "Parking deck rates",
    content: "Anyone know what the deck costs now?",
    dateCreated: new Date("2026-02-01T00:00:00.000Z"),
  });
  const comment = await comments.insert({
    postId: post.id,
    authorId: AUTHOR_ID,
    content: "It went up in September.",
    dateCreated: new Date("2026-02-02T00:00:00.000Z"),
  });

  const profiles = asProfileReader(profileRepo);
  const community: Pick<
    CommunityServices,
    "profiles" | "posts" | "comments" | "budgets"
  > = {
    profiles: new ProfileService(profileRepo, host),
    posts: new PostService(posts, categories, profiles, host),
    comments: new CommentService(comments, posts, profiles, host),
    budgets,
  };

  const ctx = {
    session: { user: { id: session.id, permission: "USER" } },
    community,
  } as unknown as Context;

  return {
    ctx,
    posts,
    comments,
    input: inputsFor(post.id, comment!.id),
  };
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

it("knows about every author-write procedure", async () => {
  const { input } = await contextFor({ id: AUTHOR_ID, handle: "GarageGuru" });

  expect([...AUTHOR_WRITE_PROCEDURES].sort()).toEqual([
    "comments.delete",
    "comments.edit",
    "posts.delete",
    "posts.edit",
  ]);
  for (const path of AUTHOR_WRITE_PROCEDURES) {
    expect(input).toHaveProperty([path]);
  }
});

describe.each(AUTHOR_WRITE_PROCEDURES)("%s", (path) => {
  it("admits the author", async () => {
    const { ctx, input } = await contextFor({
      id: AUTHOR_ID,
      handle: "GarageGuru",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(call(caller, path, input[path])).resolves.not.toThrow();
  });

  it("refuses another member with FORBIDDEN", async () => {
    const { ctx, input } = await contextFor({
      id: "other-member",
      handle: "Avery",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(call(caller, path, input[path])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a student with FORBIDDEN", async () => {
    // No handle, so `resolveActor` makes this a student and the member tier
    // refuses before the handler reads anything.
    const { ctx, input } = await contextFor({ id: "student-user" });
    const caller = communityRouter.createCaller(ctx);

    await expect(call(caller, path, input[path])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("leaves the content alone when it refuses", async () => {
    const { ctx, posts, comments, input } = await contextFor({
      id: "other-member",
      handle: "Avery",
    });
    const caller = communityRouter.createCaller(ctx);

    await expect(call(caller, path, input[path])).rejects.toThrow();

    const post = posts.rows[0]!;
    const comment = comments.rows[0]!;
    expect(post.title).toBe("Parking deck rates");
    expect(post.deletedAt).toBeNull();
    expect(comment.content).toBe("It went up in September.");
    expect(comment.deletedAt).toBeNull();
  });

  /**
   * **The one thing no service test can see.** A budget lives in middleware, so
   * a write procedure that forgot to claim one would pass every test in
   * `content/` and be silently unbounded. Spending the bucket and expecting
   * TOO_MANY_REQUESTS is what makes `budgetedMember` observable from here.
   *
   * It spends the bucket with the *same* procedure under test rather than a
   * known-budgeted one, so it holds whichever action that procedure draws from
   * and does not need to know which.
   */
  it("claims a budget", async () => {
    const { ctx, input } = await contextFor({
      id: AUTHOR_ID,
      handle: "GarageGuru",
    });
    const caller = communityRouter.createCaller(ctx);

    // Every edit/delete bucket is 60 an hour; the first call succeeds and the
    // rest refuse on domain grounds, which still charges (SCRUM-686).
    for (let i = 0; i < 60; i++) {
      await call(caller, path, input[path]).catch(() => undefined);
    }

    await expect(call(caller, path, input[path])).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});
