import type { CommunityActor, Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import { FakeCommentRepository } from "../testing/fakeCommentRepository";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import {
  ContentUnavailableError,
  TextEmptyError,
  TextTooLongError,
} from "../shared/errors";
import type { StoredPost } from "./ports";
import { COMMENT_CONTENT_MAX_LENGTH } from "./domain/textLimits";
import { UNKNOWN_AUTHOR_HANDLE } from "./public";
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
const READER: CommunityActor = { kind: "student", userId: "user-9" };

const AT = (iso: string) => new Date(iso);

const build = async (posts: FakePostRepository = new FakePostRepository()) => {
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

  const profiles = asProfileReader(profileRepo);
  return {
    posts,
    comments,
    host,
    post,
    service: new CommentService(comments, posts, profiles, host),
  };
};

/**
 * A post repository whose row disappears the instant the visibility check has
 * read it — the §6.2 window, lost.
 *
 * **The removal has to happen *after* the check, not before it.** Every other
 * refusal test here makes the post unreachable up front, so the service stops
 * in `requireVisiblePost` and the insert is never called. Only a post that
 * passes the check and is gone by the time the insert takes its `FOR UPDATE`
 * lock reaches the branch where `insert` returns `null`.
 *
 * **It is a fake rather than a stubbed `comments.insert`** for the reason the
 * fakes exist at all: stubbing the insert would assert the service's reaction
 * to a `null` without showing that a repository can produce one. Here the
 * `null` comes from `FakeCommentRepository.insert` finding no parent row, the
 * same condition the real `SELECT ... FOR UPDATE` reports.
 */
class VanishingPostRepository extends FakePostRepository {
  async findVisibleById(
    postId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredPost | null> {
    const found = await super.findVisibleById(postId, excludeAuthorIds);
    this.rows = this.rows.filter((row) => row.id !== postId);
    return found;
  }
}

describe("CommentService.create", () => {
  it("stores a comment and returns it with the author's handle only", async () => {
    const { service, host, post } = await build();

    const comment = await service.create(REPLIER, {
      postId: post.id,
      content: "Renaissance Garage, $8 before 9am.",
    });

    expect(comment.content).toBe("Renaissance Garage, $8 before 9am.");
    expect(comment.author.handle).toBe("Parker");
    // The privacy mechanism: the public type has no field to leak.
    expect(comment).not.toHaveProperty("authorId");
    expect(comment).not.toHaveProperty("postId");
    // One host round trip for the whole reply. Unlike `list`, `create` discards
    // what `requireVisiblePost` returns, so what this pins is only the cost:
    // the block list is read once per reply, not once per caller that wants it.
    expect(host.blockLookups).toBe(1);
  });

  // One insert per call is the whole of what `create` decides here, and the
  // name says only that. `commentCount` is deliberately not asserted: `create`
  // never writes it — `PrismaCommentRepository.insert` moves it, relatively and
  // in the same transaction as the row — so a count read back from this fake is
  // `FakeCommentRepository.insert` bumping the shared post row, which is the
  // fake asserting itself. The invariant worth having is that the row and the
  // counter commit *together*, and no in-memory fake can show a transaction
  // property. That one needs a real MySQL, against the repository, with the
  // §6.2/§6.4 race suites.
  it("inserts one comment row per create", async () => {
    const { service, comments, post } = await build();

    await service.create(REPLIER, { postId: post.id, content: "One." });
    await service.create(AUTHOR, { postId: post.id, content: "Two." });

    expect(comments.rows).toHaveLength(2);
  });

  it("trims the content before storing it", async () => {
    const { service, post } = await build();

    const comment = await service.create(REPLIER, {
      postId: post.id,
      content: "   padded   ",
    });

    expect(comment.content).toBe("padded");
  });

  it("refuses an empty comment", async () => {
    const { service, post } = await build();

    await expect(
      service.create(REPLIER, { postId: post.id, content: "   " }),
    ).rejects.toThrow(TextEmptyError);
  });

  it("refuses a comment past the column width", async () => {
    const { service, post } = await build();

    await expect(
      service.create(REPLIER, {
        postId: post.id,
        content: "x".repeat(COMMENT_CONTENT_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(TextTooLongError);
  });

  it("does not store a comment whose text was refused", async () => {
    const { service, comments, posts, post } = await build();

    await expect(
      service.create(REPLIER, { postId: post.id, content: "" }),
    ).rejects.toThrow(TextEmptyError);

    expect(comments.rows).toHaveLength(0);
    expect(posts.rows.find((row) => row.id === post.id)?.commentCount).toBe(0);
  });

  it("refuses a reply to an unknown post", async () => {
    const { service } = await build();

    await expect(
      service.create(REPLIER, { postId: "post-nope", content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses a reply to a deleted post", async () => {
    const { service, posts, post } = await build();
    const stored = posts.rows.find((row) => row.id === post.id)!;
    stored.deletedAt = AT("2026-02-02T00:00:00.000Z");

    await expect(
      service.create(REPLIER, { postId: post.id, content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses a reply to a moderator-hidden post", async () => {
    const { service, posts, post } = await build();
    const stored = posts.rows.find((row) => row.id === post.id)!;
    stored.hiddenAt = AT("2026-02-02T00:00:00.000Z");

    await expect(
      service.create(REPLIER, { postId: post.id, content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses a reply to a post by a block counterpart", async () => {
    const { service, host, post } = await build();
    host.withBlocksFor(REPLIER.userId, [AUTHOR.userId]);

    await expect(
      service.create(REPLIER, { postId: post.id, content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses when the post is hard-deleted between the check and the insert", async () => {
    const { service, comments, post } = await build(
      new VanishingPostRepository(),
    );

    await expect(
      service.create(REPLIER, { postId: post.id, content: "Hello?" }),
    ).rejects.toThrow(ContentUnavailableError);

    // The refusal alone is not the guarantee. What the guard buys is that the
    // lost race leaves nothing behind: no comment row orphaned against a post
    // that is gone, and so no `commentCount` raised on a row nobody can read.
    expect(comments.rows).toHaveLength(0);
  });
});

describe("CommentService.list", () => {
  it("returns a thread oldest first", async () => {
    const { service, comments, post } = await build();
    for (const [index, text] of ["first", "second", "third"].entries()) {
      await comments.insert({
        postId: post.id,
        authorId: REPLIER.userId,
        content: text,
        dateCreated: AT(`2026-02-0${index + 2}T00:00:00.000Z`),
      });
    }

    const page = await service.list(READER, { postId: post.id });

    expect(page.comments.map((c) => c.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("pages without dropping or duplicating comments that share a millisecond", async () => {
    const { service, comments, post } = await build();
    const sameInstant = AT("2026-02-02T00:00:00.000Z");
    for (const text of ["a", "b", "c", "d"]) {
      await comments.insert({
        postId: post.id,
        authorId: REPLIER.userId,
        content: text,
        dateCreated: sameInstant,
      });
    }

    const first = await service.list(READER, { postId: post.id, limit: 2 });
    // The limit is asserted directly rather than left to fall out of the
    // duplicate check below: an over-large first page would show up there only
    // as repeated entries in `seen`, which reads as a paging bug of a different
    // kind.
    expect(first.comments).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(READER, {
      postId: post.id,
      limit: 2,
      cursor: first.nextCursor!,
    });

    const seen = [...first.comments, ...second.comments].map((c) => c.content);
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(second.nextCursor).toBeNull();
  });

  // The post is authored by AUTHOR and the block is against REPLIER, so the
  // thread itself stays visible and only one comment inside it is filtered.
  // Blocking the post's author instead hides the whole post, which is the
  // feed's behaviour and is covered in `service.test.ts`.
  it("hides comments by a block counterpart without hiding the thread", async () => {
    const { service, comments, host, post } = await build();
    await comments.insert({
      postId: post.id,
      authorId: REPLIER.userId,
      content: "from the blocked commenter",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    });
    await comments.insert({
      postId: post.id,
      authorId: AUTHOR.userId,
      content: "from someone else",
      dateCreated: AT("2026-02-03T00:00:00.000Z"),
    });
    host.withBlocksFor(READER.userId, [REPLIER.userId]);

    const page = await service.list(READER, { postId: post.id });

    expect(page.comments.map((c) => c.content)).toEqual(["from someone else"]);
    // One lookup, not two: the list that authorized the post is the list that
    // filtered the thread. `requireVisiblePost` returns `excludeAuthorIds`
    // instead of discarding it for exactly this reason, and the count is the
    // only thing enforcing it — the obvious refactor, having `list` call
    // `getBlockedCounterpartIds` for itself, reads as simpler and passes every
    // other assertion in this file. Two reads could also disagree: a block
    // committed between them authorizes the thread under one list and filters
    // it under another.
    expect(host.blockLookups).toBe(1);
  });

  it("omits soft-deleted comments", async () => {
    const { service, comments, post } = await build();
    const doomed = await comments.insert({
      postId: post.id,
      authorId: REPLIER.userId,
      content: "retracted",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    });
    doomed!.deletedAt = AT("2026-02-03T00:00:00.000Z");

    const page = await service.list(READER, { postId: post.id });

    expect(page.comments).toHaveLength(0);
  });

  it("renders a placeholder when an author has no profile row", async () => {
    const { service, comments, post } = await build();
    await comments.insert({
      postId: post.id,
      authorId: "user-with-no-profile",
      content: "orphaned",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    });

    const page = await service.list(READER, { postId: post.id });

    expect(page.comments[0]?.author.handle).toBe(UNKNOWN_AUTHOR_HANDLE);
  });

  it("refuses to list the thread of a post the caller may not see", async () => {
    const { service, posts, post } = await build();
    const stored = posts.rows.find((row) => row.id === post.id)!;
    stored.hiddenAt = AT("2026-02-02T00:00:00.000Z");

    await expect(service.list(READER, { postId: post.id })).rejects.toThrow(
      ContentUnavailableError,
    );
  });
});
