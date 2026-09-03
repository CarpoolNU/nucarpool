import { MAX_SEATS_AVAILABLE } from "../../utils/carpoolSeats";
import { findOutOfRangeSeatRows, SeatCountRow } from "./seatIntegrity";

const row = (
  seatsAvail: number,
  id = `search-${seatsAvail}`,
): SeatCountRow => ({
  id,
  userId: `user-${id}`,
  role: "DRIVER",
  status: "ACTIVE",
  seatsAvail,
  carpoolId: null,
});

describe("findOutOfRangeSeatRows", () => {
  it("selects exactly the out-of-range rows and leaves the rest", () => {
    const rows = [row(-1), row(0), row(3), row(7)];

    const found = findOutOfRangeSeatRows(rows);

    expect(found.map(({ row }) => row.seatsAvail)).toEqual([-1, 7]);
  });

  it("repairs a negative count to zero rather than a guessed capacity", () => {
    // Capacity is not stored separately, so it cannot be recovered. Zero is
    // truthful; anything higher would be invented and could over-subscribe a
    // real car.
    const [found] = findOutOfRangeSeatRows([row(-1)]);

    expect(found.repairTo).toBe(0);
  });

  it("repairs an excessive count down to the maximum", () => {
    const [found] = findOutOfRangeSeatRows([row(12)]);

    expect(found.repairTo).toBe(MAX_SEATS_AVAILABLE);
  });

  it("returns nothing when every row is in range", () => {
    const rows = [row(0), row(1), row(MAX_SEATS_AVAILABLE)];

    expect(findOutOfRangeSeatRows(rows)).toEqual([]);
  });

  /**
   * The idempotency the repair depends on: feeding it the values it would have
   * written finds nothing to do. A second `--apply` is a no-op for the same
   * reason.
   */
  it("finds nothing in the rows a previous repair would have written", () => {
    const first = findOutOfRangeSeatRows([row(-1), row(-4), row(9), row(2)]);

    const repaired = first.map(({ row: original, repairTo }) =>
      row(repairTo, original.id),
    );

    expect(findOutOfRangeSeatRows(repaired)).toEqual([]);
  });

  it("always proposes a value that is itself in range", () => {
    const found = findOutOfRangeSeatRows([
      row(-1),
      row(-100),
      row(7),
      row(2.5),
    ]);

    for (const { repairTo } of found) {
      expect(repairTo).toBeGreaterThanOrEqual(0);
      expect(repairTo).toBeLessThanOrEqual(MAX_SEATS_AVAILABLE);
      expect(Number.isInteger(repairTo)).toBe(true);
    }
  });

  it("carries the identifiers a report needs, not the whole row set", () => {
    const [found] = findOutOfRangeSeatRows([
      { ...row(-1), userId: "u1", carpoolId: "group-1" },
    ]);

    expect(found.row.userId).toBe("u1");
    expect(found.row.carpoolId).toBe("group-1");
  });
});
