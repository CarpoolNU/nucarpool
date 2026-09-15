import { httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import type { AppRouter } from "../server/router";
import superjson from "superjson";
import { TRPCError } from "@trpc/server";
import { getBaseUrl } from "./getBaseUrl";
import type { DefaultOptions } from "@tanstack/react-query";

/**
 * Codes that describe the request rather than a transient failure, so a retry
 * would produce the same answer. Kept as a named set so the retry rule reads as
 * a policy rather than a special case for `NOT_FOUND`.
 */
const NON_RETRYABLE_CODES: ReadonlySet<TRPCError["code"]> = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNPROCESSABLE_CONTENT",
]);

/**
 * The query defaults every `useQuery` in the app starts from.
 *
 * **Both `refetch` flags are off deliberately, and both are a cost decision
 * rather than a correctness one.** The expensive queries here are
 * `recommendations.me`, which runs the scoring pass over every candidate
 * carpool, and `mapbox.geoJsonUserList`, which is metered against the Mapbox
 * quota. Refetching those on every mount or every tab focus is a bandwidth and
 * quota bill paid mostly by mobile, the platform least able to pay it.
 *
 * **The flags are wrong for real-time data, though, which is why the opt-outs
 * below exist.** A phone backgrounds the page dozens of times a session - a
 * notification, a glance at the clock, a lock screen - and iOS Safari tears the
 * WebSocket down without firing an `offline` event on the way. `pusher-js`
 * reconnects when the tab resumes, but the events that fired while it was down
 * are gone, and with nothing refetching, the client's view of the conversation
 * stays permanently short of the server's.
 *
 * So the policy is **opt in per query**, and three opt in:
 *
 * - `user.messages.conversation` - the open thread. Pusher only ever *appends*,
 *   so a gap never heals on its own.
 * - `user.messages.getUnreadMessageCount` - the badge, and the half that never
 *   self-heals; see below.
 * - `user.requests.me` - the per-card unread dot and the message previews.
 *
 * Everything else takes the defaults, including the two expensive queries
 * above, on purpose.
 *
 * `refetchOnReconnect` is deliberately left unset, so it keeps its default of
 * `true`. That covers a genuine network drop, which fires an `offline`/`online`
 * pair. A suspended tab fires neither, which is exactly why the focus flag has
 * to carry that case separately.
 *
 * **Flipping either flag globally instead was considered and rejected**: it
 * would fix messaging by making every active query refetch on every focus,
 * including the two that cost real money. A future query that needs freshening
 * gets the opt-out at its own call site, next to a reason, rather than here.
 *
 * The badge additionally reconciles on the Pusher transport's own `connected`
 * event, because it is the one query with no other recovery path - `Header`
 * never unmounts while the user stays on `/`, so a single missed notification
 * would otherwise stay wrong for the rest of the session. See
 * [`useUnreadNotifications`](./messages/useUnreadNotifications.ts).
 *
 * Exported so the policy can be asserted against a real `QueryClient` rather
 * than read off this file - see `trpc.focusPolicy.test.tsx`.
 */
export const defaultQueryOptions = {
  retry: (failureCount: number, error: any) => {
    const trcpErrorCode = error?.data?.code as TRPCError["code"];

    // Retrying a request the server has already judged invalid only
    // delays the error state the user is waiting on - three times over,
    // before the UI is allowed to say anything went wrong.
    // Anything not listed here (a 500, a timeout, a dropped
    // connection) is still worth another go.
    if (trcpErrorCode !== undefined && NON_RETRYABLE_CODES.has(trcpErrorCode)) {
      return false;
    }
    if (failureCount < 3) {
      return true;
    }
    return false;
  },
  refetchOnMount: false,
  refetchOnWindowFocus: false,
} satisfies DefaultOptions["queries"];

/**
 * The opt-out, spread by the three real-time queries listed above.
 *
 * A shared constant rather than a literal repeated three times, so the policy
 * and the call sites cannot drift apart and so a test can exercise the same
 * object the app passes to React Query. Spread it *after* a query's own
 * options if that query means to override anything in it.
 *
 * `true` rather than `"always"` on purpose: `true` still respects `staleTime`,
 * and none of the three sets one, so both behave identically today. If one ever
 * takes a `staleTime`, `true` is the flag that will keep honouring it.
 */
export const realTimeQueryOptions = {
  refetchOnWindowFocus: true,
} satisfies DefaultOptions["queries"];

export const trpc = createTRPCNext<AppRouter>({
  /**
   * tRPC v11 wants the transformer named twice, and both are required — the
   * compiler rejects either one alone.
   *
   * On the link, because serialization is now a per-link concern rather than a
   * client-wide one: v10 took a single `transformer` on the client config and
   * v11 replaced that with a `TypeError` type telling you to move it.
   *
   * Here at the root, because `createTRPCNext` also needs it outside `config()`
   * for the data it dehydrates. The two must agree; `superjson` is the same
   * transformer `initTRPC` is created with on the server, which is what makes
   * `Date` survive the wire in both directions.
   */
  transformer: superjson,
  config(opts) {
    return {
      links: [
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" ||
            (opts.direction === "down" && opts.result instanceof Error),
        }),
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      ],
      queryClientConfig: {
        defaultOptions: {
          queries: defaultQueryOptions,
        },
      },
    };
  },
  /**
   * Queries render on the client only, so `getBaseUrl` never takes its
   * server-side branch in practice. **Turning this on means the deployed
   * server-side origin starts being used for real** — check that `NEXTAUTH_URL`
   * is set in every deployed environment before you do, or requests fall back
   * to localhost.
   *
   * @link https://trpc.io/docs/ssr
   **/
  ssr: false,
});
