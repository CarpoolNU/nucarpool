import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import { Prisma } from "@prisma/client";

/** The application's Prisma client, typed without importing it at runtime. */
type AppPrismaClient = (typeof import("./db/client"))["prisma"];

/**
 * The NextAuth adapter, kept out of `src/pages/api/auth/` deliberately.
 *
 * Under `src/pages/` a filename is also a route, so a co-located test would be
 * compiled and served as one — the same reason `authSignIn.ts` and
 * `pusherChannelAuth.ts` sit here rather than beside their endpoints, and
 * `scripts/check-page-routes.js` enforces it. This adapter had two behaviours
 * worth pinning and no test could reach either while it was an inline object
 * literal in the route.
 */

/**
 * Why `deleteUser` refuses, in the message the caller sees.
 *
 * Exported so a test asserts the refusal rather than a string literal.
 */
export const ACCOUNT_DELETION_UNSUPPORTED =
  "Account deletion is not supported. NUCarpool has no delete-my-account " +
  "feature by decision (SCRUM-311); see the Account deletion section of " +
  "src/server/db/README.md before adding one.";

/**
 * NextAuth's Prisma adapter, with two deliberate departures.
 *
 * **`createUser` discards the provider's `image`.** Profile pictures are
 * resolved from S3 by `profileImageLookup.ts`, not from the identity provider,
 * so storing the provider's URL would give a user a picture they never chose
 * and cannot change here.
 *
 * **`deleteUser` refuses.** `PrismaAdapter` supplies one, and inheriting it
 * meant the route carried a working-looking account-deletion primitive that
 * could not actually work: `Request.fromUser`, `Request.toUser` and
 * `Message.User` declare no `onDelete`, so under `relationMode = "prisma"`
 * they default to emulated `Restrict` and the delete fails for any user who
 * has ever sent a request or a message — which is every real user.
 *
 * SCRUM-311 asked whether account deletion is a product requirement and the
 * answer recorded there is **no**. So the schema is not being changed to allow
 * it, and this refusal is what keeps the code honest about that: an explicit
 * message naming the decision, rather than an opaque referential-action error
 * from Prisma at some later date. Reversing the decision means reading the
 * README section first — the hard part is what happens to messages a
 * counterpart also participated in, not the cascade.
 *
 * Nothing calls this today. NextAuth core does not delete users on any
 * ordinary flow; it exists for callers that opt in.
 */
export const createAuthAdapter = (p: AppPrismaClient): Adapter => {
  return {
    ...PrismaAdapter(p),
    createUser: async (data: Prisma.UserCreateInput) => {
      const user = await p.user.create({
        data: {
          ...data,
          image: null,
        },
      });
      return {
        ...user,
        email: user.email || "",
      };
    },
    deleteUser: async () => {
      throw new Error(ACCOUNT_DELETION_UNSUPPORTED);
    },
  };
};
