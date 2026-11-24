import type { CommunityActor, Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../testing/fakeContentRepositories";
import { FakeVoteRepository } from "../testing/fakeVoteRepository";
import {
  CategoryUnknownError,
  ContentUnavailableError,
  TextEmptyError,
  TextTooLongError,
} from "../shared/errors";
import { POST_TITLE_MAX_LENGTH } from "./domain/textLimits";
import { UNKNOWN_AUTHOR_HANDLE } from "./public";
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
const READER: CommunityActor = { kind: "student", userId: "user-9" };

const build = async () => {
  const posts = new FakePostRepository();
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AUTHOR, OTHER]) {
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const profiles = asProfileReader(profileRepo);
  return {
    posts,
    categories,
    host,
    service: new PostService(posts, categories, profiles, host),
  };
};

/**
 * The same harness with `engagement`'s repository supplied as the
 * `ViewerVoteReader`, which is how `composition.ts` wires it in production.
 */
const buildWithVotes = async () => {
  const harness = await build();
  const votes = new FakeVoteRepository(harness.posts);
  const profileRepo = new FakeProfileRepository();
  for (const member of [AUTHOR, OTHER]) {
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }
  return {
    ...harness,
    votes,
    service: new PostService(
      harness.posts,
      harness.categories,
      asProfileReader(profileRepo),
      harness.host,
      votes,
    ),
  };
};

describe("PostService.create", () => {
  it("stores a post and returns it with the author's handle only", async () => {
    const { service } = await build();

    const post = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Best lot near ISEC?",
      content: "Looking for something under $10 a day.",
    });

    expect(post.title).toBe("Best lot near ISEC?");
    expect(post.categorySlug).toBe("parking");
    expect(post.author).toEqual({ handle: "HuskyCommuter" });
    expect(post.edited).toBe(false);
    // The platform identity must not ride along on a public DTO.
    expect(JSON.stringify(post)).not.toContain("user-1");
  });

  it("trims whitespace rather than storing a blank-looking title", async () => {
    const { service } = await build();
    const post = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "  Spaced out  ",
      content: "  body  ",
    });
    expect(post.title).toBe("Spaced out");
    expect(post.content).toBe("body");
  });

  it.each([
    ["an empty title", { title: "   ", content: "ok" }, TextEmptyError],
    ["an empty body", { title: "ok", content: "" }, TextEmptyError],
    [
      "an over-long title",
      { title: "a".repeat(POST_TITLE_MAX_LENGTH + 1), content: "ok" },
      TextTooLongError,
    ],
  ])("refuses %s", async (_label, fields, expected) => {
    const { service, posts } = await build();
    await expect(
      service.create(AUTHOR, { categorySlug: "parking", ...fields }),
    ).rejects.toThrow(expected);
    // A refused write must not have reached storage.
    expect(posts.rows).toHaveLength(0);
  });

  it("refuses an unknown category", async () => {
    const { service } = await build();
    await expect(
      service.create(AUTHOR, {
        categorySlug: "nope",
        title: "t",
        content: "c",
      }),
    ).rejects.toThrow(CategoryUnknownError);
  });

  it("refuses a retired category even though it still resolves by slug", async () => {
    const { service, categories } = await build();
    categories.withInactive({
      id: "cat-old",
      slug: "old",
      name: "Old",
      description: "",
      sortOrder: 9,
    });

    await expect(
      service.create(AUTHOR, { categorySlug: "old", title: "t", content: "c" }),
    ).rejects.toThrow(CategoryUnknownError);
  });

  it("stamps dateCreated from the injected clock", async () => {
    const { service, host } = await build();
    host.setNow(new Date("2027-05-05T08:00:00.000Z"));
    const post = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "t",
      content: "c",
    });
    expect(post.dateCreated.toISOString()).toBe("2027-05-05T08:00:00.000Z");
  });
});

