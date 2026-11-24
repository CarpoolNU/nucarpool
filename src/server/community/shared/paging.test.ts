import { MAX_PAGE_SIZE, clampPageSize } from "./paging";

describe("clampPageSize", () => {
  it.each([
    [undefined, 20],
    [10, 10],
    [0, 1],
    [-5, 1],
    [1_000_000, MAX_PAGE_SIZE],
    [Number.NaN, 20],
    [7.9, 7],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampPageSize(input)).toBe(expected);
  });
});
