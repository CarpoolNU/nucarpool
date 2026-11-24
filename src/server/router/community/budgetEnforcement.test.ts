import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { BudgetService } from "../../community/budget/service";
import type { BudgetClaim } from "../../community/budget/ports";
import { FakeCommunityHost } from "../../community/host/fakeHost";
import { FakeBudgetRepository } from "../../community/testing/fakeBudgetRepository";
import {
  ContentUnavailableError,
  HandleTakenError,
  RateLimitedError,
} from "../../community/shared/errors";
import { router } from "../createRouter";
import type { Context } from "../context";
import { isServerFault, runWithClaim } from "./budgetEnforcement";
import { budgetedMember } from "./procedures";

const USER = "user-1";

const granted = (): BudgetClaim & { refund: jest.Mock } => ({
  claimed: true,
  refund: jest.fn(async () => undefined),
});

const refused = (): BudgetClaim & { refund: jest.Mock } => ({
  claimed: false,
  refund: jest.fn(async () => undefined),
});

describe("isServerFault", () => {
  it("is false for a domain error", () => {
    expect(isServerFault(new HandleTakenError())).toBe(false);
  });

  it.each<TRPC_ERROR_CODE_KEY>([
    "BAD_REQUEST",
    "NOT_FOUND",
    "CONFLICT",
    "FORBIDDEN",
    "TOO_MANY_REQUESTS",
  ])("is false for a client-coded TRPCError (%s)", (code) => {
    expect(isServerFault(new TRPCError({ code }))).toBe(false);
  });

  it("is true for an INTERNAL_SERVER_ERROR TRPCError", () => {
    expect(
      isServerFault(new TRPCError({ code: "INTERNAL_SERVER_ERROR" })),
    ).toBe(true);
  });

  it("is true for a non-Error throw", () => {
    expect(isServerFault("boom")).toBe(true);
    expect(isServerFault(undefined)).toBe(true);
  });

  it("is false for a server fault wrapping a domain error", () => {
    // tRPC converts anything thrown out of a handler with
    // `getTRPCErrorFromUnknown`, which wraps a non-TRPCError as
    // INTERNAL_SERVER_ERROR and hangs the original off `cause`. So a procedure
    // that forgot `mapDomainErrors` presents its domain refusal as a server
    // fault — and refunding it would restore exactly the free probe channel
    // spec §5's belt-and-braces `DomainError` arm was written to close.
    const wrapped = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      cause: new HandleTakenError(),
    });
    expect(isServerFault(wrapped)).toBe(false);
  });
});