describe("PostService.list", () => {
  const seed = async (
    service: PostService,
    host: FakeCommunityHost,
    entries: ReadonlyArray<{
      by: Member;
      title: string;
      at: string;
      slug?: string;
    }>,
  ) => {
    for (const entry of entries) {
      host.setNow(new Date(entry.at));
      await service.create(entry.by, {
        categorySlug: entry.slug ?? "parking",
        title: entry.title,
        content: "body",
      });
    }
  };

  it("returns newest first", async () => {
    const { service, host } = await build();
    await seed(service, host, [
      { by: AUTHOR, title: "oldest", at: "2026-10-01T00:00:00.000Z" },
      { by: AUTHOR, title: "newest", at: "2026-10-03T00:00:00.000Z" },
      { by: AUTHOR, title: "middle", at: "2026-10-02T00:00:00.000Z" },
    ]);

    const page = await service.list(READER);
    expect(page.posts.map((p) => p.title)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("filters by category", async () => {
    const { service, host } = await build();
    await seed(service, host, [
      {
        by: AUTHOR,
        title: "parking post",
        at: "2026-10-01T00:00:00.000Z",
        slug: "parking",
      },
      {
        by: AUTHOR,
        title: "commute post",
        at: "2026-10-02T00:00:00.000Z",
        slug: "commuting",
      },
    ]);

    const page = await service.list(READER, { categorySlug: "commuting" });
    expect(page.posts.map((p) => p.title)).toEqual(["commute post"]);
  });

  it("hides posts by a block counterpart without revealing that a block exists", async () => {
    const { service, host } = await build();
    await seed(service, host, [
      { by: AUTHOR, title: "visible", at: "2026-10-01T00:00:00.000Z" },
      { by: OTHER, title: "blocked away", at: "2026-10-02T00:00:00.000Z" },
    ]);
    host.withBlocksFor("user-9", ["user-2"]);

    const page = await service.list(READER);

    expect(page.posts.map((p) => p.title)).toEqual(["visible"]);
    // The exclusion list itself is never serialized — it contains people who
    // blocked the caller, which the caller is not entitled to learn.
    expect(JSON.stringify(page)).not.toContain("user-2");
  });

  it("paginates without dropping or repeating rows that share a timestamp", async () => {
    // The id tiebreak is the whole reason this passes: three posts created in
    // the same millisecond have no stable order without it.
    const { service, host } = await build();
    await seed(service, host, [
      { by: AUTHOR, title: "a", at: "2026-10-01T00:00:00.000Z" },
      { by: AUTHOR, title: "b", at: "2026-10-01T00:00:00.000Z" },
      { by: AUTHOR, title: "c", at: "2026-10-01T00:00:00.000Z" },
    ]);

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<PostService["list"]>> = await service.list(
        READER,
        { limit: 2, cursor: cursor ?? undefined },
      );
      seen.push(...page.posts.map((p) => p.title));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(new Set(seen).size).toBe(3);
  });

  it("reports a next cursor only while more rows remain", async () => {
    const { service, host } = await build();
    await seed(service, host, [
      { by: AUTHOR, title: "a", at: "2026-10-01T00:00:00.000Z" },
      { by: AUTHOR, title: "b", at: "2026-10-02T00:00:00.000Z" },
    ]);

    const first = await service.list(READER, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();

    const second = await service.list(READER, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.posts).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("restarts from the beginning on a mangled cursor rather than failing", async () => {
    const { service, host } = await build();
    await seed(service, host, [
      { by: AUTHOR, title: "a", at: "2026-10-01T00:00:00.000Z" },
    ]);

    const page = await service.list(READER, { cursor: "!!!not-a-cursor!!!" });
    expect(page.posts.map((p) => p.title)).toEqual(["a"]);
  });

  it("refuses an unknown category filter", async () => {
    const { service } = await build();
    await expect(
      service.list(READER, { categorySlug: "nope" }),
    ).rejects.toThrow(CategoryUnknownError);
  });

  it("renders a placeholder when an author has no profile row", async () => {
    const { service, posts } = await build();
    await posts.insert({
      authorId: "ghost",
      categoryId: "cat-parking",
      title: "orphaned",
      content: "c",
      dateCreated: new Date("2026-10-01T00:00:00.000Z"),
    });

    const page = await service.list(READER);
    expect(page.posts[0]?.author.handle).toBe(UNKNOWN_AUTHOR_HANDLE);
  });
});

describe("PostService.list under sort: top", () => {
  /**
   * Seeds posts and then sets vote counts directly on the stored rows.
   *
   * Direct, rather than through `VoteService`: a count of seven needs seven
   * distinct voters, and what these tests are about is the ordering over the
   * column, not how it got there. `FakeVoteRepository` proves the column moves
   * correctly; this proves the feed reads it correctly.
   */
  const seedWithVotes = async (
    service: PostService,
    host: FakeCommunityHost,
    posts: FakePostRepository,
    entries: ReadonlyArray<{
      title: string;
      votes: number;
      slug?: string;
      at?: string;
    }>,
  ) => {
    let tick = 0;
    for (const entry of entries) {
      host.setNow(
        entry.at
          ? new Date(entry.at)
          : new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)),
      );
      const created = await service.create(AUTHOR, {
        categorySlug: entry.slug ?? "parking",
        title: entry.title,
        content: "body",
      });
      posts.rows.find((row) => row.id === created.id)!.voteCount = entry.votes;
    }
  };

  const drain = async (
    service: PostService,
    input: { sort?: "new" | "top"; categorySlug?: string },
  ) => {
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<PostService["list"]>> = await service.list(
        READER,
        { ...input, limit: 2, cursor: cursor ?? undefined },
      );
      seen.push(...page.posts.map((p) => p.title));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    return seen;
  };

  it("orders by vote count, highest first", async () => {
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "middling", votes: 3 },
      { title: "unloved", votes: 0 },
      { title: "popular", votes: 9 },
    ]);

    const page = await service.list(READER, { sort: "top" });

    expect(page.posts.map((p) => p.title)).toEqual([
      "popular",
      "middling",
      "unloved",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages to the end without dropping or repeating posts that share a count", async () => {
    // The id tiebreak is the whole reason this passes, and on Top the tie is
    // the common case rather than a coincidence: most posts have the same
    // small count, so without the tiebreak the order is a fresh permutation
    // on every page.
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "a", votes: 2 },
      { title: "b", votes: 2 },
      { title: "c", votes: 2 },
      { title: "d", votes: 2 },
      { title: "e", votes: 2 },
    ]);

    const seen = await drain(service, { sort: "top" });

    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps posts with equal counts in the same order on every pass", async () => {
    const { service, host, posts } = await build();
    // Seeded newest-first, so the date order (a, b, c) and the id order
    // (c, b, a) disagree — which is what makes this an assertion about the
    // Top tiebreak rather than about the New feed.
    await seedWithVotes(service, host, posts, [
      { title: "a", votes: 1, at: "2026-10-03T00:00:00.000Z" },
      { title: "b", votes: 1, at: "2026-10-02T00:00:00.000Z" },
      { title: "c", votes: 1, at: "2026-10-01T00:00:00.000Z" },
    ]);

    const first = await drain(service, { sort: "top" });
    const second = await drain(service, { sort: "top" });

    expect(first).toEqual(["c", "b", "a"]);
    expect(second).toEqual(first);
  });

  it("composes with the category filter", async () => {
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "big parking", votes: 9, slug: "parking" },
      { title: "big commute", votes: 5, slug: "commuting" },
      { title: "small commute", votes: 1, slug: "commuting" },
    ]);

    const page = await service.list(READER, {
      sort: "top",
      categorySlug: "commuting",
    });

    expect(page.posts.map((p) => p.title)).toEqual([
      "big commute",
      "small commute",
    ]);
  });

  it("still hides posts by a block counterpart", async () => {
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [{ title: "visible", votes: 1 }]);
    host.setNow(new Date("2026-10-02T00:00:00.000Z"));
    const blocked = await service.create(OTHER, {
      categorySlug: "parking",
      title: "blocked away",
      content: "body",
    });
    posts.rows.find((row) => row.id === blocked.id)!.voteCount = 99;
    host.withBlocksFor("user-9", ["user-2"]);

    const page = await service.list(READER, { sort: "top" });

    expect(page.posts.map((p) => p.title)).toEqual(["visible"]);
  });

  it("defaults to newest-first when sort is absent", async () => {
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "oldest but popular", votes: 9 },
      { title: "newest but unloved", votes: 0 },
    ]);

    const page = await service.list(READER);

    expect(page.posts.map((p) => p.title)).toEqual([
      "newest but unloved",
      "oldest but popular",
    ]);
  });

  it("restarts rather than misreading a Top cursor replayed under New", async () => {
    // Without the sort tag on the cursor, a vote count of 2 decodes as a date
    // two milliseconds after the epoch and the New feed returns nothing at
    // all — a plausible-looking empty page rather than a refusal.
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "a", votes: 2 },
      { title: "b", votes: 2 },
      { title: "c", votes: 2 },
    ]);
    const top = await service.list(READER, { sort: "top", limit: 1 });

    const replayed = await service.list(READER, { cursor: top.nextCursor! });

    const fresh = await service.list(READER);
    expect(replayed.posts.map((p) => p.title)).toEqual(
      fresh.posts.map((p) => p.title),
    );
  });

  it("restarts rather than misreading a New cursor replayed under Top", async () => {
    const { service, host, posts } = await build();
    await seedWithVotes(service, host, posts, [
      { title: "a", votes: 1 },
      { title: "b", votes: 2 },
      { title: "c", votes: 3 },
    ]);
    const next = await service.list(READER, { limit: 1 });

    const replayed = await service.list(READER, {
      sort: "top",
      cursor: next.nextCursor!,
    });

    expect(replayed.posts.map((p) => p.title)).toEqual(["c", "b", "a"]);
  });

  it("reads vote state on a Top page exactly as it does on a New one", async () => {
    const { service, posts, votes, host } = await buildWithVotes();
    await seedWithVotes(service, host, posts, [{ title: "a", votes: 0 }]);
    await votes.insert({
      userId: READER.userId,
      postId: posts.rows[0]!.id,
      dateCreated: new Date("2026-10-02T00:00:00.000Z"),
    });

    const page = await service.list(READER, { sort: "top" });

    expect(page.posts[0]?.viewerHasVoted).toBe(true);
    expect(page.posts[0]?.voteCount).toBe(1);
  });
});

