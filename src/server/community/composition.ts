import { BudgetService } from "./budget/service";
import {
  PrismaBudgetRepository,
  type BudgetStore,
} from "./budget/prismaBudgetRepository";
import { CommentService, PostService } from "./content/service";
import {
  PrismaCategoryRepository,
  PrismaCommentRepository,
  PrismaPostRepository,
  type CategoryStore,
  type CommentStore,
  type PostStore,
} from "./content/prismaContentRepositories";
import { SavedPostService, VoteService } from "./engagement/service";
import {
  PrismaVoteRepository,
  type VoteStore,
} from "./engagement/prismaVoteRepository";
import {
  PrismaSavedPostRepository,
  type SavedPostStore,
} from "./engagement/prismaSavedPostRepository";
import { ContentTargets } from "./content/targets";
import type { CommunityHostPort } from "./host/CommunityHostPort";
import { ProfileService, asProfileReader } from "./identity/service";
import {
  PrismaProfileRepository,
  type ProfileStore,
} from "./identity/prismaProfileRepository";
import {
  PrismaReportRepository,
  type ReportStore,
} from "./moderation/prismaReportRepository";
import { ModerationService, ReportService } from "./moderation/service";

/**
 * The composition root.
 *
 * **The only place concrete repositories meet services.** Everything else in
 * the module names interfaces, which is what lets the whole business layer be
 * exercised against fakes. Wiring lives here so there is one file to read to
 * know what depends on what.
 */

export type CommunityStore = ProfileStore &
  CategoryStore &
  PostStore &
  CommentStore &
  VoteStore &
  SavedPostStore &
  ReportStore &
  BudgetStore;

export type CommunityServices = {
  profiles: ProfileService;
  posts: PostService;
  comments: CommentService;
  votes: VoteService;
  saved: SavedPostService;
  reports: ReportService;
  moderation: ModerationService;
  /**
   * The per-action write budget.
   *
   * Reached from the `budgeted` middleware in
   * `src/server/router/community/procedures.ts`, and from nowhere else — no
   * other service takes a budget dependency, which is the point of enforcing at
   * the transport tier rather than inside the services.
   */
  budgets: BudgetService;
};

export const createCommunityServices = (
  store: CommunityStore,
  host: CommunityHostPort,
): CommunityServices => {
  const profileRepository = new PrismaProfileRepository(store);
  const categoryRepository = new PrismaCategoryRepository(store);
  const postRepository = new PrismaPostRepository(store);
  const commentRepository = new PrismaCommentRepository(store);
  const voteRepository = new PrismaVoteRepository(store);
  const savedPostRepository = new PrismaSavedPostRepository(store);
  const reportRepository = new PrismaReportRepository(store);
  const budgetRepository = new PrismaBudgetRepository(store);

  // `content` gets the read-only reader, never the repository — so it has no
  // way to reach `insert` on someone else's table.
  const profileReader = asProfileReader(profileRepository);

  // The vote and saved-post repositories arrive as the `ViewerVoteReader` and
  // `ViewerSaveReader` interfaces `content` declares, so the feed renders both
  // kinds of viewer state without `content` importing `engagement` — while
  // `engagement` takes only the read-only `PostReader` and `PublicPostReader`.
  // Neither module can reach the other's writes, and no cycle forms. This is
  // the only file that knows both exist.
  //
  // It is named rather than inlined because two things need it: the feed, and
  // the saved list, which renders its page of bookmarks *through* it rather
  // than assembling a second version of a public post.
  const postService = new PostService(
    postRepository,
    categoryRepository,
    profileReader,
    host,
    voteRepository,
    savedPostRepository,
  );

  // `moderation` reaches `content` through this one object: it reads a target
  // as a report subject and hides it, and never sees a post or comment
  // repository. It is named rather than inlined because both services take it —
  // `ReportService` as the reader and the hider (the auto-hide), and
  // `ModerationService` as the hider only.
  const contentTargets = new ContentTargets(postRepository, commentRepository);

  return {
    profiles: new ProfileService(profileRepository, host),
    posts: postService,
    comments: new CommentService(
      commentRepository,
      postRepository,
      profileReader,
      host,
    ),
    votes: new VoteService(voteRepository, postRepository, host),
    // The saved list takes `postService` as the `PublicPostReader` that
    // `content` publishes — so the three-way visibility rule, the handles and
    // the slugs are the feed's, not a second copy — and the post *repository*
    // as the read-only `PostReader` that refuses a save on content the caller
    // cannot see. Neither direction reaches the other module's writes.
    saved: new SavedPostService(
      savedPostRepository,
      postRepository,
      postService,
      host,
    ),
    reports: new ReportService(
      reportRepository,
      contentTargets,
      contentTargets,
      host,
    ),
    // The queue resolves reporter handles through the read-only
    // `profileReader`, as `content` does, so `moderation` has no way to reach
    // `insert` on someone else's table.
    moderation: new ModerationService(
      reportRepository,
      contentTargets,
      profileReader,
      host,
    ),
    budgets: new BudgetService(budgetRepository, host),
  };
};
