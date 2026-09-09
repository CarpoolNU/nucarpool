import * as trpcNext from "@trpc/server/adapters/next";
import { appRouter } from "../../../server/router";
import { createContext } from "../../../server/router/context";
import { logServerError } from "../../../server/router/errorLog";

export default trpcNext.createNextApiHandler({
  router: appRouter,
  createContext: createContext,
  onError({ error, path, type, ctx }) {
    if (error.code === "INTERNAL_SERVER_ERROR") {
      // What gets disclosed, and the production/development split, live in
      // `errorLog.ts` — no test file may exist under `src/pages/`, because a
      // filename here is also a URL, so a rule kept in this file is a rule
      // nothing checks. This is the HTTP edge; that is the decision.
      //
      // Still `console`, deliberately. Routing it to a real error *reporter*
      // is the open half of SCRUM-400 (AC 5/6) and is a product and
      // data-handling decision, not a technical one. `formatServerError`'s
      // one-line JSON is the shape whichever reporter is chosen would consume.
      logServerError({ error, path, type, ctx });
    }
  },
  batching: {
    enabled: true,
  },
});
