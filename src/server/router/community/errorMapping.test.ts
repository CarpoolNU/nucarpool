import { TRPCError } from "@trpc/server";
import {
  AlreadyResolvedError,
  CategoryUnknownError,
  ContentUnavailableError,
  HandleTakenError,
  NotEligibleError,
  NotModeratorError,
  RateLimitedError,
} from "../../community/shared/errors";
import { DOMAIN_ERROR_CODES, toTRPCError } from "./errorMapping";

describe("toTRPCError", () => {
  it("maps a domain error to its code and keeps the message", () => {
    try {
      toTRPCError(new HandleTakenError());
      fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("CONFLICT");
      expect((error as TRPCError).message).toMatch(/already taken/i);
    }
  });

  it("answers NOT_FOUND for unavailable content so a block cannot be probed", () => {
    // If this were FORBIDDEN, a user could tell "exists but blocked" from
    // "does not exist" and map handles to people they have blocks with.
    expect(DOMAIN_ERROR_CODES.CONTENT_UNAVAILABLE).toBe("NOT_FOUND");
    expect(DOMAIN_ERROR_CODES.CATEGORY_UNKNOWN).toBe("NOT_FOUND");
  });

  it("uses FORBIDDEN, not UNAUTHORIZED, for an ineligible signed-in user", () => {
    // UNAUTHORIZED would send the client off to re-authenticate, which fixes
    // nothing: they are signed in and simply have no handle yet.
    expect(DOMAIN_ERROR_CODES.NOT_ELIGIBLE).toBe("FORBIDDEN");
  });

  it("rethrows a non-domain error untouched so masking still applies", () => {
    const fault = new Error("Invalid `prisma.user.findMany()` invocation");
    expect(() => toTRPCError(fault)).toThrow(fault);
  });

  it.each([
    [new NotEligibleError("no"), "FORBIDDEN"],
    [new ContentUnavailableError(), "NOT_FOUND"],
    [new CategoryUnknownError("x"), "NOT_FOUND"],
  ])("maps %s", (error, expected) => {
    expect(() => toTRPCError(error)).toThrow(
      expect.objectContaining({ code: expected }),
    );
  });
  it("maps no domain code to INTERNAL_SERVER_ERROR", () => {
    // `isServerFault` treats a TRPCError whose `cause` is a DomainError as a
    // refusal that keeps its charge, and that is only safe while no domain code
    // maps here to INTERNAL_SERVER_ERROR. Map one, and a genuine refusal would
    // start being refunded — a silent free channel through the rate limiter.
    expect(Object.values(DOMAIN_ERROR_CODES)).not.toContain(
      "INTERNAL_SERVER_ERROR",
    );
  });

  it("maps a rate-limited refusal to TOO_MANY_REQUESTS", () => {
    expect(() => toTRPCError(new RateLimitedError())).toThrow(
      expect.objectContaining({ code: "TOO_MANY_REQUESTS" }),
    );
  });

  it("names no limit and no reset time in the message", () => {
    // A limit disclosed is a limit designed around. See the spec, §9.2.
    const message = new RateLimitedError().message;
    expect(message).not.toMatch(/\d/);
  });

  it("maps a non-moderator refusal to FORBIDDEN", () => {
    expect(() => toTRPCError(new NotModeratorError())).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("maps an already-resolved report to CONFLICT", () => {
    expect(() => toTRPCError(new AlreadyResolvedError())).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });
});
