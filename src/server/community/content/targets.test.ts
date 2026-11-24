import { FakeCommentRepository } from "../testing/fakeCommentRepository";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import { ContentTargets } from "./targets";

const AT = (iso: string) => new Date(iso);

const AUTHOR = "user-1";
const OTHER = "user-2";

const build = async () => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const targets = new ContentTargets(posts, comments);

  const post = await posts.insert({
    authorId: AUTHOR,
    categoryId: "cat-parking",
    title: "Best lot near ISEC?",
    content: "Under $10 a day ideally.",
    dateCreated: AT("2026-02-01T00:00:00.000Z"),
  });
  // A second post by someone else, so "absent from a list" is distinguishable
  // from "the list is empty".
  const bystander = await posts.insert({
    authorId: OTHER,
    categoryId: "cat-parking",
    title: "Shuttle times",
    content: "Anyone know the Saturday schedule?",
    dateCreated: AT("2026-02-02T00:00:00.000Z"),
  });
  const comment = (await comments.insert({
    postId: post.id,
    authorId: OTHER,
    content: "Renaissance Garage, $8 before 9am.",
    dateCreated: AT("2026-02-03T00:00:00.000Z"),
  }))!;
  const bystanderComment = (await comments.insert({
    postId: post.id,
    authorId: AUTHOR,
    content: "Thanks, that works.",
    dateCreated: AT("2026-02-04T00:00:00.000Z"),
  }))!;

  return {
    posts,
    comments,
    targets,
    post,
    bystander,
    comment,
    bystanderComment,
  };
};

describe("ContentTargets.findVisibleTarget", () => {
  it("returns a post's author and a snapshot carrying its title and body", async () => {
    const { targets, post } = await build();

    const target = await targets.findVisibleTarget("POST", post.id, []);

    expect(target?.authorId).toBe(AUTHOR);
    expect(target?.snapshot).toContain("Best lot near ISEC?");
    expect(target?.snapshot).toContain("Under $10 a day ideally.");
    // Carries no ids beyond the author's.
    expect(Object.keys(target!).sort()).toEqual(["authorId", "snapshot"]);
  });

  it("returns a comment's author and a snapshot of its body", async () => {
    const { targets, comment } = await build();

    const target = await targets.findVisibleTarget("COMMENT", comment.id, []);

    expect(target).toEqual({
      authorId: OTHER,
      snapshot: "Renaissance Garage, $8 before 9am.",
    });
  });

  it("snapshots the stored row, not anything the caller could have supplied", async () => {
    const { targets, posts, post } = await build();
    posts.rowFor(post.id).content = "Edited after the fact.";

    const target = await targets.findVisibleTarget("POST", post.id, []);

    expect(target?.snapshot).toContain("Edited after the fact.");
    expect(target?.snapshot).not.toContain("Under $10");
  });

  it("returns null for a post the caller is blocked from", async () => {
    const { targets, post } = await build();

    expect(
      await targets.findVisibleTarget("POST", post.id, [AUTHOR]),
    ).toBeNull();
  });

  it("returns null for a comment the caller is blocked from", async () => {
    const { targets, comment } = await build();

    expect(
      await targets.findVisibleTarget("COMMENT", comment.id, [OTHER]),
    ).toBeNull();
  });

  it("returns null for a hidden post and for a hidden comment", async () => {
    const { targets, posts, comments, post, comment } = await build();
    posts.rowFor(post.id).hiddenAt = AT("2026-03-01T00:00:00.000Z");
    comments.rowFor(comment.id).hiddenAt = AT("2026-03-01T00:00:00.000Z");

    expect(await targets.findVisibleTarget("POST", post.id, [])).toBeNull();
    expect(
      await targets.findVisibleTarget("COMMENT", comment.id, []),
    ).toBeNull();
  });

  it("returns null for a deleted post and for a deleted comment", async () => {
    const { targets, posts, comments, post, comment } = await build();
    posts.rowFor(post.id).deletedAt = AT("2026-03-01T00:00:00.000Z");
    comments.rowFor(comment.id).deletedAt = AT("2026-03-01T00:00:00.000Z");

    expect(await targets.findVisibleTarget("POST", post.id, [])).toBeNull();
    expect(
      await targets.findVisibleTarget("COMMENT", comment.id, []),
    ).toBeNull();
  });

  it("returns null for an id of the wrong type", async () => {
    const { targets, post, comment } = await build();

    expect(await targets.findVisibleTarget("COMMENT", post.id, [])).toBeNull();
    expect(await targets.findVisibleTarget("POST", comment.id, [])).toBeNull();
  });

  it("returns null for an id that is not there", async () => {
    const { targets } = await build();

    expect(await targets.findVisibleTarget("POST", "post-999", [])).toBeNull();
    expect(
      await targets.findVisibleTarget("COMMENT", "comment-999", []),
    ).toBeNull();
  });
});