describe("PostService.byId", () => {
  const seedOne = async () => {
    const harness = await build();
    const post = await harness.service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Best lot near ISEC?",
      content: "Under $10 a day ideally.",
    });
    return { ...harness, post };
  };

  it("returns the post with its category slug and author handle", async () => {
    const { service, post } = await seedOne();

    const found = await service.byId(READER, post.id);

    expect(found.title).toBe("Best lot near ISEC?");
    expect(found.categorySlug).toBe("parking");
    expect(found.author.handle).toBe("HuskyCommuter");
    expect(found).not.toHaveProperty("authorId");
  });

  it("refuses an unknown id", async () => {
    const { service } = await seedOne();

    await expect(service.byId(READER, "post-nope")).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a deleted post", async () => {
    const { service, posts, post } = await seedOne();
    posts.rows.find((row) => row.id === post.id)!.deletedAt = new Date();

    await expect(service.byId(READER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a moderator-hidden post", async () => {
    const { service, posts, post } = await seedOne();
    posts.rows.find((row) => row.id === post.id)!.hiddenAt = new Date();

    await expect(service.byId(READER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a post by a block counterpart", async () => {
    const { service, host, post } = await seedOne();
    host.withBlocksFor(READER.userId, [AUTHOR.userId]);

    await expect(service.byId(READER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });
});

describe("PostService viewer vote state", () => {
  it("reports viewerHasVoted false for every post when no vote reader is wired", async () => {
    const { service } = await build();
    await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Unvoted",
      content: "No engagement module in this composition.",
    });

    const page = await service.list(READER);

    expect(page.posts[0]?.viewerHasVoted).toBe(false);
  });

  it("marks the posts the viewer has voted on in the feed", async () => {
    const { posts, categories, host, service, votes } = await buildWithVotes();
    const voted = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Voted",
      content: "one",
    });
    await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Not voted",
      content: "two",
    });
    await votes.insert({
      userId: READER.userId,
      postId: voted.id,
      dateCreated: new Date(),
    });

    const page = await service.list(READER);
    const byTitle = new Map(page.posts.map((p) => [p.title, p.viewerHasVoted]));

    expect(byTitle.get("Voted")).toBe(true);
    expect(byTitle.get("Not voted")).toBe(false);
    void posts;
    void categories;
    void host;
  });

  it("marks a single post the viewer has voted on", async () => {
    const { service, votes } = await buildWithVotes();
    const post = await service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Voted",
      content: "one",
    });
    await votes.insert({
      userId: READER.userId,
      postId: post.id,
      dateCreated: new Date(),
    });

    const found = await service.byId(READER, post.id);

    expect(found.viewerHasVoted).toBe(true);
  });

  it("does not query vote state for an empty page", async () => {
    const { service, votes } = await buildWithVotes();

    const page = await service.list(READER);

    expect(page.posts).toHaveLength(0);
    expect(votes.lookups).toBe(0);
  });
});

