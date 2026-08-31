import { countRows, reduction } from "./measure-candidate-rows";

/**
 * Tested because a measurement
 * that quietly counts wrong is worse than no measurement.
 */
describe("countRows", () => {
  const row = (id: string, home: string, company: string) => ({
    userId: id,
    homeLocationId: home,
    companyLocationId: company,
  });

  it("counts one user and two locations per search", () => {
    expect(countRows([row("a", "h1", "c1")])).toEqual({
      carpoolSearch: 1,
      location: 2,
      user: 1,
      total: 4,
    });
  });

  it("counts a shared location once, because Prisma fetches it once", () => {
    // Two searches pointing at the same company row: the include is a single
    // `IN (...)`, so that row is read once, not twice.
    const counts = countRows([
      row("a", "h1", "shared"),
      row("b", "h2", "shared"),
    ]);

    expect(counts.location).toBe(3);
    expect(counts.total).toBe(3 + 2 + 2);
  });

  it("is zero for an empty result", () => {
    expect(countRows([])).toEqual({
      carpoolSearch: 0,
      location: 0,
      user: 0,
      total: 0,
    });
  });
});

describe("reduction", () => {
  it("reports the percentage saved", () => {
    expect(reduction(100, 25)).toBe(75);
  });

  it("is zero when nothing was saved", () => {
    expect(reduction(50, 50)).toBe(0);
  });

  it("does not report a negative saving when the bounded query read more", () => {
    expect(reduction(10, 20)).toBe(0);
  });

  it("handles an empty database without dividing by zero", () => {
    expect(reduction(0, 0)).toBe(0);
  });
});
