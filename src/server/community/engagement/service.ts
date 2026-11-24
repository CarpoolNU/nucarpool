import type { Member } from "../actor";
import type { PostReader } from "../content/ports";
import type { CommunityHostPort } from "../host/CommunityHostPort";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import { clampPageSize } from "../shared/paging";
import { ContentUnavailableError } from "../shared/errors";
import type { PublicPostReader } from "../content/public";
import type { SavedPostRepository, VoteRepository } from "./ports";
import type { SavedPostPage, SaveResult, VoteResult } from "./public";

/**
 * Upvoting, as an explicit idempotent pair.
 *
 * **`vote` and `unvote` are separate operations, never a toggle** (spec
 * §10.1). A toggle has the property that a retried request — which any flaky
 * network produces — inverts the user's intent instead of repeating it. These
 * two repeat it: voting twice leaves one vote, unvoting twice leaves none.
 *
 * **The service does not ask whether the user has already voted.** That read
 * would race another request from the same user and both would insert; the
 * `@@unique([userId, postId])` index is the only arbiter either consults, and
 * the repository reports its verdict as a return value rather than an error.
 */
export class VoteService {
  constructor(
    private readonly votes: VoteRepository,
    private readonly posts: PostReader,
    private readonly host: CommunityHostPort,
  ) {}

  async vote(actor: Member, postId: string): Promise<VoteResult> {
    await this.requireVisiblePost(actor.userId, postId);

    const outcome = await this.votes.insert({
      userId: actor.userId,
      postId,
      dateCreated: this.host.now(),
    });

    // The post vanished between the visibility check and the lock — the §6.2
    // race, losing. Reported as the same refusal as every other reason it is
    // not there, so the four cases stay indistinguishable.
    if (outcome === "no-post") {
      throw new ContentUnavailableError();
    }

    // `already-voted` is a success. The caller asked for the post to be voted
    // on by them, and it is.
    return this.resultFor(postId, true);
  }

  async unvote(actor: Member, postId: string): Promise<VoteResult> {
    await this.requireVisiblePost(actor.userId, postId);

    // `not-voted` is equally a success, and the repository has already
    // declined to decrement — which is what keeps a double-unvote from taking
    // the counter below what the rows justify (spec §9.2).
    await this.votes.remove({ userId: actor.userId, postId });

    return this.resultFor(postId, false);
  }

  private async resultFor(
    postId: string,
    viewerHasVoted: boolean,
  ): Promise<VoteResult> {
    return {
      postId,
      voteCount: await this.votes.countFor(postId),
      viewerHasVoted,
    };
  }

  /**
   * Refuses a vote on content the caller may not see.
   *
   * Voting is a write, so this matters for more than tidiness: without it a
   * user could move the counter on a post they have been blocked away from,
   * and the moving count would tell them the post is there.
   */
  private async requireVisiblePost(
    userId: string,
    postId: string,
  ): Promise<void> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(userId);
    const post = await this.posts.findVisibleById(postId, excludeAuthorIds);
    if (!post) {
      throw new ContentUnavailableError();
    }
  }
}

/**
 * Bookmarks, as an explicit idempotent pair.
 *
 * **The same shape as {@link VoteService}, deliberately** (spec §10.1): `save`
 * and `unsave` are separate operations, never a toggle, so a retried request —
 * which any flaky network produces — repeats the user's intent instead of
 * inverting it. The `@@unique([userId, postId])` pair on
 * `community_saved_post` is the arbiter, and nothing here asks "has this user
 * already saved it?" before writing.
 *
 * **What a save is *for* is the part that is not votes.** A vote is a signal
 * about a post; a save is a place a person is coming back to. The board's
 * subject matter — parking, gas, commute timing, co-op logistics — is
 * reference material, and reference material that cannot be kept has to be
 * re-found, which in a chronological feed means it is effectively gone.
 *
 * **Where it stops matching `VoteService`: only `save` checks visibility.**
 * A save row outlives the post behind it on purpose, so the question the pair
 * has to answer is whether it can also outlive the reader's ability to remove
 * it. It cannot — `unsave` takes the row whatever state the post is in, and
 * says there why the §7.2 disclosure argument that justifies the guard on
 * `save` does not reach the half that removes what the reader already has.
 */
export class SavedPostService {
  constructor(
    private readonly saves: SavedPostRepository,
    private readonly posts: PostReader,
    private readonly publicPosts: PublicPostReader,
    private readonly host: CommunityHostPort,
  ) {}

