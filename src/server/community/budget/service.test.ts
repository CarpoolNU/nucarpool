import { FakeCommunityHost } from "../host/fakeHost";
import { FakeBudgetRepository } from "../testing/fakeBudgetRepository";
import { BUDGET_RULES, HOUR_MS } from "./policy";
import { BudgetService } from "./service";

const USER = "user-1";
const OTHER = "user-2";

/** The host's default clock, and the hour bucket it falls in. */
const NOW = new Date("2026-10-09T12:34:56.789Z");
const WINDOW = new Date("2026-10-09T12:00:00.000Z");

const build = () => {
  const repository = new FakeBudgetRepository();
  const host = new FakeCommunityHost(NOW);
  return { repository, host, service: new BudgetService(repository, host) };
};

/** Spends a whole bucket, returning the last claim granted. */
const spendToCap = async (service: BudgetService, user = USER) => {
  let last = await service.claim(user, "POST_CREATE");
  for (let i = 1; i < BUDGET_RULES.POST_CREATE.limit; i++) {
    last = await service.claim(user, "POST_CREATE");
  }
  return last;
};

describe("BudgetService.claim", () => {
  it("grants claims up to the limit and refuses past it", async () => {
    const { service } = build();
    for (let i = 0; i < BUDGET_RULES.POST_CREATE.limit; i++) {
      expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(true);
    }
    expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(false);
  });

  it("refunds exactly one, freeing exactly one more claim", async () => {
    const { service } = build();
    const last = await spendToCap(service);

    await last.refund();

    expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(true);
    expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(false);
  });

  it("is a no-op when refunding a refused claim", async () => {
    const { service } = build();
    await spendToCap(service);
    const refused = await service.claim(USER, "POST_CREATE");
    expect(refused.claimed).toBe(false);

    await refused.refund();

    expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(false);
  });

  it("never drives the count below zero when refunded twice", async () => {
    const { service, repository } = build();
    const claim = await service.claim(USER, "POST_CREATE");

    await claim.refund();
    await claim.refund();

    expect(repository.countFor(USER, "POST_CREATE", WINDOW)).toBe(0);
  });

  it("starts a fresh bucket in a new window while the old one keeps its count", async () => {
    const { service, host, repository } = build();
    await spendToCap(service);

    host.setNow(new Date(NOW.getTime() + HOUR_MS));

    expect((await service.claim(USER, "POST_CREATE")).claimed).toBe(true);
    expect(repository.countFor(USER, "POST_CREATE", WINDOW)).toBe(
      BUDGET_RULES.POST_CREATE.limit,
    );
  });

  it("does not share a bucket between two actions by one user", async () => {
    const { service } = build();
    await spendToCap(service);

    expect((await service.claim(USER, "COMMENT_CREATE")).claimed).toBe(true);
  });

  it("does not share a bucket between two users for one action", async () => {
    const { service } = build();
    await spendToCap(service);

    expect((await service.claim(OTHER, "POST_CREATE")).claimed).toBe(true);
  });

  it("asks the repository for the floored window, not the raw clock", async () => {
    const { service, repository } = build();

    await service.claim(USER, "POST_CREATE");

    expect(repository.countFor(USER, "POST_CREATE", WINDOW)).toBe(1);
    expect(repository.countFor(USER, "POST_CREATE", NOW)).toBe(0);
  });

  it("resolves each action's own limit from the policy table", async () => {
    // POST_CREATE and VOTE have different caps; a service that hard-coded one
    // window's rule would refuse the 11th vote.
    const { service } = build();
    for (let i = 0; i < BUDGET_RULES.POST_CREATE.limit + 1; i++) {
      await service.claim(USER, "VOTE");
    }

    expect((await service.claim(USER, "VOTE")).claimed).toBe(true);
  });
});
