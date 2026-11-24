import type { Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import {
  FakeCategoryRepository,
  FakePostRepository,
} from "../testing/fakeContentRepositories";
import { ContentUnavailableError } from "../shared/errors";
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
/** The person doing the reading. Member tier, because this endpoint is. */
const VIEWER: Member = {
  kind: "member",
  userId: "user-9",
  profile: { id: "p9", handle: "Reader" },
};

const build = async () => {
  const posts = new FakePostRepository();
  const categories = FakeCategoryRepository.withDefaults();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  for (const member of [AVERY, PARKER, VIEWER]) {
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

  /** Writes a post as `member`, at a time the test chooses. */
  const write = async (member: Member, title: string, at: string) => {
    host.setNow(new Date(at));
    return service.create(member, {
      categorySlug: "commuting",
      title,
      content: `${title} body`,
    });
  };

  return { posts, host, service, write };
};

describe("PostService.listByHandle", () => {
  it("lists one handle's posts, newest first", async () => {
    const { service, write } = await build();
    await write(AVERY, "Earlier", "2026-02-01T00:00:00.000Z");
    await write(PARKER, "Not Avery's", "2026-02-02T00:00:00.000Z");
    await write(AVERY, "Later", "2026-02-03T00:00:00.000Z");

    const page = await service.listByHandle(VIEWER, { handle: "Avery" });

    expect(page.posts.map((post) => post.title)).toEqual(["Later", "Earlier"]);
    expect(page.nextCursor).toBeNull();
  });

  it("resolves the handle through the same normalizer that claimed it", async () => {
    const { service, write } = await build();
    await write(AVERY, "Garage rates", "2026-02-01T00:00:00.000Z");

    const page = await service.listByHandle(VIEWER, { handle: "AVERY" });

    expect(page.posts.map((post) => post.title)).toEqual(["Garage rates"]);
  });

  it("omits deleted and hidden posts", async () => {
    const { service, posts, write } = await build();
    const kept = await write(AVERY, "Kept", "2026-02-01T00:00:00.000Z");
    const deleted = await write(AVERY, "Deleted", "2026-02-02T00:00:00.000Z");
    const hidden = await write(AVERY, "Hidden", "2026-02-03T00:00:00.000Z");

    posts.rows.find((row) => row.id === deleted.id)!.deletedAt = new Date();
    posts.rows.find((row) => row.id === hidden.id)!.hiddenAt = new Date();

    const page = await service.listByHandle(VIEWER, { handle: "avery" });

    expect(page.posts.map((post) => post.id)).toEqual([kept.id]);
  });

  it("refuses a handle nobody has claimed", async () => {
    const { service } = await build();

    await expect(
      service.listByHandle(VIEWER, { handle: "nobody" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("refuses a handle the viewer has a block with, identically to an absent one", async () => {
    const { service, host, write } = await build();
    await write(AVERY, "Garage rates", "2026-02-01T00:00:00.000Z");
    host.withBlocksFor(VIEWER.userId, [AVERY.userId]);

    const blocked = await service
      .listByHandle(VIEWER, { handle: "avery" })
      .catch((error) => error);
    const absent = await service
      .listByHandle(VIEWER, { handle: "nobody" })
      .catch((error) => error);

    // An empty list would say "this handle exists and has written nothing",
    // which on a blocked pair is a disclosure. Both refuse, and identically.
    expect(blocked).toBeInstanceOf(ContentUnavailableError);
    expect(blocked.message).toBe(absent.message);
  });

  it("refuses a handle that could never be claimed, as absent", async () => {
    const { service } = await build();

    await expect(
      service.listByHandle(VIEWER, { handle: "no spaces" }),
    ).rejects.toThrow(ContentUnavailableError);
  });

  it("lists a handle that has written nothing as an empty page", async () => {
    const { service } = await build();

    const page = await service.listByHandle(VIEWER, { handle: "Parker" });

    // Distinct from the refusal above: this handle is real and visible, so the
    // page is empty rather than absent.
    expect(page.posts).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages across posts written in the same millisecond without dropping or repeating one", async () => {
    const { service, write } = await build();
    const sameMoment = "2026-02-01T00:00:00.000Z";
    for (const title of ["a", "b", "c", "d"]) {
      await write(AVERY, title, sameMoment);
    }

    const first = await service.listByHandle(VIEWER, {
      handle: "avery",
      limit: 2,
    });
    const second = await service.listByHandle(VIEWER, {
      handle: "avery",
      limit: 2,
      cursor: first.nextCursor!,
    });

    const seen = [...first.posts, ...second.posts].map((post) => post.id);
    // Four distinct posts, every one of them, exactly once — which only holds
    // because the keyset tiebreaks on `id` behind a `dateCreated` they share.
    expect(new Set(seen).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it("carries the viewer's own vote and save state, not the author's", async () => {
    const { service, write } = await build();
    await write(AVERY, "Garage rates", "2026-02-01T00:00:00.000Z");

    const [post] = (await service.listByHandle(VIEWER, { handle: "avery" }))
      .posts;

    expect(post).toMatchObject({
      author: { handle: "Avery" },
      viewerHasVoted: false,
      viewerHasSaved: false,
    });
  });
});
