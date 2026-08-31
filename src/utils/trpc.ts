import { httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import type { AppRouter } from "../server/router";
import superjson from "superjson";
import { TRPCError } from "@trpc/server";
import { getBaseUrl } from "./getBaseUrl";

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

export const trpc = createTRPCNext<AppRouter>({
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
        }),
      ],
      transformer: superjson,
      queryClientConfig: {
        defaultOptions: {
          queries: {
            retry: (failureCount: number, error: any) => {
              const trcpErrorCode = error?.data?.code as TRPCError["code"];

              // Retrying a request the server has already judged invalid only
              // delays the error state the user is waiting on - three times over,
              // before the UI is allowed to say anything went wrong (SCRUM-241).
              // Anything not listed here (a 500, a timeout, a dropped
              // connection) is still worth another go.
              if (
                trcpErrorCode !== undefined &&
                NON_RETRYABLE_CODES.has(trcpErrorCode)
              ) {
                return false;
              }
              if (failureCount < 3) {
                return true;
              }
              return false;
            },
            refetchOnMount: false,
            refetchOnWindowFocus: false,
          },
        },
      },
    };
  },
  /**
   * Queries render on the client only, so `getBaseUrl` never takes its
   * server-side branch in practice. **Turning this on means the deployed
   * server-side origin starts being used for real** — check that `NEXTAUTH_URL`
   * is set in every deployed environment before you do, or requests fall back
   * to localhost (SCRUM-310).
   *
   * @link https://trpc.io/docs/ssr
   **/
  ssr: false,
});