describe("ContentTargets.hide", () => {
  it("hides a post, and the post leaves findVisibleById", async () => {
    const { targets, posts, post } = await build();
    expect(await posts.findVisibleById(post.id, [])).not.toBeNull();

    expect(
      await targets.hide("POST", post.id, AT("2026-03-01T00:00:00.000Z")),
    ).toBe(true);

    expect(await posts.findVisibleById(post.id, [])).toBeNull();
    expect(await targets.findVisibleTarget("POST", post.id, [])).toBeNull();
  });

  it("hides a comment, and the comment leaves the thread list", async () => {
    const { targets, comments, post, comment, bystanderComment } =
      await build();
    const thread = () =>
      comments.list({
        postId: post.id,
        after: null,
        limit: 10,
        excludeAuthorIds: [],
      });
    expect((await thread()).map((row) => row.id)).toContain(comment.id);

    expect(
      await targets.hide("COMMENT", comment.id, AT("2026-03-01T00:00:00.000Z")),
    ).toBe(true);

    expect((await thread()).map((row) => row.id)).toEqual([
      bystanderComment.id,
    ]);
    expect(await comments.findVisibleById(comment.id, [])).toBeNull();
  });

  it("is a no-op on an already-hidden post and keeps the first hiddenAt", async () => {
    const { targets, posts, post } = await build();

    expect(
      await targets.hide("POST", post.id, AT("2026-03-01T00:00:00.000Z")),
    ).toBe(true);
    expect(
      await targets.hide("POST", post.id, AT("2026-03-02T00:00:00.000Z")),
    ).toBe(false);
    expect(posts.rowFor(post.id).hiddenAt).toEqual(
      AT("2026-03-01T00:00:00.000Z"),
    );
  });

  it("is a no-op on an already-hidden comment and keeps the first hiddenAt", async () => {
    const { targets, comments, comment } = await build();

    expect(
      await targets.hide("COMMENT", comment.id, AT("2026-03-01T00:00:00.000Z")),
    ).toBe(true);
    expect(
      await targets.hide("COMMENT", comment.id, AT("2026-03-02T00:00:00.000Z")),
    ).toBe(false);
    expect(comments.rowFor(comment.id).hiddenAt).toEqual(
      AT("2026-03-01T00:00:00.000Z"),
    );
  });

  it("reports false for an id that is not there, without throwing", async () => {
    const { targets } = await build();

    expect(
      await targets.hide("POST", "post-999", AT("2026-03-01T00:00:00.000Z")),
    ).toBe(false);
    expect(
      await targets.hide(
        "COMMENT",
        "comment-999",
        AT("2026-03-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("reports false for an id of the wrong type, and hides nothing", async () => {
    const { targets, posts, post } = await build();

    expect(
      await targets.hide("COMMENT", post.id, AT("2026-03-01T00:00:00.000Z")),
    ).toBe(false);
    expect(posts.rowFor(post.id).hiddenAt).toBeNull();
  });
});

/**
 * The ticket's requirement is that a hidden row leaves **every** list that
 * reads it. Each list below is a separate `where` clause, so each is asserted
 * on its own rather than once: a later change to one of them can drift without
 * the others noticing.
 */
describe("a hidden post leaves every list, and stays in the table", () => {
  const HIDDEN_AT = AT("2026-03-01T00:00:00.000Z");

  const hidden = async () => {
    const world = await build();
    await world.targets.hide("POST", world.post.id, HIDDEN_AT);
    return world;
  };

  it("leaves the feed", async () => {
    const { posts, post, bystander } = await hidden();

    for (const sort of ["new", "top"] as const) {
      const page = await posts.list({
        categoryId: null,
        search: null,
        sort,
        after: null,
        limit: 10,
        excludeAuthorIds: [],
      });
      expect(page.map((row) => row.id)).toEqual([bystander.id]);
      expect(page.map((row) => row.id)).not.toContain(post.id);
    }
  });

  // Search is not a list of its own, and the absence of a separate assertion
  // is not an oversight. A search term *narrows the feed query* — it is
  // `ListPostsQuery.search`, handled by the same `posts.list` and therefore the
  // same `hiddenAt: null` as the feed — so the filter is shared because the
  // query is shared. This case pins that: a later change that gave search a
  // query of its own would have to pass here, or would reopen the hole.
  it("leaves search", async () => {
    const { posts, post } = await hidden();

    const page = await posts.list({
      categoryId: null,
      // Matches the hidden post's title and nothing else.
      search: "ISEC",
      sort: "new",
      after: null,
      limit: 10,
      excludeAuthorIds: [],
    });

    expect(page.map((row) => row.id)).not.toContain(post.id);
    expect(page).toEqual([]);
  });

  it("leaves the profile list", async () => {
    const { posts, post } = await hidden();

    const page = await posts.listByAuthor({
      authorId: AUTHOR,
      after: null,
      limit: 10,
    });

    expect(page.map((row) => row.id)).not.toContain(post.id);
    expect(page).toEqual([]);
  });

  it("leaves the saved list's batch read", async () => {
    const { posts, post, bystander } = await hidden();

    const found = await posts.findVisibleByIds([post.id, bystander.id], []);

    expect(found.map((row) => row.id)).toEqual([bystander.id]);
  });

  it("leaves the detail read", async () => {
    const { posts, post } = await hidden();

    expect(await posts.findVisibleById(post.id, [])).toBeNull();
  });

  it("is still stored, with its hiddenAt set", async () => {
    const { posts, post } = await hidden();

    expect(posts.rows).toHaveLength(2);
    expect(posts.rowFor(post.id).hiddenAt).toEqual(HIDDEN_AT);
    // Hidden, not deleted: the reversible state, and a different column.
    expect(posts.rowFor(post.id).deletedAt).toBeNull();
  });
});

describe("a hidden comment leaves the thread, and stays in the table", () => {
  const HIDDEN_AT = AT("2026-03-01T00:00:00.000Z");

  it("leaves comments.list", async () => {
    const { targets, comments, post, comment, bystanderComment } =
      await build();
    await targets.hide("COMMENT", comment.id, HIDDEN_AT);

    const thread = await comments.list({
      postId: post.id,
      after: null,
      limit: 10,
      excludeAuthorIds: [],
    });

    expect(thread.map((row) => row.id)).toEqual([bystanderComment.id]);
  });

  it("is still stored, with its hiddenAt set", async () => {
    const { targets, comments, comment } = await build();
    await targets.hide("COMMENT", comment.id, HIDDEN_AT);

    expect(comments.rows).toHaveLength(2);
    expect(comments.rowFor(comment.id).hiddenAt).toEqual(HIDDEN_AT);
    expect(comments.rowFor(comment.id).deletedAt).toBeNull();
  });
});

describe("ContentTargets.restore", () => {
  const HIDDEN_AT = AT("2026-03-01T00:00:00.000Z");

  it("restores a post, and it returns to the detail read, the feed, the profile list and search", async () => {
    const { targets, posts, post, bystander } = await build();
    await targets.hide("POST", post.id, HIDDEN_AT);
    const feed = (sort: "new" | "top", search: string | null = null) =>
      posts.list({
        categoryId: null,
        search,
        sort,
        after: null,
        limit: 10,
        excludeAuthorIds: [],
      });
    expect((await feed("new")).map((row) => row.id)).toEqual([bystander.id]);

    expect(await targets.restore("POST", post.id)).toBe(true);

    expect(await posts.findVisibleById(post.id, [])).not.toBeNull();
    for (const sort of ["new", "top"] as const) {
      expect((await feed(sort)).map((row) => row.id)).toContain(post.id);
    }
    expect((await feed("new", "ISEC")).map((row) => row.id)).toEqual([post.id]);
    expect(
      (
        await posts.listByAuthor({ authorId: AUTHOR, after: null, limit: 10 })
      ).map((row) => row.id),
    ).toEqual([post.id]);
    expect(
      (await posts.findVisibleByIds([post.id], [])).map((row) => row.id),
    ).toEqual([post.id]);
    expect(posts.rowFor(post.id).hiddenAt).toBeNull();
  });

  it("restores a comment, and it returns to the thread", async () => {
    const { targets, comments, post, comment, bystanderComment } =
      await build();
    await targets.hide("COMMENT", comment.id, HIDDEN_AT);

    expect(await targets.restore("COMMENT", comment.id)).toBe(true);

    const thread = await comments.list({
      postId: post.id,
      after: null,
      limit: 10,
      excludeAuthorIds: [],
    });
    expect(thread.map((row) => row.id)).toEqual([
      comment.id,
      bystanderComment.id,
    ]);
    expect(await comments.findVisibleById(comment.id, [])).not.toBeNull();
  });

  it("is idempotent, and reports false for a row that is already visible", async () => {
    const { targets, posts, comments, post, comment } = await build();

    expect(await targets.restore("POST", post.id)).toBe(false);
    expect(await targets.restore("COMMENT", comment.id)).toBe(false);

    await targets.hide("POST", post.id, HIDDEN_AT);
    expect(await targets.restore("POST", post.id)).toBe(true);
    expect(await targets.restore("POST", post.id)).toBe(false);
    expect(posts.rowFor(post.id).hiddenAt).toBeNull();
    expect(comments.rowFor(comment.id).hiddenAt).toBeNull();
  });

  it("reports false for an id that is not there, and for an id of the wrong type", async () => {
    const { targets, posts, post } = await build();
    await targets.hide("POST", post.id, HIDDEN_AT);

    expect(await targets.restore("POST", "post-999")).toBe(false);
    expect(await targets.restore("COMMENT", "comment-999")).toBe(false);
    expect(await targets.restore("COMMENT", post.id)).toBe(false);
    expect(posts.rowFor(post.id).hiddenAt).toEqual(HIDDEN_AT);
  });

  it("restores through the repositories directly, with the same semantics", async () => {
    const { posts, comments, post, comment } = await build();
    await posts.hide(post.id, HIDDEN_AT);
    await comments.hide(comment.id, HIDDEN_AT);

    expect(await posts.unhide(post.id)).toBe(true);
    expect(await posts.unhide(post.id)).toBe(false);
    expect(await posts.unhide("post-999")).toBe(false);
    expect(await comments.unhide(comment.id)).toBe(true);
    expect(await comments.unhide(comment.id)).toBe(false);
    expect(await comments.unhide("comment-999")).toBe(false);
  });
});
