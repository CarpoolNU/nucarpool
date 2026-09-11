import { isValidCoordinates } from "./coordinates";

/**
 * Pins the behaviour of a validator that was moved out of `pages/index.tsx` in
 * an earlier extraction so `viewRouteClick.ts` could share it. A move is exactly when a
 * guard's edges are worth stating: nothing else would notice if one shifted.
 */
describe("isValidCoordinates", () => {
  it("accepts an ordinary pair", () => {
    expect(isValidCoordinates(-71.088748, 42.33907)).toBe(true);
  });

  it("accepts null island, deliberately", () => {
    // It judges usability, not plausibility. These guards exist to keep NaN
    // out of `fitBounds` and out of the directions request, and the server's
    // own range checks in `utils/coordinates.ts` are a separate matter.
    expect(isValidCoordinates(0, 0)).toBe(true);
  });

  it("rejects a missing value on either side", () => {
    expect(isValidCoordinates(undefined, 42.3)).toBe(false);
    expect(isValidCoordinates(-71.1, undefined)).toBe(false);
    expect(isValidCoordinates()).toBe(false);
  });

  it("rejects NaN on either side", () => {
    expect(isValidCoordinates(NaN, 42.3)).toBe(false);
    expect(isValidCoordinates(-71.1, NaN)).toBe(false);
  });

  it("rejects an infinity on either side", () => {
    expect(isValidCoordinates(Infinity, 42.3)).toBe(false);
    expect(isValidCoordinates(-71.1, -Infinity)).toBe(false);
  });
});
