import { PrismaClient, Prisma } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * The Prisma surface available inside `prisma.$transaction(async (tx) => ...)`.
 *
 * A transaction client is a `PrismaClient` minus the methods that cannot be
 * nested — `$transaction`, `$connect`, `$disconnect`, `$on`, `$use`. It is
 * therefore *not* assignable to `PrismaClient`, so any helper that has to run
 * both inside and outside a transaction must accept this type rather than the
 * full client.
 */
export type TransactionClient = Prisma.TransactionClient;

/** A helper that works against either the base client or a transaction. */
export type PrismaOrTransaction = PrismaClient | TransactionClient;

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: ["info", "warn", "error"],
  });

if (process.env.NODE_ENV !== "production") global.prisma = prisma;
