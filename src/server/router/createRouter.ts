import { TRPCError, initTRPC } from "@trpc/server";
import { Context } from "./context";
import superjson from "superjson";
import { maskUnexpectedError } from "./errorMasking";

/**
 * One definition of "this is a developer's machine", used for both halves of
 * what an error discloses.
 *
 * tRPC's own default for `isDev` is `NODE_ENV !== "production"`, and `isDev`
 * decides whether `error.stack` is attached to the shape as `data.stack`. The
 * first line of a stack *is* the message, so masking `message` while leaving
 * `isDev` to default would send the Prisma invocation to the browser in any
 * environment that is not literally `production`.
 *
 * `build:development` sets `NODE_ENV=development` only for the `prisma
 * generate` step a `VAR=value` prefix scopes it to — not for `next build`,
 * which sets `NODE_ENV=production` itself regardless. See "There is no
 * development build" in `docs/deployment.md`. No deployed environment reaches
 * this with `NODE_ENV` unset or set to anything else, so this expression and
 * tRPC's own default agree everywhere it currently runs.
 *
 * It stays explicit regardless. Equality against one named value is a property
 * this file states and a test can pin, rather than a coincidence of two
 * independent definitions that happen to agree today - and the one that would
 * flip, `NODE_ENV !== "production"`, fails *open*, disclosing more.
 */
const isDevelopment = process.env.NODE_ENV === "development";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  isDev: isDevelopment,
  /**
   * Without this, tRPC's default formatter (`({ shape }) => shape`) sent
   * `error.message` to the browser verbatim, including the rendered Prisma
   * invocation behind an unexpected fault - undoing the redaction that
   * `src/pages/api/trpc/[trpc].ts` applies to the log for the same request.
   * Only the message of an `INTERNAL_SERVER_ERROR` changes; see
   * `errorMasking.ts` for why masking is keyed on the code.
   *
   * Note this runs on the HTTP path only. `appRouter.createCaller` throws the
   * original `TRPCError`, so the router tests still assert real messages.
   */
  errorFormatter: ({ shape, error, ctx }) =>
    maskUnexpectedError(
      shape,
      error.code,
      process.env.NODE_ENV,
      ctx?.requestId,
    ),
});

export const router = t.router;
export const procedure = t.procedure;
export const middleware = t.middleware;

const isProtected = middleware(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});
const isAdmin = middleware(({ ctx, next }) => {
  if (!ctx.session || !ctx.session.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (ctx.session.user.permission === "USER") {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

export const protectedRouter = procedure.use(isProtected);
export const adminRouter = procedure.use(isAdmin);
