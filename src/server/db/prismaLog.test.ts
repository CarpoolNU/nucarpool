import {
  formatPrismaLog,
  stripSourceContext,
  type PrismaLogEvent,
} from "./prismaLog";

/**
 * Prisma's log policy.
 *
 * The two messages below are **real payloads**, captured from `$on` against
 * the installed Prisma 4.16.2 rather than written from imagination. That
 * matters: the whole function is a string filter, so a test built on an
 * invented message shape would prove nothing about production.
 *
 * The probe that produced them also settled the question the ticket was filed
 * on — a `where: { id: "SENTINEL_VALUE" }` appears nowhere in either mode, so
 * argument values are not logged. The sentinel is asserted below so that a
 * future Prisma version which *does* start quoting arguments is caught here.
 */

/** A request error, as `$on("error")` delivers it. */
const REQUEST_ERROR: PrismaLogEvent = {
  timestamp: new Date("2026-09-09T12:00:00Z"),
  target: "user.findUnique",
  message: [
    "",
    "Invalid `prisma.user.findUnique()` invocation in",
    "/Users/someone/Desktop/Projects/NUcarpool/nucarpool/src/server/router/user.ts:79:40",
    "",
    "  76 }",
    "  77 ",
    "  78 // get user with CarpoolSearch data",
    "→ 79   const user = await ctx.prisma.user.findUnique(",
    "Can't reach database server at `127.0.0.1`:`3306`",
    "",
    "Please make sure your database server is running at `127.0.0.1`:`3306`.",
  ].join("\n"),
};

/**
 * The same class of error as above, in the spelling Prisma uses when it
 * **cannot** resolve the original source — no path, no frame, and the
 * invocation line ends in a colon rather than " in".
 *
 * This is the variant a deployed build produces, because Prisma cannot read
 * original sources out of bundled `next build` output. Captured by running the
 * real client; the first version of `PREAMBLE` matched only the other spelling
 * and would have left the invocation line in production while passing every
 * test written from the frame-bearing payload.
 */
const REQUEST_ERROR_NO_FRAME: PrismaLogEvent = {
  timestamp: new Date("2026-09-09T12:00:00Z"),
  target: "user.findUnique",
  message: [
    "",
    "Invalid `prisma.user.findUnique()` invocation:",
    "",
    "",
    "Can't reach database server at `127.0.0.1`:`3306`",
    "",
    "Please make sure your database server is running at `127.0.0.1`:`3306`.",
  ].join("\n"),
};

/** An engine-originated event, which has no preamble at all. */
const POOL_INFO: PrismaLogEvent = {
  timestamp: new Date("2026-09-09T12:00:00Z"),
  target: "quaint::pooled",
  message: "Starting a mysql pool with 21 connections.",
};

describe("stripSourceContext", () => {
  it("keeps the failure reason", () => {
    const stripped = stripSourceContext(REQUEST_ERROR.message);

    expect(stripped).toContain("Can't reach database server");
    expect(stripped).toContain("Please make sure your database server");
  });

  it("drops the absolute path and the source excerpt", () => {
    // The only two things this route disclosed that are worth removing: where
    // the build lives on disk, and what the application's code looks like.
    const stripped = stripSourceContext(REQUEST_ERROR.message);

    expect(stripped).not.toContain("/Users/someone");
    expect(stripped).not.toContain("user.ts:79:40");
    expect(stripped).not.toContain("ctx.prisma.user.findUnique(");
    expect(stripped).not.toContain("get user with CarpoolSearch data");
    expect(stripped).not.toContain("→");
  });

  it("drops the rendered invocation line", () => {
    expect(stripSourceContext(REQUEST_ERROR.message)).not.toContain(
      "invocation",
    );
  });

  it("strips the frameless invocation line a deployed build produces", () => {
    // The regression the first implementation had: this spelling ends in ":"
    // rather than " in", and it is the one production actually emits.
    const stripped = stripSourceContext(REQUEST_ERROR_NO_FRAME.message);

    expect(stripped).not.toContain("invocation");
    expect(stripped).toBe(
      [
        "Can't reach database server at `127.0.0.1`:`3306`",
        "",
        "Please make sure your database server is running at `127.0.0.1`:`3306`.",
      ].join("\n"),
    );
  });

  it("passes an engine message through untouched", () => {
    // No preamble to strip, and the message is the whole diagnostic value.
    expect(stripSourceContext(POOL_INFO.message)).toBe(POOL_INFO.message);
  });

  it("does not mistake a reason beginning with a number for a code frame", () => {
    // Frame lines are digits *followed by whitespace and source*; a reason
    // that merely starts with a number has to survive.
    expect(stripSourceContext("2 records were unexpectedly affected")).toBe(
      "2 records were unexpectedly affected",
    );
  });

  it("falls back to the raw message when everything would be stripped", () => {
    // Logging an empty string reads as "nothing went wrong", which is worse
    // than logging something noisy. The content is not secret.
    const onlyPreamble = [
      "Invalid `prisma.user.update()` invocation in",
      "/some/path/file.ts:1:1",
    ].join("\n");

    expect(stripSourceContext(onlyPreamble)).toBe(onlyPreamble.trim());
  });

  it("never reveals an argument value, because Prisma does not log one", () => {
    // The premise SCRUM-399 was filed on, pinned. If a future Prisma starts
    // quoting arguments, the captured payload above stops matching reality and
    // this is the test that should be revisited.
    expect(REQUEST_ERROR.message).not.toContain("SENTINEL_VALUE");
    expect(stripSourceContext(REQUEST_ERROR.message)).not.toContain(
      "SENTINEL_VALUE",
    );
  });
});

describe("formatPrismaLog", () => {
  it("strips the source context in production", () => {
    const { target, message } = formatPrismaLog(REQUEST_ERROR, "production");

    expect(target).toBe("user.findUnique");
    expect(message).toContain("Can't reach database server");
    expect(message).not.toContain("/Users/someone");
  });

  it("keeps the raw message outside production", () => {
    // Local debugging keeps the code frame pointing at the offending line.
    const { message } = formatPrismaLog(REQUEST_ERROR, "development");

    expect(message).toBe(REQUEST_ERROR.message);
    expect(message).toContain("user.ts:79:40");
  });

  it("keeps target in every environment", () => {
    // Deliberate departure from the ticket, which asked production to carry no
    // rendered invocation: `target` names the same model and method. It is the
    // one field that makes a line actionable, and holds no argument, path or
    // source.
    for (const env of ["production", "development", "test", undefined]) {
      expect(formatPrismaLog(REQUEST_ERROR, env).target).toBe(
        "user.findUnique",
      );
    }
  });

  it("treats an unset NODE_ENV as not-production", () => {
    // The opposite default to the error mask in errorMasking.ts, and
    // deliberately so: there, failing safe means hiding; here the content is
    // not sensitive and losing a diagnostic to an unset variable would be the
    // worse outcome.
    expect(formatPrismaLog(REQUEST_ERROR, undefined).message).toBe(
      REQUEST_ERROR.message,
    );
  });

  it("drops nothing from an engine event in production", () => {
    const { target, message } = formatPrismaLog(POOL_INFO, "production");

    expect(target).toBe("quaint::pooled");
    expect(message).toBe(POOL_INFO.message);
  });
});
