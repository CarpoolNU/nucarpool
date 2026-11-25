/**
 * Search results.
 *
 * **The same query as the feed, narrowed by a term** (SCRUM-683).
 * `posts.list` takes the term as a parameter rather than there being a
 * `posts.search` beside it, so a result can never be something the feed would
 * have hidden — see `PostService.list` for why that is the arrangement.
 *
 * **The term, the category and the sort are all in the URL**, as they are on
 * the feed, so a search is a link someone can send. `feedView.ts` owns the
 * translation in both directions and decides which of the two routes a view
 * belongs to, which is what lets the chips and tabs below be the same
 * components the feed uses with the same `feedHref` call.
 *
 * **No relevance ranking, because `LIKE` has no relevance to report.** The
 * orders on offer are the two the feed already has: newest first, which is the
 * default, and Top — which is the one worth having here, since the reason to
 * search is usually to find the answer everybody upvoted rather than the most
 * recent mention.
 *
 * **Guarded on the server**, like the feed. `communityPageGuard` decides who
 * reaches this page, so the only thing the results query waits for is a
 * term.
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

const Search = () => {
  const router = useRouter();

  const view = readFeedView(router.query);
  const { term, categorySlug, sort } = view;

  const me = trpc.community.profiles.me.useQuery();
  const categories = trpc.community.posts.categories.useQuery();

  // The term is part of the query key alongside the category and the sort, so
  // editing it starts a fresh paged query rather than appending to the pages
  // read under the previous one — which would also replay a cursor minted for
  // a different result set.
  const results = trpc.community.posts.list.useInfiniteQuery(
    {
      search: term ?? "",
      ...(categorySlug ? { categorySlug } : {}),
      sort,
    },
    {
      // No term is not an empty result, it is no question — so nothing is
      // asked of the server until there is one.
      enabled: term !== undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const utils = trpc.useUtils();

  if (term === undefined) {
    return (
      <CommunityShell>
        <EmptyState heading="Search the community">
          Type a word or two in the box above. Searching looks at post titles
          and their text.
        </EmptyState>
      </CommunityShell>
    );
  }

  const isMember = me.data !== null && me.data !== undefined;
  const pages = results.data?.pages ?? [];
  const posts = pages.flatMap((page) => page.posts);
  const footer = listFooterState({
    isLoading: results.isLoading,
    isFetchingNextPage: results.isFetchingNextPage,
    hasNextPage: results.hasNextPage,
    itemCount: posts.length,
    pagesLoaded: pages.length,
    // A refused search is not a search that found nothing. A term past
    // `SEARCH_TERM_MAX_LENGTH` arrives as a BAD_REQUEST — the box stops one
    // being typed, nothing stops one being pasted into the URL — and
    // "Nothing matches" over it sends the reader looking for a shorter word
    // when the server never ran the search (SCRUM-692).
    error: readableError(results.error?.message),
  });

  return (
    <CommunityShell>
      <h1 className="font-montserrat text-lg font-bold">
        Results for “{term}”
      </h1>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {/* Every chip and tab carries the term, because `feedHref` keeps the
            whole view and changes one field of it. Narrowing a search is the
            visible path; the box itself always starts a board-wide one. */}
        <nav aria-label="Categories" className="flex flex-wrap gap-1">
          <CategoryChip
            href={feedHref({ term, sort })}
            label="All"
            active={!categorySlug}
          />
          {(categories.data ?? []).map((category) => (
            <CategoryChip
              key={category.slug}
              href={feedHref({ term, categorySlug: category.slug, sort })}
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
        <p className="py-12 text-center text-sm text-gray-500">Searching…</p>
      ) : footer.kind === "error" ? (
        // No suggestion to try a shorter word or another category: those are
        // answers to a search that ran. The box in the chrome above is where
        // a different search starts, failed or not.
        <EmptyState heading="This search didn't run">
          {footer.message}
        </EmptyState>
      ) : footer.kind === "empty" ? (
        <EmptyState heading={`Nothing matches “${term}”`}>
          {categorySlug ? (
            <>
              Try{" "}
              <Link href={feedHref({ term, sort })} className="underline">
                every category
              </Link>
              , or a shorter word.
            </>
          ) : (
            <>
              Try a shorter word, or{" "}
              <Link href="/community/new" className="underline">
                ask the question
              </Link>
              .
            </>
          )}
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
        onLoadMore={() => results.fetchNextPage()}
        endNote={`That's every post matching “${term}”.`}
      />
    </CommunityShell>
  );
};

// Outside `Search` so the no-term state and the results share one title.
const SearchPage = () => (
  <>
    <PageTitle page="Community Search" />
    <Search />
  </>
);

export default SearchPage;
