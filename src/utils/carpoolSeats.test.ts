import {
  MAX_SEATS_AVAILABLE,
  driverHasNoSeatsExplanation,
  SEAT_AVAILABLE_FILTER,
  clampSeats,
  hasSeatAvailable,
  isSeatCountInRange,
} from "./carpoolSeats";

/**
 * Every value worth asking about, including the one this ticket is named for.
 * `-1` is not hypothetical: it is what an ACTIVE driver's row held in
 * production-derived data, written by the accounting SCRUM-229 fixed.
 */
const SEAT_COUNTS = [-3, -1, 0, 1, 2, MAX_SEATS_AVAILABLE, 7, 12];

describe("hasSeatAvailable", () => {
  it("treats every non-positive count as no space", () => {
    expect(hasSeatAvailable(-3)).toBe(false);
    expect(hasSeatAvailable(-1)).toBe(false);
    expect(hasSeatAvailable(0)).toBe(false);
  });

  it("treats any positive count as space", () => {
    expect(hasSeatAvailable(1)).toBe(true);
    expect(hasSeatAvailable(MAX_SEATS_AVAILABLE)).toBe(true);
  });
});

/**
 * The predicate the database evaluates and the predicate JavaScript evaluates
 * have to be the same one. They were not: `reserveSeat` decremented under
 * `{ gt: 0 }` while the read path tested `=== 0`, which agreed on every value
 * except a negative — and a negative was exactly what production held.
 *
 * This is the test the acceptance criteria ask for: it fails if either side is
 * changed alone. Weakening the filter to `{ not: 0 }` makes `-1` disagree;
 * weakening `hasSeatAvailable` to `seats !== 0` does the same from the other
 * direction.
 */
describe("SEAT_AVAILABLE_FILTER agrees with hasSeatAvailable", () => {
  /** Evaluates just the operators this constant is allowed to use. */
  const filterKeeps = (
    filter: Record<string, unknown>,
    seats: number,
  ): boolean => {
    const entries = Object.entries(filter);
    expect(entries.length).toBe(1);

    const [op, operand] = entries[0];
    switch (op) {
      case "gt":
        return seats > (operand as number);
      case "gte":
        return seats >= (operand as number);
      case "not":
        return seats !== (operand as number);
      default:
        throw new Error(`unhandled seat filter operator: ${op}`);
    }
  };

  it.each(SEAT_COUNTS)("agrees on %i", (seats) => {
    expect(filterKeeps(SEAT_AVAILABLE_FILTER, seats)).toBe(
      hasSeatAvailable(seats),
    );
  });

  it("keeps a negative count out, which `not: 0` did not", () => {
    expect(filterKeeps(SEAT_AVAILABLE_FILTER, -1)).toBe(false);
    // The predicate the filter replaced, shown failing, so that reverting it
    // cannot look like a no-op.
    expect(filterKeeps({ not: 0 }, -1)).toBe(true);
  });
});

describe("isSeatCountInRange", () => {
  it("accepts the whole legal range and nothing outside it", () => {
    for (const seats of SEAT_COUNTS) {
      expect(isSeatCountInRange(seats)).toBe(
        seats >= 0 && seats <= MAX_SEATS_AVAILABLE,
      );
    }
  });

  it("rejects a fractional count the column could not hold", () => {
    expect(isSeatCountInRange(2.5)).toBe(false);
  });

  it("agrees with clampSeats: a clamped integer is always in range", () => {
    for (const seats of SEAT_COUNTS) {
      expect(isSeatCountInRange(clampSeats(seats))).toBe(true);
    }
  });
});

describe("driverHasNoSeatsExplanation", () => {
  const driver = (seatAvail: number | undefined) => ({
    role: "DRIVER",
    seatAvail,
    preferredName: "Sam",
  });

  it("explains a driver with no seats, naming them", () => {
    expect(driverHasNoSeatsExplanation(driver(0))).toBe(
      "Sam has no seats free in their car right now, so they could not " +
        "accept a request yet.",
    );
  });

  it("says the same for a negative count", () => {
    // One predicate, so the SCRUM-348 row needs no branch of its own.
    expect(driverHasNoSeatsExplanation(driver(-1))).toBe(
      driverHasNoSeatsExplanation(driver(0)),
    );
  });

  it("is silent for a driver with room", () => {
    expect(driverHasNoSeatsExplanation(driver(1))).toBeNull();
    expect(driverHasNoSeatsExplanation(driver(MAX_SEATS_AVAILABLE))).toBeNull();
  });

  it("is silent for a rider, whose seat count is 0 by convention", () => {
    expect(
      driverHasNoSeatsExplanation({
        role: "RIDER",
        seatAvail: 0,
        preferredName: "Sam",
      }),
    ).toBeNull();
  });

  it("is silent before the count has loaded", () => {
    // `undefined` is "not known yet", not "no space" — refusing on it would
    // put a notice on every card for the moment before the payload arrives.
    expect(driverHasNoSeatsExplanation(driver(undefined))).toBeNull();
  });

  it("phrases it as temporary, matching the other card notices", () => {
    // The role and status notices say "right now" because those states are
    // reversible. A seat count is the most reversible of the three.
    expect(driverHasNoSeatsExplanation(driver(0))).toContain("right now");
  });
});
