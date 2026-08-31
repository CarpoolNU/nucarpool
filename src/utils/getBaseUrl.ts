/**
 * The origin tRPC requests are sent to.
 *
 * In the browser this is `""`, so the request stays relative to the current
 * origin. That is the only branch the app exercises today.
 *
 * The server-side branches are currently **unreachable**. `ssr: false` in
 * [`trpc.ts`](./trpc.ts) means no query is rendered on the server, and no
 * `getServerSideProps` reaches a procedure — the five pages that define one use
 * `trpc.*.useQuery` hooks, which run on the client, and the only
 * `appRouter.createCaller` callers in the repository are tests. They are kept
 * correct anyway, because the cost of being wrong here is paid by whoever
 * enables SSR later rather than by the change that broke it.
 *
 * `VERCEL_URL` used to be consulted here (SCRUM-310). The app deploys on AWS
 * Amplify, where that variable is never set, so the branch was dead **and** the
 * fallback meant a deployed server-side call would have silently targeted
 * `http://localhost:3000` — a failure that would read as a network problem
 * rather than a configuration bug.
 *
 * `NEXTAUTH_URL` replaces it. Amplify writes it into the build environment (see
 * [`amplify.yml`](../../amplify.yml)) and it is the app's own canonical origin,
 * so unlike an Amplify-generated hostname it is already correct behind a custom
 * domain. It is read by NextAuth directly rather than through `envsafe`, so it
 * is not validated at import time and this cannot assume it is present — hence
 * the localhost fallback, which is also the right answer for `yarn dev`.
 *
 * **If you enable `ssr: true`, or add a server-side caller, verify
 * `NEXTAUTH_URL` is set in every deployed environment first.** Without it this
 * still falls back to localhost.
 */
export const getBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    return "";
  }

  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) {
    // A trailing slash would produce `https://host//api/trpc`.
    return configured.replace(/\/+$/, "");
  }

  return `http://localhost:${process.env.PORT ?? 3000}`;
};
