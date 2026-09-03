import {
  parseArgs,
  planBackfill,
  type PictureObject,
} from "./backfill-profile-picture-timestamps";

/**
 * The two halves of this script that can be tested without a database or a
 * network: what the arguments mean, and what it decides to write.
 *
 * The listing and the updates are deliberately outside these, so importing this
 * module opens no connection to anything — the `require.main === module` guard
 * in the script is what makes that true.
 */

describe("parseArgs", () => {
  it("does not write without --apply", () => {
    // The property worth pinning above all others on a script that writes to
    // production rows.
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("writes only when --apply is passed", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("lets --dry-run cancel an earlier --apply", () => {
    // Order matters and the last one wins, so a typo-corrected command line
    // does what it looks like it does.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("accepts a raised ceiling", () => {
    expect(parseArgs(["--apply", "--max", "2000"])).toEqual({
      apply: true,
      max: 2000,
    });
  });

  it.each([
    ["--max", "0"],
    ["--max", "-1"],
    ["--max", "1.5"],
    ["--max", "all"],
  ])("rejects %s %s rather than defaulting it", (...argv) => {
    expect(() => parseArgs(argv)).toThrow(/--max expects a positive integer/);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    // A misspelled flag must not silently become a dry run that the operator
    // reads as an apply, or the reverse.
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });

  it("has no argument spelling that reaches a write on its own", () => {
    for (const argv of [[], ["--dry-run"], ["--max", "10"]]) {
      expect(parseArgs(argv).apply).toBe(false);
    }
  });
});

describe("planBackfill", () => {
  const env = "staging";
  const now = new Date("2026-09-03T14:00:00Z");
  const uploaded = new Date("2025-04-01T09:30:00Z");

  const object = (key: string, lastModified?: Date): PictureObject => ({
    key,
    lastModified,
  });

  it("records a picture for a user whose column is null", () => {
    const plan = planBackfill(
      [object(`profile-pictures/${env}/user-1`, uploaded)],
      env,
      new Set(["user-1"]),
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates).toEqual([
      { userId: "user-1", uploadedAt: uploaded },
    ]);
  });

  it("writes the object's LastModified, not the time of the run", () => {
    // The column is meant to say when the picture last changed. Writing `now`
    // would claim every historical picture was uploaded on backfill day, which
    // defeats its use as a cache-busting key.
    const plan = planBackfill(
      [object(`profile-pictures/${env}/user-1`, uploaded)],
      env,
      new Set(["user-1"]),
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates[0].uploadedAt).toBe(uploaded);
    expect(plan.candidates[0].uploadedAt).not.toBe(now);
  });

  it("falls back to now when the listing carries no LastModified", () => {
    // S3 always returns it for a real object, so this is defence against a
    // truncated response. An approximate timestamp beats skipping a picture
    // that exists.
    const plan = planBackfill(
      [object(`profile-pictures/${env}/user-1`)],
      env,
      new Set(["user-1"]),
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates).toEqual([{ userId: "user-1", uploadedAt: now }]);
  });

  it("never overwrites a timestamp already recorded", () => {
    // The re-run-is-a-no-op property, and the one that stops the backfill
    // moving a fresh upload backwards in time to an old object's date.
    const plan = planBackfill(
      [object(`profile-pictures/${env}/user-1`, uploaded)],
      env,
      new Set(), // nothing is null: user-1 already has a timestamp
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([
      { userId: "user-1", reason: "already-recorded" },
    ]);
  });

  it("reports a picture whose user no longer exists rather than writing it", () => {
    // Deleting a User is currently impossible (SCRUM-311), so this is mostly
    // defence — but an update by a primary key that does not exist throws, and
    // aborting the whole run over one stray object would be the wrong trade.
    const plan = planBackfill(
      [object(`profile-pictures/${env}/ghost`, uploaded)],
      env,
      new Set(["user-1"]),
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([{ userId: "ghost", reason: "no-such-user" }]);
  });

  it("collects keys that are not pictures instead of guessing at them", () => {
    const plan = planBackfill(
      [
        object(`profile-pictures/${env}/`),
        object(`profile-pictures/${env}/user-1/thumb.png`, uploaded),
        object("something/else", uploaded),
      ],
      env,
      new Set(["user-1"]),
      new Set(["user-1"]),
      now,
    );

    expect(plan.candidates).toEqual([]);
    expect(plan.unparseableKeys).toEqual([
      `profile-pictures/${env}/`,
      `profile-pictures/${env}/user-1/thumb.png`,
      "something/else",
    ]);
  });

  it("classifies every object into exactly one bucket", () => {
    // Stated as a count so that a new branch cannot drop an object silently:
    // anything the plan does not write must be visible in the report.
    const objects = [
      object(`profile-pictures/${env}/user-1`, uploaded),
      object(`profile-pictures/${env}/user-2`, uploaded),
      object(`profile-pictures/${env}/ghost`, uploaded),
      object("elsewhere/user-9", uploaded),
    ];

    const plan = planBackfill(
      objects,
      env,
      new Set(["user-1"]),
      new Set(["user-1", "user-2"]),
      now,
    );

    expect(
      plan.candidates.length +
        plan.skipped.length +
        plan.unparseableKeys.length,
    ).toBe(objects.length);
  });

  it("plans nothing from an empty bucket", () => {
    const plan = planBackfill([], env, new Set(), new Set(), now);

    expect(plan).toEqual({
      candidates: [],
      unparseableKeys: [],
      skipped: [],
    });
  });
});
