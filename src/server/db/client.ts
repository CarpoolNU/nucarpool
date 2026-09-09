import { PrismaClient, Prisma } from "@prisma/client";
import { formatPrismaLog } from "./prismaLog";

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

/**
 * Prisma's logging, routed through the application instead of straight to the
 * process output.
 *
 * This was `log: ["info", "warn", "error"]` — plain level strings, which is
 * Prisma's stdout mode. The client formatted its own error and printed it,
 * including an absolute build path and a source excerpt of the app's own code,
 * with nothing able to intervene; meanwhile `[trpc].ts` was carefully redacting
 * the other route out of the same request. `emit: "event"` puts both under one
 * policy. See `prismaLog.ts` for what that route was measured to disclose —
 * notably *not* argument values, contrary to how SCRUM-399 was filed.
 *
 * **An event level with no listener is silently dropped**, so the handlers
 * below are attached here, next to the construction, rather than by whoever
 * imports this.
 */
const buildPrismaClient = () => {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "info" },
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });

  client.$on("info", (event) => console.info("prisma", formatPrismaLog(event)));
  client.$on("warn", (event) => console.warn("prisma", formatPrismaLog(event)));
  client.$on("error", (event) =>
    console.error("prisma", formatPrismaLog(event)),
  );

  return client;
};

// Reused across hot reloads in development, which also means the listeners
// above are attached exactly once rather than accumulating per reload.
export const prisma = global.prisma || buildPrismaClient();

if (process.env.NODE_ENV !== "production") global.prisma = prisma;
