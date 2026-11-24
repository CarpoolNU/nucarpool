import type { PublicPost } from "../content/public";

/**
 * What a vote change tells the caller.
 *
 * **It returns the count and the viewer's own state, not the vote row.** The
 * row's id is useless to a client — `unvote` is addressed by `postId`, not by
 * vote id — and returning it would invite a client to treat a vote as a
 * resource it can enumerate. Who voted for what is not public.
 *
 * `voteCount` is the stored, advisory counter (spec §9.1), which is what every
 * other surface renders, so returning it here keeps a just-voted post
 * consistent with the feed rather than briefly ahead of it.
 */
export type VoteResult = {
  postId: string;
  voteCount: number;
  viewerHasVoted: boolean;
};

/**
 * What a save change tells the caller.
 *
 * **No count, unlike {@link VoteResult}.** How many people have saved a post
 * is not shown anywhere and is not anyone's business: a bookmark is private to
 * the person who made it, so there is no denormalized counter and nothing to
 * return but the viewer's own state.
 */
export type SaveResult = {
  postId: string;
  viewerHasSaved: boolean;
};

/**
 * One page of the saved list.
 *
 * **`posts` can be shorter than the page size while `nextCursor` is not
 * null**, and that is the design rather than a leak. A saved row outlives the
 * post behind it, so a page of saves can yield fewer posts than it read; the
 * cursor tracks the saves, which is what lets the list page past a run of
 * rotted rows instead of dead-ending on one.
 */
export type SavedPostPage = {
  posts: PublicPost[];
  /** `null` means this was the last page of *saves*. */
  nextCursor: string | null;
};
