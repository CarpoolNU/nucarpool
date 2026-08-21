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

That middleware answers **authentication** — is there a session, and does it belong to staff. It does not answer **authorization** — may _this_ caller act on _this_ record. Every NUCarpool user is signed in, so "requires a session" is not by itself a meaningful control on a mutation that names a user, group, or request id.

Procedures that touch a specific record therefore carry their own ownership check in the handler, on top of the middleware. `favorites.edit` derives the owning user from `ctx.session` rather than accepting it; `admin.updateUserPermission` is the one procedure that narrows the middleware further, requiring `MANAGER`.

## Writing a procedure

Inputs are validated with [Zod](https://zod.dev/). Current shape:

```typescript
export const favoritesRouter = router({
  edit: protectedRouter
    .input(
      z
        .object({
          favoriteId: z.string(),
          add: z.boolean(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;

      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated.",
        });
      }

      await ctx.prisma.user.update({
        where: {
          id: userId,
        },
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

### Deriving identity — read the acting user from the session

Note what the input above does **not** contain: the id of the user being edited. That is deliberate.

- **Never take the acting user's id from the client.** `where: { id: input.userId }` lets the caller choose whose row is written; `where: { id: ctx.session.user.id }` does not.
- **`.strict()` makes the removal stick.** Without it, a client that still sends `userId` is silently ignored rather than rejected, and the field can quietly creep back into the resolver later.
- **Ids the client does supply still need checking.** `favoriteId` is safe because it names who is favorited, not whose list is written. When an input names a record the caller may not own — a group, request, or conversation — load it first, confirm the session user is a party to it, and `throw new TRPCError({ code: "FORBIDDEN" })` otherwise.

This is not hypothetical. `favorites.edit` shipped without the first of these and let any signed-in user rewrite anyone else's favorites ([SCRUM-223](https://carpoolnu.atlassian.net/browse/SCRUM-223)); a full-repository audit then found the same class of gap in the requests, messages, groups, and email routers.

Where a router's rules are more than "the caller owns the row", they are written down next to the code rather than here, so they cannot drift from it. The carpool group rules — who may delete a group, evict a rider, or edit the group message — are tabulated at the top of [`user/groups.ts`](./user/groups.ts).

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
