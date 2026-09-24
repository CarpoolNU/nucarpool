import { Prisma, ReportReason, ReportStatus } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";

/**
 * The `block` and `report` tables (SCRUM-553), against a real MySQL.
 *
 * All three properties below live in the schema and nowhere else, and the
 * mocked suite cannot see any of them. The unique pair is a real MySQL index,
 * so only a real database rejects the duplicate. The referential actions are
 * emulated by Prisma's query engine under `relationMode = "prisma"`, so they
 * are behaviour to assert, not something to read off `schema.prisma`.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test, never in `beforeAll`: `jest.integration.setupAfterEnv.js`
 * truncates every table before each one.
 */

const prisma = integrationPrisma();

const seedPair = async () => {
  const alice = await prisma.user.create({
    data: { name: "Alice", email: "alice@northeastern.edu" },
  });
  const bob = await prisma.user.create({
    data: { name: "Bob", email: "bob@northeastern.edu" },
  });
  return { alice, bob };
};

/** The Prisma error code a rejected promise carries, or null. */
const prismaErrorCode = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code;
    }
    throw error;
  }
  return null;
};

describe("block", () => {
  it("rejects a second row for the same blocker and blocked user", async () => {
    // The unique pair is what makes blocking idempotent. Without it, blocking
    // twice would leave two rows, and unblocking once would leave the pair
    // still blocked.
    const { alice, bob } = await seedPair();
    await prisma.block.create({
      data: { blockerId: alice.id, blockedId: bob.id },
    });

    expect(
      await prismaErrorCode(
        prisma.block.create({
          data: { blockerId: alice.id, blockedId: bob.id },
        }),
      ),
    ).toBe("P2002");
  });

  it("allows the reverse direction, because each row is one user's choice", async () => {
    // Both users may block each other. That is two rows, and each belongs to
    // the user who made it: one unblocking must not undo the other's block.
    const { alice, bob } = await seedPair();
    await prisma.block.create({
      data: { blockerId: alice.id, blockedId: bob.id },
    });
    await prisma.block.create({
      data: { blockerId: bob.id, blockedId: alice.id },
    });

    expect(await prisma.block.count()).toBe(2);
  });

  it.each([
    ["blocker", "alice"],
    ["blocked user", "bob"],
  ] as const)(
    "is deleted with its %s, because Prisma emulates the cascade",
    async (_role, whom) => {
      const users = await seedPair();
      await prisma.block.create({
        data: { blockerId: users.alice.id, blockedId: users.bob.id },
      });

      await prisma.user.delete({ where: { id: users[whom].id } });

      expect(await prisma.block.count()).toBe(0);
    },
  );
});

describe("report", () => {
  const fileReport = (reporterId: string, reportedUserId: string) =>
    prisma.report.create({
      data: {
        reporterId,
        reportedUserId,
        reason: ReportReason.HARASSMENT,
        // A request id that names no row: the column is a plain id, not a
        // relation, precisely so a report survives its request being deleted.
        requestId: "clx0000000000000000000000",
        conversationSnapshot: JSON.stringify([]),
      },
    });

  it("is created OPEN, and accepts a requestId that points at nothing", async () => {
    const { alice, bob } = await seedPair();

    const report = await fileReport(alice.id, bob.id);

    expect(report.status).toBe(ReportStatus.OPEN);
    expect(await prisma.request.count()).toBe(0);
  });

  it.each([
    ["reporter", "alice"],
    ["reported user", "bob"],
  ] as const)(
    "prevents deleting its %s, so the report outlives neither party",
    async (_role, whom) => {
      // No `onDelete` on either relation means emulated `Restrict`. A report
      // is evidence, so the delete fails rather than taking the report with
      // it.
      const users = await seedPair();
      await fileReport(users.alice.id, users.bob.id);

      expect(
        await prismaErrorCode(
          prisma.user.delete({ where: { id: users[whom].id } }),
        ),
      ).toBe("P2014");
      expect(
        await prisma.user.findUnique({ where: { id: users[whom].id } }),
      ).not.toBeNull();
      expect(await prisma.report.count()).toBe(1);
    },
  );
});
