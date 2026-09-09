import * as trpcNext from "@trpc/server/adapters/next";
import { appRouter } from "../../../server/router";
import { createContext } from "../../../server/router/context";

export default trpcNext.createNextApiHandler({
  router: appRouter,
  createContext: createContext,
  onError({ error, path, type, ctx }) {
    if (error.code === "INTERNAL_SERVER_ERROR") {
      // An error payload can quote the values that caused it - a failing Prisma
      // query includes its parameters, which here means addresses and emails -
      // so production logs get the shape of the fault rather than its contents.
      // This is still `console`; routing it to a real error reporter is an
      // open follow-up (SCRUM-400).
      //
      // `requestId` is the reference the client was given in place of the
      // message, and logging it here is the only thing that makes the masking
      // in `errorMasking.ts` diagnosable: a user can quote it and it can be
      // found in this stream. It comes off the context rather than being
      // generated here, so `errorFormatter` reports the identical value
      // without either callback depending on running first.
      //
      // `ctx` is undefined when `createContext` itself threw, which is also
      // the case where the client got no reference. Saying "none" is the
      // honest record - the alternative is a log line with an id that appears
      // nowhere else.
      const requestId = ctx?.requestId ?? "none";

      if (process.env.NODE_ENV === "production") {
        console.error("Something went wrong", {
          requestId,
          path,
          type,
          code: error.code,
          cause: error.cause?.name,
        });
      } else {
        console.error("Something went wrong", { requestId, path, type }, error);
      }
    }
  },
  batching: {
    enabled: true,
  },
});
