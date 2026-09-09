import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./index";
import type { Context } from "./context";
import { UNEXPECTED_ERROR_MESSAGE, maskUnexpectedError } from "./errorMasking";

/**
 * Masking unexpected server errors on the way to the browser (SCRUM-388).
 *
 * `[trpc].ts` keeps error contents out of production logs; the same payload was
 * going to the client untouched, because `initTRPC` had no `errorFormatter` and
 * tRPC's default passes `error.message` straight through. A `P2025` therefore
 * reached a toast as "Invalid `prisma.user.update()` invocation…".
 *
 * The property that has to survive is the *opposite* one: every deliberate
 * refusal in this codebase is shown to the user as written, and several fixes
 * (SCRUM-294, SCRUM-354, SCRUM-296) depended on that. So the tests below are as
 * much about what is *not* masked as what is.
 */

/** The shape tRPC builds, reduced to the fields that matter here. */
const shapeFor = (message: string) => ({
  message,
  code: -32603,
  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "user.me" },
});

const PRISMA_LEAK =
  "Invalid `prisma.user.update()` invocation: An operation failed because it " +
  "depends on one or more records that were required but not found.";

describe("maskUnexpectedError", () => {
  it("replaces the message on an INTERNAL_SERVER_ERROR", () => {
    const masked = maskUnexpectedError(
      shapeFor(PRISMA_LEAK),
      "INTERNAL_SERVER_ERROR",
      "production",
    );

    expect(masked.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(masked.message).not.toContain("prisma");
  });

  it("leaves the data block untouched when masking", () => {
    // The retry policy in src/utils/trpc.ts reads `error.data.code`, so the
    // mask must not reach it. This is the assertion that catches a formatter
    // rewritten to return a fresh object.
    const original = shapeFor(PRISMA_LEAK);
    const masked = maskUnexpectedError(
      original,
      "INTERNAL_SERVER_ERROR",
      "production",
    );

    expect(masked.data).toEqual(original.data);
    expect(masked.code).toBe(original.code);
  });

  it.each([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
  ] as const)("keeps the message of a deliberate %s", (code) => {
    // Every intentional refusal uses one of these, and the UI displays them
    // verbatim. Masking any of them would undo SCRUM-294/354/296.
    const refusal = shapeFor("You are already in a carpool group.");

    expect(maskUnexpectedError(refusal, code, "production")).toBe(refusal);
  });

  it("does not mask in development", () => {
    const shape = shapeFor(PRISMA_LEAK);

    expect(
      maskUnexpectedError(shape, "INTERNAL_SERVER_ERROR", "development"),
    ).toBe(shape);
  });

  it("masks when NODE_ENV is unset, rather than failing open", () => {
    // Absence of a value must not be read as "this is a dev machine".
    const masked = maskUnexpectedError(
      shapeFor(PRISMA_LEAK),
      "INTERNAL_SERVER_ERROR",
      undefined,
    );

    expect(masked.message).toBe(UNEXPECTED_ERROR_MESSAGE);
  });

  it("returns the very same object when not masking", () => {
    // Not just an equal one: the default formatter is identity, and staying
    // identity for every other code keeps this change provably narrow.
    const shape = shapeFor("Cannot send a carpool request to yourself.");

    expect(maskUnexpectedError(shape, "BAD_REQUEST", "production")).toBe(shape);
  });
});

/**
 * The wiring, over a real HTTP request.
 *
 * The unit tests above prove the function; they cannot prove `initTRPC` is
 * actually using it. **`appRouter.createCaller` cannot prove it either** —
 * verified against tRPC 11.18.0, `createCaller` rethrows the original
 * `TRPCError` and never runs `errorFormatter`, which is also why every existing
 * router test still asserts real messages and none of them had to change.
 *
 * So this goes through `fetchRequestHandler` and reads the response body, which
 * is the same path `src/pages/api/trpc/[trpc].ts` serves.
 */
describe("the error formatter is wired into appRouter", () => {
  const respond = async (context: Partial<Context>) => {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/user.me?input=%7B%7D"),
      router: appRouter,
      createContext: () => context as Context,
    });

    return { status: response.status, body: await response.json() };
  };

  const sessionFor = (id: string) => ({
    user: {
      id,
      isOnboarded: true,
      tutorialCompleted: true,
      permission: "USER",
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });

  it("masks an unexpected Prisma failure on the wire", async () => {
    const { status, body } = await respond({
      session: sessionFor("alice") as unknown as Context["session"],
      prisma: {
        user: { findUnique: () => Promise.reject(new Error(PRISMA_LEAK)) },
      } as unknown as Context["prisma"],
    });

    expect(status).toBe(500);
    expect(body.error.json.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    // The point of the ticket: nothing of the query's internals anywhere on
    // the wire, not just in `message`. This caught a second route the ticket
    // did not name - tRPC attaches `error.stack` as `data.stack` whenever
    // `isDev`, and a stack's first line is the message. `createRouter.ts` now
    // pins `isDev` to the same definition of development this mask uses.
    expect(JSON.stringify(body)).not.toContain("prisma.user.update");
    expect(body.error.json.data.stack).toBeUndefined();
    // And the code the retry policy reads is still the real one.
    expect(body.error.json.data.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("keeps the message and the stack in development", async () => {
    // The acceptance criterion that local debugging must not get harder.
    // `isDev` is read when `createRouter.ts` loads, so this composes the same
    // two settings in a throwaway router rather than trying to reload it.
    const dev = initTRPC.create({
      isDev: true,
      errorFormatter: ({ shape, error }) =>
        maskUnexpectedError(shape, error.code, "development"),
    });
    const router = dev.router({
      boom: dev.procedure.query(() => {
        throw new Error(PRISMA_LEAK);
      }),
    });

    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/boom"),
      router,
      createContext: () => ({}),
    });
    const body = await response.json();

    expect(body.error.message).toBe(PRISMA_LEAK);
    expect(body.error.data.stack).toContain("Error:");
  });

  it("still sends a deliberate refusal verbatim on the wire", async () => {
    // `user.me` throws UNAUTHORIZED with a message when the session carries no
    // user id. Masking that would be the regression this pairs against.
    const { body } = await respond({
      session: { user: {}, expires: "" } as unknown as Context["session"],
      prisma: {} as unknown as Context["prisma"],
    });

    expect(body.error.json.message).toBe("User not authenticated");
    expect(body.error.json.data.code).toBe("UNAUTHORIZED");
  });
});
