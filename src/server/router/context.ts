import * as trpc from "@trpc/server";
import * as trpcNext from "@trpc/server/adapters/next";
import { getServerSession } from "next-auth";

import { authOptions as nextAuthOptions } from "../../pages/api/auth/[...nextauth]";
import { prisma } from "../db/client";
import { sesClient } from "../ses";
import { communityServicesFor } from "../communityHost";
import { browserEnv } from "../../utils/env/browser";
import { newRequestId } from "./requestId";

export const createContext = async (
  opts?: trpcNext.CreateNextContextOptions,
) => {
  const req = opts?.req;
  const res = opts?.res;

  const session =
    req && res && (await getServerSession(req, res, nextAuthOptions));

  return {
    req,
    res,
    session,
    prisma,
    sesClient,
    /**
     * Random reference for this request, used only if it fails. Generated here
     * rather than in either error callback so that `onError` and
     * `errorFormatter` report the same value without depending on the order
     * tRPC invokes them.
     */
    requestId: newRequestId(),
    /**
     * Community's services, composed per request so the host adapter's block
     * and standing memos live exactly as long as one request. Refuses on every
     * touch while `NEXT_PUBLIC_COMMUNITY_ENABLED` is off.
     */
    community: communityServicesFor(
      prisma,
      browserEnv.NEXT_PUBLIC_COMMUNITY_ENABLED,
    ),
  };
};

export type Context = trpc.inferAsyncReturnType<typeof createContext>;