/**
 * Retiring a category — `is_active` false on a row that still has posts under
 * it.
 *
 * **Retiring stops new posts and nothing else** (SCRUM-690). The posts already
 * written stay readable, keep their label, and stay reachable by their slug;
 * the category simply stops being offered. These tests pin all three halves of
 * that, because the slug map used to be built from `listActive()` and every
 * read path shares it.
 */
describe("PostService with a retired category", () => {
  const seedThenRetire = async () => {
    const harness = await build();
    harness.host.setNow(new Date("2026-10-01T00:00:00.000Z"));
    const post = await harness.service.create(AUTHOR, {
      categorySlug: "parking",
      title: "Best lot near ISEC?",
      content: "body",
    });
    harness.categories.retire("parking");
    return { ...harness, post };
  };

  it("keeps the real category slug on the feed", async () => {
    const { service } = await seedThenRetire();

    const page = await service.list(READER);

    expect(page.posts.map((p) => p.categorySlug)).toEqual(["parking"]);
  });

  it("keeps the real category slug on the detail page", async () => {
    const { service, post } = await seedThenRetire();

    expect((await service.byId(READER, post.id)).categorySlug).toBe("parking");
  });

  it("keeps the real category slug on the saved list", async () => {
    const { service, post } = await seedThenRetire();

    const [saved] = await service.visibleByIds(READER, [post.id]);

    expect(saved?.categorySlug).toBe("parking");
  });

  it("keeps the real category slug on a profile", async () => {
    // The fourth caller of `hydrate`, and the one a shared fix is easiest to
    // forget: it reads through `listByAuthor`, not through the feed's query.
    const { service } = await seedThenRetire();

    const page = await service.listByHandle(AUTHOR, {
      handle: "HuskyCommuter",
    });

    expect(page.posts.map((p) => p.categorySlug)).toEqual(["parking"]);
  });

  it("still serves the category as a filter, which the composer refuses", async () => {
    // The two paths differ on purpose: a link to a retired category keeps
    // working, while nothing new can be written there.
    const { service } = await seedThenRetire();

    const page = await service.list(READER, { categorySlug: "parking" });

    expect(page.posts.map((p) => p.title)).toEqual(["Best lot near ISEC?"]);
    await expect(
      service.create(AUTHOR, {
        categorySlug: "parking",
        title: "t",
        content: "c",
      }),
    ).rejects.toThrow(CategoryUnknownError);
  });

  it("stops offering the category, which is what keeps the filter out of reach", async () => {
    const { service } = await seedThenRetire();

    const slugs = (await service.listCategories()).map((c) => c.slug);

    expect(slugs).toEqual(["commuting"]);
  });
});
