import type { Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import { FakeCommentRepository } from "../testing/fakeCommentRepository";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import {
  ContentUnavailableError,
  NotAuthorError,
  TextEmptyError,
  TextTooLongError,
} from "../shared/errors";
import { COMMENT_CONTENT_MAX_LENGTH } from "./domain/textLimits";
import { CommentService } from "./service";

const AUTHOR: Member = {
  kind: "member",
  userId: "user-1",
  profile: { id: "p1", handle: "HuskyCommuter" },
};
const REPLIER: Member = {
  kind: "member",
  userId: "user-2",
  profile: { id: "p2", handle: "Parker" },
};

const AT = (iso: string) => new Date(iso);

const build = async () => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AUTHOR, REPLIER]) {
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: AT("2026-01-01T00:00:00.000Z"),
    });
  }

  const post = await posts.insert({
    authorId: AUTHOR.userId,
    categoryId: "cat-parking",
    title: "Best lot near ISEC?",
    content: "Under $10 a day ideally.",
    dateCreated: AT("2026-02-01T00:00:00.000Z"),
  });

  const service = new CommentService(
    comments,
    posts,
    asProfileReader(profileRepo),
    host,
  );

  const comment = await service.create(REPLIER, {
    postId: post.id,
    content: "Columbus garage, $7 with the student rate.",
  });

  return { posts, comments, host, post, comment, service };
};

describe("CommentService.edit", () => {
  it("rewrites the body and marks the comment edited", async () => {
    const { service, host, comment } = await build();
    host.setNow(AT("2026-02-02T09:30:00.000Z"));

    const edited = await service.edit(REPLIER, {
      commentId: comment.id,
      content: "Columbus garage — $7 with the student rate, cash only.",
    });

    expect(edited.content).toBe(
      "Columbus garage — $7 with the student rate, cash only.",
    );
    expect(edited.edited).toBe(true);
  });

  it("keeps the comment's place in the thread", async () => {
    const { service, comments, host, comment } = await build();
    const createdAt = comments.rowFor(comment.id).dateCreated;
    host.setNow(AT("2026-03-09T18:00:00.000Z"));

    await service.edit(REPLIER, {
      commentId: comment.id,
      content: "Reworded, same slot.",
    });

    // Ordering is `(postId, dateCreated, id)`, so an edit that moved
    // `dateCreated` would silently reshuffle the thread around it.
    expect(comments.rowFor(comment.id).dateCreated).toEqual(createdAt);
    expect(comments.rowFor(comment.id).editedAt).toEqual(
      AT("2026-03-09T18:00:00.000Z"),
    );
  });

  it("refuses an edit by anyone but the author", async () => {
    const { service, comments, comment } = await build();

    await expect(
      service.edit(AUTHOR, { commentId: comment.id, content: "Not mine." }),
    ).rejects.toThrow(NotAuthorError);

    expect(comments.rowFor(comment.id).content).toBe(
      "Columbus garage, $7 with the student rate.",
    );
  });

  it("refuses an edit to a moderator-hidden comment", async () => {
    const { service, comments, comment } = await build();
    await comments.hide(comment.id, AT("2026-02-03T00:00:00.000Z"));

    await expect(
      service.edit(REPLIER, {
        commentId: comment.id,
        content: "Editing my way out of a hide.",
      }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses an edit when the parent post has been hidden", async () => {
    const { service, posts, post, comment } = await build();
    await posts.hide(post.id, AT("2026-02-03T00:00:00.000Z"));

    await expect(
      service.edit(REPLIER, { commentId: comment.id, content: "Still here?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("bounds the body", async () => {
    const { service, comment } = await build();

    await expect(
      service.edit(REPLIER, {
        commentId: comment.id,
        content: "x".repeat(COMMENT_CONTENT_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(TextTooLongError);
  });

  it("refuses a body edited down to nothing", async () => {
    const { service, comment } = await build();

    await expect(
      service.edit(REPLIER, { commentId: comment.id, content: "  " }),
    ).rejects.toThrow(TextEmptyError);
  });

  it("refuses an unknown comment id", async () => {
    const { service } = await build();

    await expect(
      service.edit(REPLIER, { commentId: "comment-nope", content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });
});

describe("CommentService.delete", () => {
  it("soft-deletes the author's own comment and keeps the row", async () => {
    const { service, comments, host, comment } = await build();
    host.setNow(AT("2026-02-04T12:00:00.000Z"));

    await service.delete(REPLIER, { commentId: comment.id });

    expect(comments.rowFor(comment.id).deletedAt).toEqual(
      AT("2026-02-04T12:00:00.000Z"),
    );
    expect(comments.rowFor(comment.id).hiddenAt).toBeNull();
  });

  it("decrements the post's commentCount, so the count matches the thread", async () => {
    const { service, posts, post, comment } = await build();
    expect(posts.rowFor(post.id).commentCount).toBe(1);

    await service.delete(REPLIER, { commentId: comment.id });

    expect(posts.rowFor(post.id).commentCount).toBe(0);
  });

  it("drops the comment out of the thread", async () => {
    const { service, comments, post, comment } = await build();

    await service.delete(REPLIER, { commentId: comment.id });

    const remaining = await comments.list({
      postId: post.id,
      after: null,
      limit: 10,
      excludeAuthorIds: [],
    });
    expect(remaining.map((row) => row.id)).not.toContain(comment.id);
  });

  it("refuses a delete by anyone but the author", async () => {
    const { service, comments, posts, post, comment } = await build();

    await expect(
      service.delete(AUTHOR, { commentId: comment.id }),
    ).rejects.toThrow(NotAuthorError);

    expect(comments.rowFor(comment.id).deletedAt).toBeNull();
    expect(posts.rowFor(post.id).commentCount).toBe(1);
  });

  it("reports the content gone on a second delete, and does not double-decrement", async () => {
    const { service, posts, post, comment } = await build();
    await service.delete(REPLIER, { commentId: comment.id });

    await expect(
      service.delete(REPLIER, { commentId: comment.id }),
    ).rejects.toThrow(ContentUnavailableError);

    expect(posts.rowFor(post.id).commentCount).toBe(0);
  });

  it("does not let an author delete around a moderator's hide", async () => {
    const { service, comments, comment } = await build();
    await comments.hide(comment.id, AT("2026-02-03T00:00:00.000Z"));

    await expect(
      service.delete(REPLIER, { commentId: comment.id }),
    ).rejects.toThrow(ContentUnavailableError);
    expect(comments.rowFor(comment.id).deletedAt).toBeNull();
  });
});
