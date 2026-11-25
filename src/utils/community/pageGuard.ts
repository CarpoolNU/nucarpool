import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../pages/api/auth/[...nextauth]";
import { browserEnv } from "../env/browser";

/**
 * The `getServerSideProps` every Community page exports (SCRUM-760).
 *
 * A page opts in with `export const getServerSideProps = communityPageGuard;`.
 * `pageGuardCoverage.test.ts` requires each module under `src/pages/community/`
 * and fails on any page whose export is not this exact function.
 *
 * **The flag comes first, before the session is read.** While
 * `NEXT_PUBLIC_COMMUNITY_ENABLED` is off, every Community URL is a 404 for
 * everyone. Checking the session first would send a signed-out visitor to
 * `/sign-in`, which shows that the route exists, while a signed-in one would
 * get the 404. Reading no session at all while the flag is off also means a
 * disabled Community costs no session lookup.
 *
 * After the flag, the order and the destinations are the ones
 * `pages/profile/index.tsx` uses: signed out goes to `/sign-in`, signed in but
 * not onboarded goes to `/profile/setup`. The procedures behind these pages
 * check participation again on every call, so this guard decides who reaches
 * the page and does not replace those checks.
 *
 * **What a page can assume because of it.** When a page renders on the
 * client, a signed-in, onboarded session existed for the request that
 * produced it. That is why the pages read no client session and do not wait
 * for one before they query. A session that expires while the page is open
 * shows up as a failed query, which each page already renders.
 */
export const communityPageGuard: GetServerSideProps<
  Record<string, never>
> = async (context) => {
  if (!browserEnv.NEXT_PUBLIC_COMMUNITY_ENABLED) {
    return { notFound: true };
  }

  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    return { redirect: { destination: "/sign-in", permanent: false } };
  }
  if (!session.user.isOnboarded) {
    return { redirect: { destination: "/profile/setup", permanent: false } };
  }

  return { props: {} };
};
