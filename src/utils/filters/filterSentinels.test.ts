/**
 * The "any" sentinels, and the agreement between the slider's ceiling and the
 * scorer's.
 *
 * 20 miles and 4 hours were bare literals in five places: the slider's `max`,
 * its gradient arithmetic and its `20+` label in `Filters.tsx`; the initial
 * filter state in `pages/index.tsx`; `DISTANCE_FILTER_MAX` in
 * `candidateSearch.ts`; the two comparisons in `recommendation.ts`; and
 * `anyFilters` in `recommendation.fixtures.ts`. Raising the slider's ceiling
 * to 30 while the scorer still stopped filtering at 20 would have shown
 * unfiltered results for the top third of the track, silently.
 *
 * **Asserting the numbers would be worthless.** A test saying
 * `DISTANCE_FILTER_ANY === 20` restates the definition and keeps passing
 * through exactly the drift it is meant to catch. So every assertion here is
 * behavioural: the sentinel switches its filter off, and the value one below
 * it is a real bound. Each pair is a test and its own control - without the
 * second, the first passes for a scorer that never filters at all.
 *
 * `undefined` is how `calculateScore` signals "filtered out", which is what
 * `isMatch` reads.
 */

import { Role } from "@prisma/client";
import { calculateScore } from "../recommendation";
import type { FInputs } from "../recommendation";
import {
  anyFilters,
  at,
  buildSearch,
  milesNorth,
  ORIGIN,
  SearchFixture,
} from "../recommendation.fixtures";
import { DISTANCE_FILTER_ANY, TIME_FILTER_ANY } from "./filterSentinels";

const isMatch = (
  current: SearchFixture,
  candidate: SearchFixture,
  filters: Partial<FInputs> = {},
): boolean =>
  calculateScore(current, anyFilters(filters), "any")(candidate) !== undefined;

/** The searcher: a rider on the origin, 9-to-5 weekdays. */
const rider = (options = {}) =>
  buildSearch({ id: "current", role: Role.RIDER, seatsAvail: 0, ...options });

const driver = (options = {}) =>
  buildSearch({
    id: "candidate",
    role: Role.DRIVER,
    seatsAvail: 4,
    ...options,
  });

describe("DISTANCE_FILTER_ANY", () => {
  /**
   * Far enough out that no sub-sentinel bound admits it, and on both legs, so
   * neither the home nor the company comparison can carry the result alone.
   */
  const faraway = () =>
    driver({
      home: milesNorth(DISTANCE_FILTER_ANY + 40),
      company: milesNorth(DISTANCE_FILTER_ANY + 40),
    });

  it("switches the distance filter off, rather than bounding it at the top value", () => {
    expect(
      isMatch(rider(), faraway(), {
        startDistance: DISTANCE_FILTER_ANY,
        endDistance: DISTANCE_FILTER_ANY,
      }),
    ).toBe(true);
  });

  it("applies a real bound one mile below the sentinel", () => {
    expect(
      isMatch(rider(), faraway(), {
        startDistance: DISTANCE_FILTER_ANY - 1,
        endDistance: DISTANCE_FILTER_ANY,
      }),
    ).toBe(false);
    expect(
      isMatch(rider(), faraway(), {
        startDistance: DISTANCE_FILTER_ANY,
        endDistance: DISTANCE_FILTER_ANY - 1,
      }),
    ).toBe(false);
  });

  it("still admits a candidate inside a sub-sentinel bound", () => {
    // So the control above is failing on the distance and not on something
    // else the fixture changed.
    const nearby = driver({ home: milesNorth(2), company: ORIGIN });

    expect(
      isMatch(rider(), nearby, {
        startDistance: DISTANCE_FILTER_ANY - 1,
        endDistance: DISTANCE_FILTER_ANY - 1,
      }),
    ).toBe(true);
  });
});

describe("TIME_FILTER_ANY", () => {
  /**
   * Six hours off the searcher's 9-to-5 on both ends - outside every
   * sub-sentinel deviation the slider offers, since the sentinel is a maximum
   * in hours.
   */
  const offSchedule = () => driver({ startTime: at(15), endTime: at(23) });

  it("switches the schedule filter off, rather than bounding it at the top value", () => {
    expect(
      isMatch(rider(), offSchedule(), {
        startTime: TIME_FILTER_ANY,
        endTime: TIME_FILTER_ANY,
      }),
    ).toBe(true);
  });

  it("applies a real bound one hour below the sentinel", () => {
    expect(
      isMatch(rider(), offSchedule(), {
        startTime: TIME_FILTER_ANY - 1,
        endTime: TIME_FILTER_ANY,
      }),
    ).toBe(false);
    expect(
      isMatch(rider(), offSchedule(), {
        startTime: TIME_FILTER_ANY,
        endTime: TIME_FILTER_ANY - 1,
      }),
    ).toBe(false);
  });

  it("still admits a candidate inside a sub-sentinel bound", () => {
    const closeSchedule = driver({ startTime: at(10), endTime: at(18) });

    expect(
      isMatch(rider(), closeSchedule, {
        startTime: TIME_FILTER_ANY - 1,
        endTime: TIME_FILTER_ANY - 1,
      }),
    ).toBe(true);
  });
});
