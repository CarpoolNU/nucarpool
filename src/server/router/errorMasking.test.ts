import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./index";
import { createContext } from "./context";
import type { Context } from "./context";
import { UNEXPECTED_ERROR_MESSAGE, maskUnexpectedError } from "./errorMasking";
import { newRequestId } from "./requestId";

/**
 * Masking unexpected server errors on the way to the browser.
 *
 * `[trpc].ts` keeps error contents out of production logs; the same payload was
 * going to the client untouched, because `initTRPC` had no `errorFormatter` and
 * tRPC's default passes `error.message` straight through. A `P2025` therefore
 * reached a toast as "Invalid `prisma.user.update()` invocation…".
 *
 * The property that has to survive is the *opposite* one: every deliberate
 * refusal in this codebase is shown to the user as written, and several fixes
 * depended on that. So the tests below are as
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
    // verbatim. Masking any of them would undo deliberate product decisions.
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

  it("appends the reference when the request has one", () => {
    const masked = maskUnexpectedError(
      shapeFor(PRISMA_LEAK),
      "INTERNAL_SERVER_ERROR",
      "production",
      "a1b2c3d4",
    );

    expect(masked.message).toBe(
      `${UNEXPECTED_ERROR_MESSAGE} Reference: a1b2c3d4`,
    );
    expect(masked.message).not.toContain("prisma");
  });

  it("omits the reference when the request has none", () => {
    // `createContext` throwing is the real case: tRPC then calls both error
    // callbacks with `ctx` undefined, so there is no id to quote. Inventing
    // one would give the user a reference that appears in no log line.
    const masked = maskUnexpectedError(
      shapeFor(PRISMA_LEAK),
      "INTERNAL_SERVER_ERROR",
      "production",
      undefined,
    );

    expect(masked.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(masked.message).not.toContain("Reference");
  });

  it("does not attach a reference to a deliberate refusal", () => {
    // A refusal is not a fault, so there is nothing to look up.
    const refusal = shapeFor("You are already in a carpool group.");

    expect(
      maskUnexpectedError(refusal, "CONFLICT", "production", "a1b2c3d4"),
    ).toBe(refusal);
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
describe("newRequestId", () => {
  it("is eight hex characters, short enough to read aloud", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs between requests", () => {
    const ids = new Set(Array.from({ length: 500 }, newRequestId));

    // Collisions are possible at 4 bytes and acceptable - see requestId.ts -
    // but a generator returning a constant would fail this outright.
    expect(ids.size).toBeGreaterThan(490);
  });

  it("carries nothing from the request", () => {
    // Not a user id, a session id or a timestamp. The masking this supports
    // exists so the client learns nothing about the fault, and the reference
    // must not undo that.
    const id = newRequestId();

    expect(id).not.toMatch(/\d{10,}/);
    expect(Number.isNaN(Number(id)) || id.length === 8).toBe(true);
  });
});

describe("createContext supplies the reference", () => {
  // The link the wire tests below cannot cover, because they inject their own
  // context: that the real one actually carries an id for every request.
  it("puts a fresh id on every context", async () => {
    const first = await createContext();
    const second = await createContext();

    expect(first.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(second.requestId).not.toBe(first.requestId);
  });
});

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

  it("gives the client the same reference the log records", async () => {
    // The whole point. Neither half is useful alone: a reference
    // the user can quote that appears in no log line, or a log line with an id
    // the user was never told. This asserts they are the identical value, and
    // that it came from the context rather than being generated twice.
    const logged: unknown[] = [];
    const requestId = newRequestId();

    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/user.me?input=%7B%7D"),
      router: appRouter,
      createContext: () =>
        ({
          requestId,
          session: sessionFor("alice"),
          prisma: {
            user: { findUnique: () => Promise.reject(new Error(PRISMA_LEAK)) },
          },
        }) as unknown as Context,
      // The same shape `[trpc].ts` uses to read it.
      onError: ({ ctx }) => logged.push(ctx?.requestId),
    });
    const body = await response.json();

    expect(logged).toEqual([requestId]);
    expect(body.error.json.message).toBe(
      `${UNEXPECTED_ERROR_MESSAGE} Reference: ${requestId}`,
    );
    // Still nothing of the fault itself, which is what the reference replaces.
    expect(JSON.stringify(body)).not.toContain("prisma.user.update");
  });

  it("omits the reference when context creation itself failed", async () => {
    // tRPC calls both callbacks with `ctx` undefined here, so there is no id
    // on either side. Verified against tRPC 11.18.0 rather than assumed.
    const seen: unknown[] = [];

    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/user.me?input=%7B%7D"),
      router: appRouter,
      createContext: () => {
        throw new Error("context exploded");
      },
      onError: ({ ctx }) => seen.push(ctx?.requestId ?? "none"),
    });
    const body = await response.json();

    expect(seen).toEqual(["none"]);
    expect(body.error.json.message).not.toContain("Reference");
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
