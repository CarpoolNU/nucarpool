import type { CommunityActor, Member } from "../actor";
import { PostService } from "../content/service";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../testing/fakeContentRepositories";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import { FakeSavedPostRepository } from "../testing/fakeSavedPostRepository";
import { ContentUnavailableError } from "../shared/errors";
import { SavedPostService } from "./service";

const SAVER: Member = {
  kind: "member",
  userId: "user-1",
  profile: { id: "p1", handle: "HuskyCommuter" },
};
const OTHER: Member = {
  kind: "member",
  userId: "user-2",
  profile: { id: "p2", handle: "Parker" },
};
const AUTHOR: Member = {
  kind: "member",
  userId: "user-7",
  profile: { id: "p7", handle: "GarageGuru" },
};

const AT = (iso: string) => new Date(iso);

/**
 * The real `PostService` behind the saved list, wired to fakes.
 *
 * **Not a stand-in for it.** The list's whole job is to hand post ids to
 * `content` and render what comes back, so a fake `PublicPostReader` here
 * would test the handing-over and nothing about the three-way visibility rule
 * the ticket exists to apply.
 */
const build = async () => {
  const posts = new FakePostRepository();
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();
  const saves = new FakeSavedPostRepository();

  for (const member of [SAVER, OTHER, AUTHOR]) {
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: AT("2026-01-01T00:00:00.000Z"),
    });
  }

  const postService = new PostService(
    posts,
    categories,
    asProfileReader(profileRepo),
    host,
    undefined,
    saves,
  );

  const write = async (title: string, at: string) => {
    host.setNow(AT(at));
    return postService.create(AUTHOR, {
      categorySlug: "parking",
      title,
      content: `${title} — body`,
    });
  };

  return {
    posts,
    saves,
    host,
    postService,
    write,
    service: new SavedPostService(saves, posts, postService, host),
  };
};

