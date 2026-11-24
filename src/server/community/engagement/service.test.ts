import type { Member } from "../actor";
import { FakeCommunityHost } from "../host/fakeHost";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import { FakeVoteRepository } from "../testing/fakeVoteRepository";
import { ContentUnavailableError } from "../shared/errors";
import { VoteService } from "./service";

const VOTER: Member = {
  kind: "member",
  userId: "user-1",
  profile: { id: "p1", handle: "HuskyCommuter" },
};
const OTHER: Member = {
  kind: "member",
  userId: "user-2",
  profile: { id: "p2", handle: "Parker" },
};
const AUTHOR_ID = "user-7";

const AT = (iso: string) => new Date(iso);

const build = async () => {
  const posts = new FakePostRepository();
  const votes = new FakeVoteRepository(posts);
  const host = new FakeCommunityHost();

  const post = await posts.insert({
    authorId: AUTHOR_ID,
    categoryId: "cat-parking",
    title: "Best lot near ISEC?",
    content: "Under $10 a day ideally.",
    dateCreated: AT("2026-02-01T00:00:00.000Z"),
  });

  return {
    posts,
    votes,
    host,
    post,
    service: new VoteService(votes, posts, host),
  };
};

describe("VoteService.vote", () => {
  it("records a vote and reports the new count", async () => {
    const { service, post } = await build();

    const result = await service.vote(VOTER, post.id);

    expect(result).toEqual({
      postId: post.id,
      voteCount: 1,
      viewerHasVoted: true,
    });
  });

  it("is idempotent — a second vote changes nothing and does not throw", async () => {
    const { service, posts, post } = await build();

    await service.vote(VOTER, post.id);
    const second = await service.vote(VOTER, post.id);

    expect(second.voteCount).toBe(1);
    expect(second.viewerHasVoted).toBe(true);
    expect(posts.rows.find((row) => row.id === post.id)?.voteCount).toBe(1);
  });

  it("counts two different voters separately", async () => {
    const { service, post } = await build();

    await service.vote(VOTER, post.id);
    const result = await service.vote(OTHER, post.id);

    expect(result.voteCount).toBe(2);
  });

  it("refuses a vote on an unknown post", async () => {
    const { service } = await build();

    await expect(service.vote(VOTER, "post-nope")).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a vote on a deleted post", async () => {
    const { service, posts, post } = await build();
    posts.rows.find((row) => row.id === post.id)!.deletedAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    await expect(service.vote(VOTER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a vote on a moderator-hidden post", async () => {
    const { service, posts, post } = await build();
    posts.rows.find((row) => row.id === post.id)!.hiddenAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    await expect(service.vote(VOTER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });

  it("refuses a vote on a post by a block counterpart", async () => {
    const { service, host, post } = await build();
    host.withBlocksFor(VOTER.userId, [AUTHOR_ID]);

    await expect(service.vote(VOTER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });
});

describe("VoteService.unvote", () => {
  it("removes a vote and reports the new count", async () => {
    const { service, post } = await build();
    await service.vote(VOTER, post.id);

    const result = await service.unvote(VOTER, post.id);

    expect(result).toEqual({
      postId: post.id,
      voteCount: 0,
      viewerHasVoted: false,
    });
  });

  it("is idempotent — unvoting twice does not decrement twice", async () => {
    const { service, posts, post } = await build();
    await service.vote(VOTER, post.id);
    await service.vote(OTHER, post.id);

    await service.unvote(VOTER, post.id);
    const second = await service.unvote(VOTER, post.id);

    expect(second.voteCount).toBe(1);
    expect(posts.rows.find((row) => row.id === post.id)?.voteCount).toBe(1);
  });

  it("does not decrement when the caller never voted", async () => {
    const { service, posts, post } = await build();
    await service.vote(OTHER, post.id);

    const result = await service.unvote(VOTER, post.id);

    expect(result.voteCount).toBe(1);
    expect(posts.rows.find((row) => row.id === post.id)?.voteCount).toBe(1);
  });

  it("never takes a count below zero", async () => {
    const { service, posts, post } = await build();

    await service.unvote(VOTER, post.id);

    expect(posts.rows.find((row) => row.id === post.id)?.voteCount).toBe(0);
  });

  it("refuses an unvote on a post the caller may not see", async () => {
    const { service, posts, post } = await build();
    posts.rows.find((row) => row.id === post.id)!.hiddenAt = AT(
      "2026-02-02T00:00:00.000Z",
    );

    await expect(service.unvote(VOTER, post.id)).rejects.toThrow(
      ContentUnavailableError,
    );
  });
});
