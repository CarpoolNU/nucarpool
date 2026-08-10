# tRPC Routers

This directory is the server-side API. Every endpoint the app exposes is a tRPC procedure defined here — there is no REST layer.

## Files

| File                                   | Purpose                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`createRouter.ts`](./createRouter.ts) | Initializes tRPC and exports the router/procedure builders and auth middleware                        |
| [`context.ts`](./context.ts)           | Builds the per-request context                                                                        |
| [`index.ts`](./index.ts)               | Merges subrouters into `appRouter` and exports its type                                               |
| [`user.ts`](./user.ts)                 | Core user procedures; mounts everything in [`user/`](./user)                                          |
| [`mapbox.ts`](./mapbox.ts)             | Address search, map user list, and directions                                                         |
| [`user/`](./user)                      | Feature subrouters: `admin`, `email`, `favorites`, `groups`, `message`, `recommendations`, `requests` |

`appRouter` is served over HTTP by [`[trpc].ts`](../../pages/api/trpc/%5Btrpc%5D.ts).

## Context

[`context.ts`](./context.ts) runs once per request and puts these on `ctx`:

- `ctx.session` — the NextAuth session
- `ctx.prisma` — the shared Prisma client (see the [db README](../db/README.md))
- `ctx.sesClient` — AWS SES client, used by the email subrouter
- `ctx.req` / `ctx.res`

## Procedures and protection

[`createRouter.ts`](./createRouter.ts) exports three procedure builders:

- **`procedure`** — public, no session required. Currently unused; every endpoint is protected.
- **`protectedRouter`** — throws `UNAUTHORIZED` without a session. Use this by default.
- **`adminRouter`** — additionally requires `session.user.permission !== "USER"`.

Protection is middleware, so a procedure needs no auth code of its own. A few admin procedures narrow further inside the handler — `updateUserPermission` also requires `MANAGER`.

## Writing a procedure

Inputs are validated with [Zod](https://zod.dev/). Current shape:

```typescript
export const favoritesRouter = router({
  edit: protectedRouter
    .input(
      z.object({
        userId: z.string(),
        favoriteId: z.string(),
        add: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.user.update({
        where: { id: input.userId },
        data: {
          favorites: {
            [input.add ? "connect" : "disconnect"]: { id: input.favoriteId },
          },
        },
      });
    }),
});
```

Use `.query()` for reads and `.mutation()` for writes, and throw `TRPCError` for failures.

## Composition and frontend access

Subrouters nest by key, so the router path _is_ the call path:

```typescript
// index.ts → router({ user: userRouter, mapbox: mapboxRouter })
// user.ts  → router({ me: ..., favorites: favoritesRouter, ... })

const { data: user } = trpc.user.me.useQuery();
const { data: favorites } = trpc.user.favorites.me.useQuery();
const createGroup = trpc.user.groups.create.useMutation();
```

[`index.ts`](./index.ts) exports the `AppRouter` type, which [`src/utils/trpc.ts`](../../utils/trpc.ts) uses to generate fully typed hooks. Rename a procedure here and the frontend stops compiling — that is the point. `superjson` is configured as the transformer, so `Date` values survive the round trip intact.