  async save(actor: Member, postId: string): Promise<SaveResult> {
    await this.requireVisiblePost(actor.userId, postId);

    // `already-saved` is a success. The caller asked for the post to be in
    // their list, and it is.
    await this.saves.insert({
      userId: actor.userId,
      postId,
      dateCreated: this.host.now(),
    });

    return { postId, viewerHasSaved: true };
  }

  /**
   * Removes a save, whether or not the post behind it can still be read.
   *
   * **No visibility guard, unlike {@link save}.** The guard earns its place
   * on the write that creates the row: without it, whether the save succeeded
   * would tell a blocked reader the post is still there (spec §7.2). On the
   * write that removes one it buys nothing and costs the row. The caller is
   * naming a post id in their own list, and the reply does not vary —
   * `remove` answers `not-saved` for an id they never saved and for one whose
   * post is gone alike, and both arrive here as `viewerHasSaved: false`.
   *
   * What the guard did instead was strand the row. A deleted or hidden post
   * is filtered out of {@link list}, so the reader could not see it to unsave
   * it, and `unsave` would have refused them if they had tried: a permanent
   * row, costing a slot in every keyset page, with no path to removal through
   * any procedure.
   *
   * **The block doctrine is untouched.** Nothing sweeps rows, {@link list}
   * still filters a blocked author's post rather than deleting the save, and
   * no control renders for a row that is off the page — so unblocking
   * restores the entry, unless the reader named that post id themselves,
   * which is their own intent rather than this module acting on their list.
   */
  async unsave(actor: Member, postId: string): Promise<SaveResult> {
    // `not-saved` is equally a success, for the same reason.
    await this.saves.remove({ userId: actor.userId, postId });

    return { postId, viewerHasSaved: false };
  }

  /**
   * One page of the viewer's saved list, newest save first.
   *
   * **Paged over the saves, filtered by the posts.** The keyset runs on
   * `@@index([userId, dateCreated, id])` over `community_saved_post`, so the
   * cursor is a position among this person's bookmarks — not among posts,
   * whose own dates have nothing to do with the order here.
   *
   * **A saved row outlives the post behind it**, in all three of the ways a
   * post stops being visible: the author deletes it, a moderator hides it, or
   * the viewer blocks the author. The row is kept in every case — NUCarpool's
   * block doctrine is to filter where content is read, never to delete, so
   * unblocking restores the entry exactly — and the post is simply absent from
   * the page.
   *
   * **Nothing tells the viewer that happened.** A count of unavailable saves
   * would be a way to learn that a specific blocked person's post still
   * exists, which is the §7.2 reasoning the rest of the module implements; and
   * a list that refused to render because one row had rotted would be worse
   * than one that is quietly shorter.
   *
   * **A kept row is not a stuck one.** It is absent from the page, not from
   * the table, and {@link unsave} will remove it on request for any of the
   * three — which is what keeps "the row survives" from meaning "the row
   * accumulates forever".
   */
  async list(
    actor: Member,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<SavedPostPage> {
    const limit = clampPageSize(input.limit);

    // One more row than the page, so "is there another page?" is answered
    // without a second query. A stale or mangled cursor decodes to `null` and
    // restarts the list, which is a mild surprise rather than a broken page.
    const rows = await this.saves.list({
      userId: actor.userId,
      after: input.cursor ? decodeCursor(input.cursor, "new") : null,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const posts = await this.publicPosts.visibleByIds(
      actor,
      page.map((row) => row.postId),
    );

    // **The cursor comes from the last save read, not the last post shown.**
    // Filtering happens after the keyset read, so a page whose rows have all
    // rotted yields no posts — and minting the cursor from the posts would
    // leave the reader with nothing to page past, stuck on a run of dead rows
    // with more saves behind it.
    const last = page[page.length - 1];
    return {
      posts: [...posts],
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sort: "new",
              dateCreated: last.dateCreated,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Refuses a save on content the caller may not see.
   *
   * The same guard as {@link VoteService}, and it matters for the same reason:
   * without it a person could confirm, by whether the save succeeded, that a
   * post they have been blocked away from is still there.
   *
   * **It guards {@link save} and not {@link unsave}**, which is the one place
   * this service departs from `VoteService`'s symmetry. `unsave` says why.
   */
  private async requireVisiblePost(
    userId: string,
    postId: string,
  ): Promise<void> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(userId);
    const post = await this.posts.findVisibleById(postId, excludeAuthorIds);
    if (!post) {
      throw new ContentUnavailableError();
    }
  }
}