describe("runWithClaim", () => {
  it("throws RateLimitedError and never runs the body on a refused claim", async () => {
    const run = jest.fn();
    await expect(runWithClaim(refused(), run)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the body's value and keeps the charge on success", async () => {
    const claim = granted();
    await expect(runWithClaim(claim, async () => "ok")).resolves.toBe("ok");
    expect(claim.refund).not.toHaveBeenCalled();
  });

  it("keeps the charge when the body throws a domain refusal", async () => {
    const claim = granted();
    await expect(
      runWithClaim(claim, async () => {
        throw new HandleTakenError();
      }),
    ).rejects.toBeInstanceOf(HandleTakenError);
    expect(claim.refund).not.toHaveBeenCalled();
  });

  it("keeps the charge when the body throws CONTENT_UNAVAILABLE as a mapped TRPCError", async () => {
    // The probe pays. §7.2 makes deleted, hidden and blocked-author content
    // indistinguishable precisely so content cannot be enumerated; refunding
    // every failed probe would hand that channel back.
    const claim = granted();
    await expect(
      runWithClaim(claim, async () => {
        throw new TRPCError({
          code: "NOT_FOUND",
          cause: new ContentUnavailableError(),
        });
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(claim.refund).not.toHaveBeenCalled();
  });

  it("refunds when the body throws a server fault, and rethrows it", async () => {
    const claim = granted();
    const fault = new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      runWithClaim(claim, async () => {
        throw fault;
      }),
    ).rejects.toBe(fault);
    expect(claim.refund).toHaveBeenCalledTimes(1);
  });

  it("refunds a non-Error throw", async () => {
    const claim = granted();
    await expect(
      runWithClaim(claim, async () => {
        throw "boom";
      }),
    ).rejects.toBe("boom");
    expect(claim.refund).toHaveBeenCalledTimes(1);
  });
});

describe("a claim that fails", () => {
  it("propagates a failed claim and attempts no refund", async () => {
    const repository = new FakeBudgetRepository();
    repository.failNextClaim(new Error("connection pool exhausted"));
    const service = new BudgetService(repository, new FakeCommunityHost());

    await expect(service.claim(USER, "POST_CREATE")).rejects.toThrow(
      "connection pool exhausted",
    );
  });
});

/**
 * The middleware over a real procedure.
 *
 * These exist because the unit tests above cannot see the one thing most
 * likely to be wrong: tRPC does not reject `next()` when a handler throws — it
 * catches and resolves `{ ok: false, error }` — so a middleware written as
 * `try { return await next() } catch { refund() }` compiles, reads correctly,
 * and never refunds anything.
 */
describe("budgetedMember over a real procedure", () => {
  const build = (handler: () => Promise<unknown>) => {
    const repository = new FakeBudgetRepository();
    const host = new FakeCommunityHost();
    const budgets = new BudgetService(repository, host);

    const appRouter = router({
      act: budgetedMember("POST_CREATE").mutation(() => handler()),
    });

    const ctx = {
      session: { user: { id: USER, permission: "USER" } },
      community: {
        profiles: {
          profileRef: async () => ({ id: "p1", handle: "HuskyCommuter" }),
        },
        budgets,
      },
    } as unknown as Context;

    return { caller: appRouter.createCaller(ctx), repository, budgets, host };
  };

  const windowStart = () => new Date("2026-10-09T12:00:00.000Z");

  it("charges a successful write", async () => {
    const { caller, repository } = build(async () => "written");

    await expect(caller.act()).resolves.toBe("written");

    expect(repository.countFor(USER, "POST_CREATE", windowStart())).toBe(1);
  });

  it("refuses with TOO_MANY_REQUESTS once the budget is spent", async () => {
    const { caller } = build(async () => "written");
    for (let i = 0; i < 10; i++) {
      await caller.act();
    }

    // Not INTERNAL_SERVER_ERROR: a domain error thrown out of middleware is
    // wrapped as a server fault unless the middleware maps it first.
    await expect(caller.act()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("does not run the handler once the budget is spent", async () => {
    const handler = jest.fn(async () => "written");
    const { caller } = build(handler);
    for (let i = 0; i < 10; i++) {
      await caller.act();
    }
    handler.mockClear();

    await expect(caller.act()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refunds the charge when the handler faults", async () => {
    const { caller, repository } = build(async () => {
      throw new Error("Invalid `prisma.communityPost.create()` invocation");
    });

    await expect(caller.act()).rejects.toThrow();

    expect(repository.countFor(USER, "POST_CREATE", windowStart())).toBe(0);
  });

  it("keeps the charge when the handler refuses on domain grounds", async () => {
    const { caller, repository } = build(async () => {
      throw new TRPCError({
        code: "NOT_FOUND",
        cause: new ContentUnavailableError(),
      });
    });

    await expect(caller.act()).rejects.toThrow();

    expect(repository.countFor(USER, "POST_CREATE", windowStart())).toBe(1);
  });

  it("fails closed when the claim statement itself throws", async () => {
    const handler = jest.fn(async () => "written");
    const { caller, repository } = build(handler);
    repository.failNextClaim(new Error("connection pool exhausted"));

    await expect(caller.act()).rejects.toThrow();

    // The write did not happen. Admitting it would buy availability that is not
    // real: it targets the database that just refused the claim (spec §6).
    expect(handler).not.toHaveBeenCalled();
  });
});