describe("SavedPostService.save", () => {
  it("records a save and reports the viewer's state", async () => {
    const { service, write } = await build();
    const post = await write("Best lot near ISEC?", "2026-02-01T00:00:00.000Z");

    const result = await service.save(SAVER, post.id);

    expect(result).toEqual({ postId: post.id, viewerHasSaved: true });
  });

  it("is idempotent — a second save succeeds and creates no second row", async () => {
    const { service, saves, write } = await build();
    const post = await write("Best lot near ISEC?", "2026-02-01T00:00:00.000Z");

    await service.save(SAVER, post.id);
    const second = await service.save(SAVER, post.id);

    expect(second.viewerHasSaved).toBe(true);
    expect(saves.rows).toHaveLength(1);
  });

  it("keeps two people's saves of the same post apart", async () => {
    const { service, saves, write } = await build();
    const post = await write("Best lot near ISEC?", "2026-02-01T00:00:00.000Z");

    await service.save(SAVER, post.id);
    await service.save(OTHER, post.id);

    expect(saves.rows).toHaveLength(2);
  });

  it("stamps the save with the host clock, not the post's date", async () => {
    const { service, saves, host, write } = await build();
    const post = await write("Written in February", "2026-02-01T00:00:00.000Z");
    host.setNow(AT("2026-05-04T09:30:00.000Z"));

    await service.save(SAVER, post.id);

    expect(saves.rows[0]?.dateCreated).toEqual(AT("2026-05-04T09:30:00.000Z"));
  });

  it("refuses a save on an unknown post", async () => {
    const { service } = await build();

    await expect(service.save(SAVER, "post-nope")).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a save on a deleted post", async () => {
    const { service, posts, write } = await build();
    const post = await write("Gone", "2026-02-01T00:00:00.000Z");
    posts.rows.find((row) => row.id === post.id)!.deletedAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    await expect(service.save(SAVER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a save on a moderator-hidden post", async () => {
    const { service, posts, write } = await build();
    const post = await write("Hidden", "2026-02-01T00:00:00.000Z");
    posts.rows.find((row) => row.id === post.id)!.hiddenAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    await expect(service.save(SAVER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a save on a post by a block counterpart", async () => {
    const { service, host, write } = await build();
    const post = await write("Blocked", "2026-02-01T00:00:00.000Z");
    host.withBlocksFor(SAVER.userId, [AUTHOR.userId]);

    await expect(service.save(SAVER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });
});

describe("SavedPostService.unsave", () => {
  it("removes the save and reports the viewer's state", async () => {
    const { service, saves, write } = await build();
    const post = await write("Best lot near ISEC?", "2026-02-01T00:00:00.000Z");
    await service.save(SAVER, post.id);

    const result = await service.unsave(SAVER, post.id);

    expect(result).toEqual({ postId: post.id, viewerHasSaved: false });
    expect(saves.rows).toHaveLength(0);
  });

  it("does not fail when nothing was saved", async () => {
    const { service, write } = await build();
    const post = await write("Never saved", "2026-02-01T00:00:00.000Z");

    const result = await service.unsave(SAVER, post.id);

    expect(result.viewerHasSaved).toBe(false);
  });

  it("is idempotent — unsaving twice leaves one person's list untouched", async () => {
    const { service, saves, write } = await build();
    const post = await write("Best lot near ISEC?", "2026-02-01T00:00:00.000Z");
    await service.save(SAVER, post.id);
    await service.save(OTHER, post.id);

    await service.unsave(SAVER, post.id);
    await service.unsave(SAVER, post.id);

    expect(saves.rows).toHaveLength(1);
    expect(saves.rows[0]?.userId).toBe(OTHER.userId);
  });

  it("does not fail on a post id that was never there", async () => {
    const { service } = await build();

    const result = await service.unsave(SAVER, "post-nope");

    expect(result).toEqual({ postId: "post-nope", viewerHasSaved: false });
  });

  // The three reasons a saved post stops being visible, asserted apart,
  // because the point of SCRUM-693 is that they stop being one case.
  it("removes the save when the author has deleted the post", async () => {
    const { service, saves, posts, write } = await build();
    const post = await write("Gone", "2026-02-01T00:00:00.000Z");
    await service.save(SAVER, post.id);
    posts.rows.find((row) => row.id === post.id)!.deletedAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    const result = await service.unsave(SAVER, post.id);

    expect(result).toEqual({ postId: post.id, viewerHasSaved: false });
    expect(saves.rows).toHaveLength(0);
  });

  it("removes the save when a moderator has hidden the post", async () => {
    const { service, saves, posts, write } = await build();
    const post = await write("Hidden", "2026-02-01T00:00:00.000Z");
    await service.save(SAVER, post.id);
    posts.rows.find((row) => row.id === post.id)!.hiddenAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    const result = await service.unsave(SAVER, post.id);

    expect(result).toEqual({ postId: post.id, viewerHasSaved: false });
    expect(saves.rows).toHaveLength(0);
  });

  it("removes the save when the post is by a block counterpart", async () => {
    const { service, saves, host, write } = await build();
    const post = await write("Blocked", "2026-02-01T00:00:00.000Z");
    await service.save(SAVER, post.id);
    host.withBlocksFor(SAVER.userId, [AUTHOR.userId]);

    const result = await service.unsave(SAVER, post.id);

    expect(result).toEqual({ postId: post.id, viewerHasSaved: false });
    expect(saves.rows).toHaveLength(0);
  });
});

describe("SavedPostService.list", () => {
  /** Three posts, saved in an order that is not the order they were written. */
  const seedThree = async () => {
    const harness = await build();
    const first = await harness.write(
      "First written",
      "2026-02-01T00:00:00.000Z",
    );
    const second = await harness.write(
      "Second written",
      "2026-02-02T00:00:00.000Z",
    );
    const third = await harness.write(
      "Third written",
      "2026-02-03T00:00:00.000Z",
    );

    harness.host.setNow(AT("2026-03-01T00:00:00.000Z"));
    await harness.service.save(SAVER, second.id);
    harness.host.setNow(AT("2026-03-02T00:00:00.000Z"));
    await harness.service.save(SAVER, first.id);
    harness.host.setNow(AT("2026-03-03T00:00:00.000Z"));
    await harness.service.save(SAVER, third.id);

    return { ...harness, first, second, third };
  };

  it("orders by when each post was saved, newest save first", async () => {
    const { service } = await seedThree();

    const page = await service.list(SAVER);

    expect(page.posts.map((post) => post.title)).toEqual([
      "Third written",
      "First written",
      "Second written",
    ]);
  });

  it("marks every listed post as saved by the viewer", async () => {
    const { service } = await seedThree();

    const page = await service.list(SAVER);

    expect(page.posts.every((post) => post.viewerHasSaved)).toBe(true);
  });

  it("shows nobody else's saves", async () => {
    const { service, write } = await build();
    const post = await write("Theirs", "2026-02-01T00:00:00.000Z");
    await service.save(OTHER, post.id);

    const page = await service.list(SAVER);

    expect(page.posts).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("publishes no platform identity", async () => {
    const { service } = await seedThree();

    const page = await service.list(SAVER);

    expect(JSON.stringify(page)).not.toContain(AUTHOR.userId);
    expect(page.posts[0]).not.toHaveProperty("authorId");
    expect(page.posts[0]?.author).toEqual({ handle: "GarageGuru" });
  });

  it("pages to the end without repeating or dropping a save", async () => {
    const { service } = await seedThree();

    const titles: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.list(SAVER, { cursor, limit: 2 });
      titles.push(...page.posts.map((post) => post.title));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(2);
    expect(titles).toEqual([
      "Third written",
      "First written",
      "Second written",
    ]);
  });

  it("pages across saves made in the same millisecond", async () => {
    const { service, write, host } = await build();
    const posts = [];
    for (let n = 1; n <= 4; n += 1) {
      posts.push(await write(`Post ${n}`, `2026-02-0${n}T00:00:00.000Z`));
    }

    // One clock reading for all four saves: the `dateCreated` tie the `id`
    // tiebreak exists for, which a seed script or a burst produces readily.
    host.setNow(AT("2026-03-01T00:00:00.000Z"));
    for (const post of posts) {
      await service.save(SAVER, post.id);
    }

    const titles: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(SAVER, { cursor, limit: 2 });
      titles.push(...page.posts.map((post) => post.title));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(titles).toHaveLength(4);
    expect(new Set(titles).size).toBe(4);
  });

  it.each([
    ["deleted", "deletedAt" as const],
    ["moderator-hidden", "hiddenAt" as const],
  ])("quietly drops a saved post that has been %s", async (_label, column) => {
    const { service, posts, first } = await seedThree();
    posts.rows.find((row) => row.id === first.id)![column] = AT(
      "2026-04-01T00:00:00.000Z",
    );

    const page = await service.list(SAVER);

    expect(page.posts.map((post) => post.title)).toEqual([
      "Third written",
      "Second written",
    ]);
  });

  it("quietly drops a saved post whose author the viewer has since blocked", async () => {
    const { service, host } = await seedThree();
    host.withBlocksFor(SAVER.userId, [AUTHOR.userId]);

    const page = await service.list(SAVER);

    expect(page.posts).toHaveLength(0);
  });

  it("keeps the save row, so unblocking restores the entry", async () => {
    const { service, saves, host } = await seedThree();
    host.withBlocksFor(SAVER.userId, [AUTHOR.userId]);

    await service.list(SAVER);
    host.withBlocksFor(SAVER.userId, []);
    const page = await service.list(SAVER);

    expect(saves.rows).toHaveLength(3);
    expect(page.posts).toHaveLength(3);
  });

  /**
   * **The page is shorter; the cursor is not.** Filtering happens after the
   * keyset read, so a page whose rows have all rotted comes back empty while
   * saves remain behind it. Minting the cursor from the last *save row read*
   * rather than the last post shown is what keeps that from being a dead end.
   */
  it("still pages forward when every row on a page has rotted", async () => {
    const { service, posts, second, third } = await seedThree();
    for (const id of [third.id, second.id]) {
      posts.rows.find((row) => row.id === id)!.deletedAt = AT(
        "2026-04-01T00:00:00.000Z",
      );
    }

    const firstPage = await service.list(SAVER, { limit: 1 });
    expect(firstPage.posts).toHaveLength(0);
    expect(firstPage.nextCursor).not.toBeNull();

    const titles: string[] = [];
    let cursor = firstPage.nextCursor ?? undefined;
    while (cursor) {
      const page = await service.list(SAVER, { cursor, limit: 1 });
      titles.push(...page.posts.map((post) => post.title));
      cursor = page.nextCursor ?? undefined;
    }

    expect(titles).toEqual(["First written"]);
  });

  it("restarts from the newest save when handed a cursor it did not mint", async () => {
    const { service } = await seedThree();

    const page = await service.list(SAVER, { cursor: "not-a-cursor" });

    expect(page.posts[0]?.title).toBe("Third written");
  });

  it("does not ask for post data when the viewer has saved nothing", async () => {
    const { service, saves } = await build();

    const page = await service.list(SAVER);

    expect(page.posts).toHaveLength(0);
    expect(saves.lookups).toBe(0);
  });
});

describe("SavedPostService and the feed", () => {
  it("marks a saved post in the feed and in the thread", async () => {
    const { service, postService, write } = await build();
    const saved = await write("Saved", "2026-02-01T00:00:00.000Z");
    await write("Not saved", "2026-02-02T00:00:00.000Z");
    await service.save(SAVER, saved.id);

    const reader: CommunityActor = SAVER;
    const feed = await postService.list(reader);
    const byTitle = new Map(feed.posts.map((p) => [p.title, p.viewerHasSaved]));
    const thread = await postService.byId(reader, saved.id);

    expect(byTitle.get("Saved")).toBe(true);
    expect(byTitle.get("Not saved")).toBe(false);
    expect(thread.viewerHasSaved).toBe(true);
  });

  it("reports viewerHasSaved false for a reader who saved nothing", async () => {
    const { service, postService, write } = await build();
    const post = await write(
      "Saved by someone else",
      "2026-02-01T00:00:00.000Z",
    );
    await service.save(OTHER, post.id);

    const feed = await postService.list(SAVER);

    expect(feed.posts[0]?.viewerHasSaved).toBe(false);
  });
});
