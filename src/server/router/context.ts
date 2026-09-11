import * as trpc from "@trpc/server";
import * as trpcNext from "@trpc/server/adapters/next";
import { getServerSession } from "next-auth";

import { authOptions as nextAuthOptions } from "../../pages/api/auth/[...nextauth]";
import { prisma } from "../db/client";
import { sesClient } from "../ses";
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
  };
};

export type Context = trpc.inferAsyncReturnType<typeof createContext>;
