/**
 * The feed.
 *
 * **New and Top, both in the URL** (SCRUM-681). The sort and the category are
 * read out of `router.query` rather than held in component state, because a
 * filtered or ranked feed is a thing people send each other; `feedView.ts`
 * owns both directions of that translation.
 *
 * **Paged with `useInfiniteQuery`, not `useQuery`** (SCRUM-680). The keyset
 * cursor the service returns is what drives it; a plain `useQuery` here read
 * that cursor only to print a sentence saying more posts existed, with no way
 * to reach them.
 *
 * **Guarded on the server, so it never waits for a session.**
 * `communityPageGuard` 404s the page while Community is off and redirects
 * anyone who is signed out or not onboarded. By the time this renders, every
 * query has a reader to run for.
 */
import Link from "next/link";
import { useRouter } from "next/router";
import { trpc } from "../../utils/trpc";
import {
  CategoryChip,
  CommunityShell,
  EmptyState,
  ListFooter,
  SortTab,
} from "../../components/community/shell";
import { feedHref, readFeedView } from "../../components/community/feedView";
import { listFooterState } from "../../components/community/listFooterState";
import { readableError } from "../../components/community/readableError";
import { PostRow } from "../../components/community/postRow";
import PageTitle from "../../components/PageTitle";
import { communityPageGuard } from "../../utils/community/pageGuard";

export const getServerSideProps = communityPageGuard;

const Feed = () => {
  const router = useRouter();

  // The category and the sort both arrive from the URL so either feed is
  // shareable. `readFeedView` is where the `string | string[]` Next hands back
  // is narrowed and an unknown sort is turned back into the default.
  const view = readFeedView(router.query);
  const { categorySlug, sort } = view;

  const me = trpc.community.profiles.me.useQuery();
  const categories = trpc.community.posts.categories.useQuery();
  // Both the category and the sort are part of the query key, so changing
  // either starts a fresh paged query rather than appending pages read under
  // the old one — which on a sort change would also mean replaying a cursor
  // the server is about to refuse.
  const feed = trpc.community.posts.list.useInfiniteQuery(
    { ...(categorySlug ? { categorySlug } : {}), sort },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const utils = trpc.useUtils();

  const isMember = me.data !== null && me.data !== undefined;
  const pages = feed.data?.pages ?? [];
  const posts = pages.flatMap((page) => page.posts);
  const footer = listFooterState({
    isLoading: feed.isLoading,
    isFetchingNextPage: feed.isFetchingNextPage,
    hasNextPage: feed.hasNextPage,
    itemCount: posts.length,
    pagesLoaded: pages.length,
    // A refused feed is not an empty one: `/community?category=bogus` is a
    // NOT_FOUND, and "No posts here yet" under it is a claim about the board
    // that the server never made (SCRUM-692).
    error: readableError(feed.error?.message),
  });

  return (
    <CommunityShell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Each chip carries the current sort, and each tab the current
            category, so neither control silently resets the other. */}
        <nav aria-label="Categories" className="flex flex-wrap gap-1">
          <CategoryChip
            href={feedHref({ sort })}
            label="All"
            active={!categorySlug}
          />
          {(categories.data ?? []).map((category) => (
            <CategoryChip
              key={category.slug}
              href={feedHref({ categorySlug: category.slug, sort })}
              label={category.name}
              active={categorySlug === category.slug}
            />
          ))}
        </nav>

        <nav
          aria-label="Sort"
          className="flex shrink-0 gap-0.5 rounded-full bg-gray-100 p-0.5"
        >
          <SortTab
            href={feedHref({ ...view, sort: "new" })}
            label="New"
            active={sort === "new"}
          />
          <SortTab
            href={feedHref({ ...view, sort: "top" })}
            label="Top"
            active={sort === "top"}
          />
        </nav>
      </div>

      {footer.kind === "loading" ? (
        <p className="py-12 text-center text-sm text-gray-500">
          Loading posts…
        </p>
      ) : footer.kind === "error" ? (
        <EmptyState heading="This feed didn't load">
          {footer.message}
          {/* The one deterministic way to get here is a category the server
              does not have, and the whole feed is the way out of it. */}
          {categorySlug ? (
            <>
              {" "}
              <Link href={feedHref({ sort })} className="underline">
                Show every category
              </Link>
            </>
          ) : null}
        </EmptyState>
      ) : footer.kind === "empty" ? (
        <EmptyState heading="No posts here yet">
          <Link href="/community/new" className="underline">
            Write the first one
          </Link>
        </EmptyState>
      ) : (
        <ul className="mt-2 divide-y divide-gray-200 border-t border-gray-200">
          {posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              canWrite={isMember}
              onChanged={() => utils.community.posts.list.invalidate()}
            />
          ))}
        </ul>
      )}

      <ListFooter
        state={footer}
        onLoadMore={() => feed.fetchNextPage()}
        endNote="That's every post."
      />
    </CommunityShell>
  );
};

// The feed's title. Outside `Feed` so every return in it is covered,
// including the first render while the queries are still loading.
const FeedPage = () => (
  <>
    <PageTitle page="Community" />
    <Feed />
  </>
);

export default FeedPage;
