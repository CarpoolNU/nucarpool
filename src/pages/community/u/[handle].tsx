/**
 * One handle's profile.
 *
 * **The only place in this product where one person's output is gathered.**
 * Search deliberately accepts no author filter (SCRUM-683), so this page is
 * the single, intentional surface for "what else has this person written" —
 * which is what makes it something that can be reasoned about rather than an
 * emergent property of a dozen endpoints.
 *
 * **Member-only, unlike every other read.** Browsing a feed is what you do
 * before deciding to take part; reading one person's whole history is not. The
 * viewer having claimed a handle makes them exactly as identifiable here as
 * the person they are reading, and that symmetry is the justification for the
 * page existing. A student meets the handle gate rather than an error.
 *
 * **Every refusal renders identically** — a handle nobody claimed, a handle
 * nobody could claim, and a handle belonging to someone the reader has a block
 * with all arrive as NOT_FOUND. Distinguishing them here would undo the §7.2
 * reasoning the server implements: a page that said "this person has blocked
 * you" is the disclosure the whole scheme exists to prevent.
 *
 * **Posts only.** There is no comment history and no endpoint that would serve
 * one; see `PostService.listByHandle` for why that omission is a decision.
 *
 * **Guarded on the server**, like the feed. `communityPageGuard` makes the
 * reader a signed-in, onboarded NUCarpool user. Membership, meaning a claimed
 * handle, is Community's own rule, so it is still decided here.
 */
import Link from "next/link";
import { useRouter } from "next/router";
import { trpc } from "../../../utils/trpc";
import {
  CommunityShell,
  EmptyState,
  ListFooter,
} from "../../../components/community/shell";
import { listFooterState } from "../../../components/community/listFooterState";
import { readableError } from "../../../components/community/readableError";
import { HandleGate } from "../../../components/community/handleGate";
import { PostRow } from "../../../components/community/postRow";
import {
  memberSinceLabel,
  readHandleParam,
} from "../../../components/community/profileView";
import PageTitle from "../../../components/PageTitle";
import { communityPageGuard } from "../../../utils/community/pageGuard";

export const getServerSideProps = communityPageGuard;

const Profile = () => {
  const router = useRouter();
  const utils = trpc.useUtils();

  const handle = readHandleParam(router.query);

  const me = trpc.community.profiles.me.useQuery();
  const isMember = me.data !== null && me.data !== undefined;
  // Both queries are gated on membership as well as on the handle: a student
  // would get FORBIDDEN from either, and the gate below is what they should
  // see instead of an error.
  const enabled = isMember && handle !== undefined;

  const profile = trpc.community.profiles.byHandle.useQuery(
    { handle: handle ?? "" },
    // **`retry: false`.** The error this page expects is NOT_FOUND, the one
    // refusal rendered below, and a second attempt gets the same answer.
    { enabled, retry: false },
  );
  const posts = trpc.community.profiles.posts.useInfiniteQuery(
    { handle: handle ?? "" },
    {
      enabled,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  if (handle === undefined) {
    return <CommunityShell />;
  }

  if (me.isLoading) {
    return (
      <CommunityShell>
        <p className="py-12 text-center text-sm text-gray-500">Loading…</p>
      </CommunityShell>
    );
  }

  if (!isMember) {
    return (
      <CommunityShell>
        <h1 className="font-montserrat text-lg font-bold">Profiles</h1>
        <p className="mt-1 max-w-prose text-sm text-gray-500">
          Reading someone&rsquo;s posting history is a step past reading the
          board. Claiming a handle makes you as visible here as the person you
          are reading, which is the only reason this page exists.
        </p>
        <div className="mt-6">
          <HandleGate
            reason="see profiles"
            onClaimed={() =>
              Promise.all([
                utils.community.profiles.byHandle.invalidate({ handle }),
                utils.community.profiles.posts.invalidate({ handle }),
              ])
            }
          />
        </div>
      </CommunityShell>
    );
  }

  // **One refusal for every reason there might be one.** The profile query is
  // what decides, because it is the one that resolves the handle; the post
  // list refuses on exactly the same grounds and would say exactly the same
  // thing.
  if (profile.error) {
    return (
      <CommunityShell>
        <EmptyState heading="This profile isn't available">
          No one is posting under that handle.{" "}
          <Link href="/community" className="underline">
            Back to the community
          </Link>
        </EmptyState>
      </CommunityShell>
    );
  }

  if (!profile.data) {
    return (
      <CommunityShell>
        <p className="py-12 text-center text-sm text-gray-500">Loading…</p>
      </CommunityShell>
    );
  }

  const pages = posts.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.posts);
  const footer = listFooterState({
    isLoading: posts.isLoading,
    isFetchingNextPage: posts.isFetchingNextPage,
    hasNextPage: posts.hasNextPage,
    itemCount: rows.length,
    pagesLoaded: pages.length,
    // The profile query is what decides the page-level refusal above, but it
    // is not this list's query: a page of posts can fail on its own, and
    // "No posts yet" under a handle whose posts did not load says something
    // about a person rather than about a request (SCRUM-692).
    error: readableError(posts.error?.message),
  });

  const isSelf = me.data?.handle === profile.data.handle;

  return (
    <CommunityShell>
      <Link href="/community" className="text-sm text-gray-500 hover:underline">
        Back to the community
      </Link>

      <header className="mt-4 border-b border-gray-200 pb-5">
        <h1 className="font-montserrat text-xl leading-tight font-bold">
          {profile.data.handle}
        </h1>
        {/* The join month and nothing else. There is no real name to show, no
            carpool role, and no count of votes received — see `public.ts`. */}
        <p className="mt-1 text-sm text-gray-500">
          {isSelf ? "Your handle · member since " : "Member since "}
          {memberSinceLabel(profile.data.memberSince)}
        </p>
      </header>

      {footer.kind === "loading" ? (
        <p className="py-12 text-center text-sm text-gray-500">
          Loading posts…
        </p>
      ) : footer.kind === "error" ? (
        <EmptyState heading="These posts didn't load">
          {footer.message}
        </EmptyState>
      ) : footer.kind === "empty" ? (
        <EmptyState heading="No posts yet">
          {isSelf ? (
            <>
              <Link href="/community/new" className="underline">
                Write your first one
              </Link>
            </>
          ) : (
            <>
              {profile.data.handle} hasn&rsquo;t written a post yet. Replies
              aren&rsquo;t listed here.
            </>
          )}
        </EmptyState>
      ) : (
        <ul className="mt-2 divide-y divide-gray-200">
          {rows.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              canWrite
              // Voting or saving from here changes the row in place, so the
              // list this page is showing is the one to refetch.
              onChanged={() =>
                utils.community.profiles.posts.invalidate({ handle })
              }
            />
          ))}
        </ul>
      )}

      <ListFooter
        state={footer}
        onLoadMore={() => posts.fetchNextPage()}
        endNote={
          isSelf
            ? "That's every post you've written."
            : `That's every post ${profile.data.handle} has written.`
        }
      />
    </CommunityShell>
  );
};

// Outside `Profile` so each of its returns has the title. It is static on
// purpose: `pageTitle.test.ts` refuses a dynamic one, so the handle is not in it.
const ProfilePage = () => (
  <>
    <PageTitle page="Community Profile" />
    <Profile />
  </>
);

export default ProfilePage;
