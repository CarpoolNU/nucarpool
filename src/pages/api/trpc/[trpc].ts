import * as trpcNext from "@trpc/server/adapters/next";
import { appRouter } from "../../../server/router";
import { createContext } from "../../../server/router/context";

export default trpcNext.createNextApiHandler({
  router: appRouter,
  createContext: createContext,
  onError({ error, path, type }) {
    if (error.code === "INTERNAL_SERVER_ERROR") {
      // An error payload can quote the values that caused it - a failing Prisma
      // query includes its parameters, which here means addresses and emails -
      // so production logs get the shape of the fault rather than its contents.
      // This is still `console`; routing it to a real error reporter is
      // SCRUM-251's open follow-up.
      if (process.env.NODE_ENV === "production") {
        console.error("Something went wrong", {
          path,
          type,
          code: error.code,
          cause: error.cause?.name,
        });
      } else {
        console.error("Something went wrong", { path, type }, error);
      }
    }
  },
  batching: {
    enabled: true,
  },
});
