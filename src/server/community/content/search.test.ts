import type { CommunityActor, Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { TextTooLongError } from "../shared/errors";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../testing/fakeContentRepositories";
import { SEARCH_TERM_MAX_LENGTH } from "./domain/searchTerm";
import { PostService } from "./service";

const AVERY: Member = {
  kind: "member",
  userId: "user-1",
  profile: { id: "p1", handle: "Avery" },
};
const PARKER: Member = {
  kind: "member",
  userId: "user-2",
  profile: { id: "p2", handle: "Parker" },
};
/** Student tier, because searching is reading and reading needs no handle. */
const READER: CommunityActor = { kind: "student", userId: "user-9" };

const build = async () => {
  const posts = new FakePostRepository();
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AVERY, PARKER]) {
    await profileRepo.insert({
      userId: member.userId,
      handle: member.profile.handle,
      handleNormalized: member.profile.handle.toLowerCase(),
      dateCreated: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const service = new PostService(
    posts,
    categories,
    asProfileReader(profileRepo),
    host,
  );

  /** Writes a post as `member`, at a time and in a category the test chooses. */
  const write = async (
    member: Member,
    fields: {
      title: string;
      content: string;
      at: string;
      categorySlug?: string;
    },
  ) => {
    host.setNow(new Date(fields.at));
    return service.create(member, {
      categorySlug: fields.categorySlug ?? "commuting",
      title: fields.title,
      content: fields.content,
    });
  };

  return { posts, host, service, write };
};

describe("PostService.list with a search term", () => {
  it("matches a term in the title", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Garage rates went up",
      content: "Anyone else notice",
      at: "2026-02-01T00:00:00.000Z",
    });
    await write(AVERY, {
      title: "Shuttle timetable",
      content: "Unrelated",
      at: "2026-02-02T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.title)).toEqual([
      "Garage rates went up",
    ]);
  });

  it("matches a term in the content", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "A question",
      content: "Where do people park near the garage?",
      at: "2026-02-01T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.title)).toEqual(["A question"]);
  });

  it("matches regardless of case", async () => {
    // MySQL's default collation is case-insensitive, so the fake must be too —
    // a case-sensitive fake would pass tests the real query fails.
    const { service, write } = await build();
    await write(AVERY, {
      title: "GARAGE rates",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.title)).toEqual(["GARAGE rates"]);
  });

  it("omits posts that match neither title nor content", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Shuttle timetable",
      content: "Nothing about parking",
      at: "2026-02-01T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("treats a percent in the term as a literal character", async () => {
    // Unescaped, `50%` is "50 followed by anything" and would match both.
    const { service, write } = await build();
    await write(AVERY, {
      title: "Rates up 50% this year",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    await write(AVERY, {
      title: "50 spaces left",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "50%" });

    expect(page.posts.map((post) => post.title)).toEqual([
      "Rates up 50% this year",
    ]);
  });

  it("treats an underscore in the term as a literal character", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Use the a_b form",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    await write(AVERY, {
      title: "Use the axb form",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "a_b" });

    expect(page.posts.map((post) => post.title)).toEqual(["Use the a_b form"]);
  });

  it("narrows by category and term together", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Garage in commuting",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
      categorySlug: "commuting",
    });
    await write(AVERY, {
      title: "Garage in parking",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
      categorySlug: "parking",
    });

    const page = await service.list(READER, {
      search: "garage",
      categorySlug: "parking",
    });

    expect(page.posts.map((post) => post.title)).toEqual(["Garage in parking"]);
  });

  it("omits deleted and hidden posts, as every other read does", async () => {
    const { service, posts, write } = await build();
    const kept = await write(AVERY, {
      title: "Garage kept",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    const deleted = await write(AVERY, {
      title: "Garage deleted",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
    });
    const hidden = await write(AVERY, {
      title: "Garage hidden",
      content: "body",
      at: "2026-02-03T00:00:00.000Z",
    });

    posts.rows.find((row) => row.id === deleted.id)!.deletedAt = new Date();
    posts.rows.find((row) => row.id === hidden.id)!.hiddenAt = new Date();

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.id)).toEqual([kept.id]);
  });

  it("omits posts by an author the reader has a block with", async () => {
    const { service, host, write } = await build();
    const mine = await write(PARKER, {
      title: "Garage from Parker",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    await write(AVERY, {
      title: "Garage from Avery",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
    });
    host.withBlocksFor(READER.userId, [AVERY.userId]);

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.id)).toEqual([mine.id]);
  });

  it("returns matches newest first", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Garage earlier",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    await write(AVERY, {
      title: "Garage later",
      content: "body",
      at: "2026-02-03T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "garage" });

    expect(page.posts.map((post) => post.title)).toEqual([
      "Garage later",
      "Garage earlier",
    ]);
  });

  it("ranks matches by vote count when asked for the top sort", async () => {
    const { service, posts, write } = await build();
    const quiet = await write(AVERY, {
      title: "Garage quiet",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });
    const popular = await write(AVERY, {
      title: "Garage popular",
      content: "body",
      at: "2026-02-02T00:00:00.000Z",
    });
    posts.rows.find((row) => row.id === popular.id)!.voteCount = 9;

    const page = await service.list(READER, { search: "garage", sort: "top" });

    // Newest-first would have put `quiet` second; the vote count reorders them,
    // which is the whole reason a searcher can ask for Top.
    expect(page.posts.map((post) => post.id)).toEqual([popular.id, quiet.id]);
  });

  it("pages matches without dropping or repeating one", async () => {
    const { service, write } = await build();
    const sameMoment = "2026-02-01T00:00:00.000Z";
    for (const suffix of ["a", "b", "c", "d"]) {
      await write(AVERY, {
        title: `Garage ${suffix}`,
        content: "body",
        at: sameMoment,
      });
    }
    await write(AVERY, {
      title: "Shuttle",
      content: "no match",
      at: sameMoment,
    });

    const first = await service.list(READER, { search: "garage", limit: 2 });
    const second = await service.list(READER, {
      search: "garage",
      limit: 2,
      cursor: first.nextCursor!,
    });

    const seen = [...first.posts, ...second.posts].map((post) => post.id);
    // Four matches, each exactly once — which holds only because the keyset
    // tiebreaks on `id` behind a `dateCreated` all four share.
    expect(new Set(seen).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it("reads a blank term as the unfiltered feed rather than a search for nothing", async () => {
    const { service, write } = await build();
    await write(AVERY, {
      title: "Shuttle timetable",
      content: "body",
      at: "2026-02-01T00:00:00.000Z",
    });

    const page = await service.list(READER, { search: "   " });

    expect(page.posts.map((post) => post.title)).toEqual(["Shuttle timetable"]);
  });

  it("refuses a term longer than the cap", async () => {
    const { service } = await build();

    await expect(
      service.list(READER, { search: "x".repeat(SEARCH_TERM_MAX_LENGTH + 1) }),
    ).rejects.toThrow(TextTooLongError);
  });
});
