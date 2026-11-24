import type { Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../testing/fakeContentRepositories";
import {
  ContentUnavailableError,
  NotAuthorError,
  TextEmptyError,
  TextTooLongError,
} from "../shared/errors";
import { POST_TITLE_MAX_LENGTH } from "./domain/textLimits";
import type { StoredPost } from "./ports";
import { PostService } from "./service";

const AUTHOR: Member = {
  kind: "member",
  userId: "user-1",
  profile: { id: "p1", handle: "HuskyCommuter" },
};
const OTHER: Member = {
  kind: "member",
  userId: "user-2",
  profile: { id: "p2", handle: "Parker" },
};

const AT = (iso: string) => new Date(iso);
const CREATED = AT("2026-02-01T00:00:00.000Z");

const build = async (posts: FakePostRepository = new FakePostRepository()) => {
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AUTHOR, OTHER]) {
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
    dateCreated: CREATED,
  });

  return {
    posts,
    categories,
    host,
    post,
    service: new PostService(
      posts,
      categories,
      asProfileReader(profileRepo),
      host,
    ),
  };
};

describe("PostService.edit", () => {
  it("rewrites the title and body and marks the post edited", async () => {
    const { service, host, post } = await build();
    host.setNow(AT("2026-02-02T09:30:00.000Z"));

    const edited = await service.edit(AUTHOR, {
      postId: post.id,
      title: "Best lot near ISEC? (answered)",
      content: "Columbus garage, $7 with the student rate.",
    });

    expect(edited.title).toBe("Best lot near ISEC? (answered)");
    expect(edited.content).toBe("Columbus garage, $7 with the student rate.");
    expect(edited.edited).toBe(true);
  });

  it("leaves dateCreated where it was, so an edit does not bump the feed", async () => {
    const { service, posts, post } = await build();

    await service.edit(AUTHOR, {
      postId: post.id,
      title: "Still the same thread",
      content: "Only the body moved.",
    });

    expect(posts.rowFor(post.id).dateCreated).toEqual(CREATED);
    expect(posts.rowFor(post.id).editedAt).not.toBeNull();
  });

  it("refuses an edit by anyone but the author", async () => {
    const { service, posts, post } = await build();

    await expect(
      service.edit(OTHER, {
        postId: post.id,
        title: "Hijacked",
        content: "Not mine to change.",
      }),
    ).rejects.toThrow(NotAuthorError);

    expect(posts.rowFor(post.id).title).toBe("Best lot near ISEC?");
  });

  it("refuses an edit to a moderator-hidden post", async () => {
    const { service, posts, post } = await build();
    await posts.hide(post.id, AT("2026-02-03T00:00:00.000Z"));

    await expect(
      service.edit(AUTHOR, {
        postId: post.id,
        title: "Cleaned up",
        content: "Editing my way out of a hide.",
      }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses an edit to a post the author already deleted", async () => {
    const { service, posts, post } = await build();
    await posts.softDeleteByAuthor({
      postId: post.id,
      authorId: AUTHOR.userId,
      deletedAt: AT("2026-02-03T00:00:00.000Z"),
    });

    await expect(
      service.edit(AUTHOR, {
        postId: post.id,
        title: "Back from the dead",
        content: "Should not be reachable.",
      }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses an unknown post id", async () => {
    const { service } = await build();

    await expect(
      service.edit(AUTHOR, {
        postId: "post-nope",
        title: "Nothing here",
        content: "No such row.",
      }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("bounds the title", async () => {
    const { service, post } = await build();

    await expect(
      service.edit(AUTHOR, {
        postId: post.id,
        title: "x".repeat(POST_TITLE_MAX_LENGTH + 1),
        content: "Body is fine.",
      }),
    ).rejects.toThrow(TextTooLongError);
  });

  it("refuses a body edited down to nothing", async () => {
    const { service, post } = await build();

    await expect(
      service.edit(AUTHOR, {
        postId: post.id,
        title: "Still titled",
        content: "   ",
      }),
    ).rejects.toThrow(TextEmptyError);
  });

  it("reports the content gone when the update loses to a concurrent hide", async () => {
    /**
     * The visibility read passes and the conditional update matches no row —
     * which is what a moderator's hide landing between the two produces. The
     * service must report it as the same refusal as every other reason the
     * post is not there, not as a success.
     */
    class HiddenMidEditRepository extends FakePostRepository {
      async editByAuthor(): Promise<StoredPost | null> {
        return null;
      }
    }

    const { service, post } = await build(new HiddenMidEditRepository());

    await expect(
      service.edit(AUTHOR, {
        postId: post.id,
        title: "Raced",
        content: "Lost to a hide.",
      }),
    ).rejects.toThrow(ContentUnavailableError);
  });
});

describe("PostService.delete", () => {
  it("soft-deletes the author's own post and keeps the row", async () => {
    const { service, posts, host, post } = await build();
    host.setNow(AT("2026-02-04T12:00:00.000Z"));

    await service.delete(AUTHOR, { postId: post.id });

    expect(posts.rowFor(post.id).deletedAt).toEqual(
      AT("2026-02-04T12:00:00.000Z"),
    );
    expect(posts.rowFor(post.id).hiddenAt).toBeNull();
  });

  it("drops the post out of the feed", async () => {
    const { service, posts, post } = await build();

    await service.delete(AUTHOR, { postId: post.id });

    const remaining = await posts.list({
      categoryId: null,
      search: null,
      sort: "new",
      after: null,
      limit: 10,
      excludeAuthorIds: [],
    });
    expect(remaining.map((row) => row.id)).not.toContain(post.id);
  });

  it("refuses a delete by anyone but the author", async () => {
    const { service, posts, post } = await build();

    await expect(service.delete(OTHER, { postId: post.id })).rejects.toThrow(
      NotAuthorError,
    );

    expect(posts.rowFor(post.id).deletedAt).toBeNull();
  });

  it("reports the content gone on a second delete", async () => {
    const { service, post } = await build();
    await service.delete(AUTHOR, { postId: post.id });

    await expect(service.delete(AUTHOR, { postId: post.id })).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses an unknown post id", async () => {
    const { service } = await build();

    await expect(
      service.delete(AUTHOR, { postId: "post-nope" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("does not let an author delete around a moderator's hide", async () => {
    /**
     * A hidden post is already out of every reader's view, and the author
     * deleting it would replace the moderation record's `hiddenAt` context with
     * an author deletion. The refusal keeps `hiddenAt` the only thing that
     * happened to this row.
     */
    const { service, posts, post } = await build();
    await posts.hide(post.id, AT("2026-02-03T00:00:00.000Z"));

    await expect(service.delete(AUTHOR, { postId: post.id })).rejects.toThrow(
      ContentUnavailableError,
    );
    expect(posts.rowFor(post.id).deletedAt).toBeNull();
  });
});

/**
 * Whether the viewer wrote this.
 *
 * **A server fact, not something the client infers.** The alternative — the
 * browser comparing `post.author.handle` against its own handle from
 * `profiles.me` — looks equivalent and is not: a post whose author's profile
 * row is missing renders as `UNKNOWN_AUTHOR_HANDLE`, so two such posts would
 * compare equal to each other and, for a viewer whose own handle failed to
 * resolve, equal to the viewer. That turns a rendering gap into a live Edit
 * button over someone else's writing. The server knows the author id and the
 * viewer id; it answers here.
 *
 * **It is not an identity leak**, which is the bar every field on `PublicPost`
 * has to clear: it says something about the viewer, who already knows it, and
 * nothing about anybody else. It follows `viewerHasVoted` and `viewerHasSaved`
 * exactly.
 */
describe("PublicPost.viewerIsAuthor", () => {
  it("is true for the author reading their own post", async () => {
    const { service, post } = await build();

    const seen = await service.byId(AUTHOR, post.id);

    expect(seen.viewerIsAuthor).toBe(true);
  });

  it("is false for anybody else", async () => {
    const { service, post } = await build();

    const seen = await service.byId(OTHER, post.id);

    expect(seen.viewerIsAuthor).toBe(false);
  });

  it("is true on the post an author has just created", async () => {
    const { service } = await build();

    const created = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Fresh",
      content: "Mine, obviously.",
    });

    expect(created.viewerIsAuthor).toBe(true);
  });

  it("is true on the post an author has just edited", async () => {
    const { service, post } = await build();

    const edited = await service.edit(AUTHOR, {
      postId: post.id,
      title: "Reworded",
      content: "Still mine.",
    });

    expect(edited.viewerIsAuthor).toBe(true);
  });

  it("is false for every post in a feed nobody here wrote", async () => {
    const { service, posts } = await build();
    await posts.insert({
      authorId: OTHER.userId,
      categoryId: "cat-parking",
      title: "Someone else's",
      content: "Not yours.",
      dateCreated: AT("2026-02-05T00:00:00.000Z"),
    });

    const page = await service.list(OTHER, {});

    expect(page.posts.map((p) => p.viewerIsAuthor)).toEqual([true, false]);
  });
});
