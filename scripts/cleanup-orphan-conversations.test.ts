import {
  type Candidate,
  parseArgs,
  selectCandidates,
} from "./cleanup-orphan-conversations";

/**
 * The script deletes production rows, and unlike the other cleanup it deletes
 * *message content* — words two people typed to each other. So the argument
 * parser is the last thing standing between a typo and irreversible data loss.
 * These pin the two properties that matter: deleting is opt-in, and anything
 * unrecognised stops the run rather than being ignored.
 *
 * Which conversations *qualify* is covered in
 * `src/server/db/conversationLink.test.ts`, where the orphan predicate lives.
 * Which of those a given run *acts on* is `selectCandidates`, covered below —
 * that is the arithmetic deciding which private messages a tranche destroys, so
 * it is worth proving without a database. Importing this module is safe because
 * it only calls main() when run directly.
 */

describe("cleanup-orphan-conversations argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only deletes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // An explicit --dry-run after --apply wins, so the more cautious of two
    // conflicting flags is the one that takes effect.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    // `--aply` must not silently become a dry run that the operator reads as
    // "it deleted nothing, so there was nothing to delete".
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["extra"])).toThrow(/unknown argument/);
  });

  it("accepts a raised cap", () => {
    expect(parseArgs(["--apply", "--max", "2000"])).toEqual({
      apply: true,
      max: 2000,
    });
  });

  it("rejects a cap that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      expect(() => parseArgs(["--max", bad])).toThrow(/positive integer/);
    }
    expect(() => parseArgs(["--max"])).toThrow(/positive integer/);
  });
});

describe("cleanup-orphan-conversations tranche arguments", () => {
  it("still defaults to a dry run when a tranche is requested", () => {
    // The whole point of --limit is to make a large deletion *possible*, so it
    // must not also make one implicit.
    expect(parseArgs(["--limit", "400"]).apply).toBe(false);
    expect(parseArgs(["--older-than", "2025-01-01"]).apply).toBe(false);
  });

  it("accepts a limit", () => {
    expect(parseArgs(["--apply", "--limit", "400"])).toEqual({
      apply: true,
      max: 500,
      limit: 400,
    });
  });

  it("rejects a limit that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      expect(() => parseArgs(["--limit", bad])).toThrow(/positive integer/);
    }
    expect(() => parseArgs(["--limit"])).toThrow(/positive integer/);
  });

  it("parses a cutoff as UTC midnight", () => {
    // Local midnight would make the tranche depend on the operator's timezone,
    // which is the failure SCRUM-373 documents for the schedule columns.
    const { olderThan } = parseArgs(["--older-than", "2025-01-01"]);

    expect(olderThan?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("rejects a malformed cutoff", () => {
    for (const bad of [
      "2025-1-1",
      "01-01-2025",
      "2025/01/01",
      "yesterday",
      "",
    ]) {
      expect(() => parseArgs(["--older-than", bad])).toThrow(/YYYY-MM-DD/);
    }
    expect(() => parseArgs(["--older-than"])).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a date that does not exist", () => {
    // Date.UTC rolls these forward instead of refusing, which would silently
    // select a different tranche than the one asked for.
    for (const bad of [
      "2025-02-30",
      "2025-13-01",
      "2025-00-10",
      "2025-01-32",
    ]) {
      expect(() => parseArgs(["--older-than", bad])).toThrow(
        /real calendar date|YYYY-MM-DD/,
      );
    }
  });

  it("accepts a leap day in a leap year and refuses one otherwise", () => {
    expect(parseArgs(["--older-than", "2024-02-29"]).olderThan).toBeInstanceOf(
      Date,
    );
    expect(() => parseArgs(["--older-than", "2025-02-29"])).toThrow(
      /real calendar date/,
    );
  });
});

describe("selectCandidates", () => {
  const at = (day: string, id: string, messages = 1): Candidate => ({
    id,
    requestId: `r-${id}`,
    dateCreated: new Date(`${day}T00:00:00.000Z`),
    messages,
  });

  const newest = at("2025-03-01", "c-newest");
  const middle = at("2025-02-01", "c-middle");
  const oldest = at("2025-01-01", "c-oldest");
  const all = [newest, oldest, middle];

  it("selects everything when neither filter is given", () => {
    const { selected, deferred } = selectCandidates(all, {});

    expect(selected.map((c) => c.id)).toEqual([
      "c-oldest",
      "c-middle",
      "c-newest",
    ]);
    expect(deferred).toEqual([]);
  });

  it("takes the oldest N under a limit and defers the rest", () => {
    const { selected, deferred } = selectCandidates(all, { limit: 2 });

    expect(selected.map((c) => c.id)).toEqual(["c-oldest", "c-middle"]);
    expect(deferred.map((c) => c.id)).toEqual(["c-newest"]);
  });

  it("excludes a candidate created exactly at the cutoff", () => {
    // Strict, and documented as such: an inclusive cutoff would make two
    // successive tranches overlap on the boundary day.
    const { selected, deferred } = selectCandidates(all, {
      olderThan: new Date("2025-02-01T00:00:00.000Z"),
    });

    expect(selected.map((c) => c.id)).toEqual(["c-oldest"]);
    expect(deferred.map((c) => c.id)).toEqual(["c-middle", "c-newest"]);
  });

  it("applies both filters together", () => {
    const { selected, deferred } = selectCandidates(all, {
      limit: 1,
      olderThan: new Date("2025-03-01T00:00:00.000Z"),
    });

    expect(selected.map((c) => c.id)).toEqual(["c-oldest"]);
    expect(deferred.map((c) => c.id)).toEqual(["c-middle", "c-newest"]);
  });

  it("selects nothing when the cutoff predates every candidate", () => {
    const { selected, deferred } = selectCandidates(all, {
      olderThan: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(selected).toEqual([]);
    expect(deferred).toHaveLength(3);
  });

  it("orders ties by id so the same tranche is chosen twice", () => {
    const tied = [
      at("2025-01-01", "c-b"),
      at("2025-01-01", "c-a"),
      at("2025-01-01", "c-c"),
    ];

    expect(
      selectCandidates(tied, { limit: 2 }).selected.map((c) => c.id),
    ).toEqual(["c-a", "c-b"]);
    // Re-running on a differently ordered read must pick the same two, or a
    // resumed tranche would revisit rows it had already considered.
    expect(
      selectCandidates([...tied].reverse(), { limit: 2 }).selected.map(
        (c) => c.id,
      ),
    ).toEqual(["c-a", "c-b"]);
  });

  it("partitions without losing or duplicating a candidate", () => {
    // The property that matters for an irreversible operation: every candidate
    // is accounted for on exactly one side, so "deferred" really is the
    // remainder rather than a second chance to delete the same row.
    const { selected, deferred } = selectCandidates(all, {
      limit: 2,
      olderThan: new Date("2025-03-01T00:00:00.000Z"),
    });

    const ids = [...selected, ...deferred].map((c) => c.id).sort();

    expect(ids).toEqual(["c-middle", "c-newest", "c-oldest"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not mutate the array it is given", () => {
    const original = [...all];

    selectCandidates(all, { limit: 1 });

    expect(all).toEqual(original);
  });

  it("returns nothing for no candidates", () => {
    expect(selectCandidates([], { limit: 5 })).toEqual({
      selected: [],
      deferred: [],
    });
  });
});
