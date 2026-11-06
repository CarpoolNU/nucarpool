/**
 * The `test` object every end-to-end file imports, in place of Playwright's.
 *
 * Two things are added, and both exist so that a test never opens a database
 * connection itself:
 *
 *   - `prisma`, worker-scoped, so one connection pool serves every test a
 *     worker runs rather than one per test;
 *   - `signInAs`, which seeds a user and leaves the browser context
 *     authenticated as them.
 *
 * `expect` is re-exported from here as well, so a test file has one import and
 * cannot accidentally take Playwright's bare `test` — which would have no
 * database and would fail in a way that reads like a Prisma problem.
 */

import { test as base, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { e2eDatabaseTarget } from "./environment";
import {
  attachSessionCookie,
  seedSessionUser,
  type SeedSessionOptions,
  type SeededUser,
} from "./session";

type E2EWorkerFixtures = {
  prisma: PrismaClient;
};

type E2ETestFixtures = {
  signInAs: (options?: SeedSessionOptions) => Promise<SeededUser>;
};

export const test = base.extend<E2ETestFixtures, E2EWorkerFixtures>({
  prisma: [
    async ({}, use) => {
      // Bound explicitly to the approved target rather than resolved from the
      // ambient `DATABASE_URL`, for the same reason `integrationPrisma()` is:
      // a client taking its URL from the datasource block would write into
      // whatever the developer's `.env` points at. `e2eDatabaseTarget()` has
      // already been through the guard.
      const client = new PrismaClient({
        datasources: { db: { url: e2eDatabaseTarget().url } },
        log: ["warn", "error"],
      });

      await use(client);

      await client.$disconnect();
    },
    { scope: "worker" },
  ],

  signInAs: async ({ prisma, context }, use) => {
    await use(async (options: SeedSessionOptions = {}) => {
      const seeded = await seedSessionUser(prisma, options);
      await attachSessionCookie(context, seeded.sessionToken);
      return seeded;
    });
  },
});

export { expect };
