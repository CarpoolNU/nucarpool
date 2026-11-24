import { router } from "../createRouter";
import { commentsRouter } from "./comments";
import { moderationRouter } from "./moderation";
import { postsRouter } from "./posts";
import { profilesRouter } from "./profiles";
import { reportsRouter } from "./reports";
import { savedRouter } from "./saved";
import { votesRouter } from "./votes";

/**
 * The community router.
 *
 * Mounted in NUCarpool with one line in `src/server/router/index.ts`:
 *
 *     community: communityRouter,
 *
 * The frontend is typed from `AppRouter`, so every call site breaks at compile
 * time if a procedure here is renamed. That is intentional.
 */
export const communityRouter = router({
  profiles: profilesRouter,
  posts: postsRouter,
  comments: commentsRouter,
  votes: votesRouter,
  saved: savedRouter,
  reports: reportsRouter,
  moderation: moderationRouter,
});
