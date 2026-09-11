import type { NextApiRequest, NextApiResponse } from "next";

import { readBuildInfo, type BuildInfo } from "../../server/buildInfo";

/**
 * Which commit this deployment was built from (SCRUM-405).
 *
 * ```
 * curl -s https://<host>/api/version
 * {"commit":"a1b2c3d…","branch":"main","jobId":"42","environment":"production"}
 * ```
 *
 * Answers "is change X live yet?" without console access, which is the whole
 * point - two tickets blocked on an irreversible database change could not
 * discharge that precondition by any means available. `src/server/buildInfo.ts`
 * carries the reasoning and the field list; this file is the HTTP edge.
 *
 * Like `api/csp-report.ts` and `api/pusher/auth.ts` this is a plain route
 * rather than a tRPC procedure, and for a comparable reason: the caller is
 * `curl`, a uptime check or a human in a terminal, none of which speak tRPC's
 * batching protocol. A procedure would also be reachable only with a session,
 * which defeats the purpose.
 *
 * **Deliberately unauthenticated, and safe because of what it returns rather
 * than who asks.** The four fields are a commit SHA, a branch name, a build
 * number and a deployment name. The repository is public, so the SHA and branch
 * are already readable on GitHub, and `NEXT_PUBLIC_ENV` is compiled into the
 * client bundle by definition. Nothing here is a secret, and nothing here is
 * derived from a secret. That is a property of the response shape, so it is
 * pinned by a test that asserts the exact key set - see
 * `src/server/versionEndpoint.test.ts`.
 *
 * What this must never become: a config dump. If a future change wants to
 * expose anything beyond build identity, that is a different endpoint with a
 * different access rule, not another field here.
 */
export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<BuildInfo | { message: string }>,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed" });
  }

  /*
   * `no-store`, and this is load-bearing rather than boilerplate.
   *
   * Amplify serves through CloudFront, and the one question this endpoint
   * exists to answer is what is running *right now*. A cached response would
   * keep reporting the previous build across exactly the deploy boundary
   * someone is trying to observe - turning the fix into a subtler version of
   * the bug it closes, and one that looks like a correct answer.
   */
  res.setHeader("Cache-Control", "no-store, max-age=0");

  return res.status(200).json(readBuildInfo());
}
