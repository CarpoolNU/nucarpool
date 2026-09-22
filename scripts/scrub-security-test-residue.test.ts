import {
  SCRUBBED_COLUMNS,
  SCRUB_VALUE,
  TARGET_USER_ID,
  buildUpdateData,
  parseArgs,
  pendingFields,
  planScrub,
  recheckFields,
  verifyScrubbed,
  type SearchRow,
  type UserRow,
} from "./scrub-security-test-residue";

/**
 * This script overwrites five columns on one named production account, so the
 * properties worth pinning are the ones that stop it writing to anything else:
 * writing is opt-in twice over, every refusal is a refusal rather than a
 * guess, and the set of columns it can reach is closed.
 *
 * The same split as the sibling repair scripts — the pure halves are exported
 * and tested here, and importing the module is safe because it only calls
 * `main()` when run directly. **A passing suite here says nothing about what
 * the script would do to a real database.**
 */

const SEARCH_ID = "cmsearch0000000000000000";

const user = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: TARGET_USER_ID,
  bio: "<script>alert(1)</script>",
  pronouns: "they/them",
  preferredName: "Sam",
  ...overrides,
});

const search = (overrides: Partial<SearchRow> = {}): SearchRow => ({
  id: SEARCH_ID,
  companyName: "Acme",
  groupNotes: "Meet by the side door",
  ...overrides,
});

describe("scrub-security-test-residue argument parsing", () => {
  it("defaults to a dry run with no search confirmation", () => {
    expect(parseArgs([])).toEqual({ apply: false, searchId: null });
  });

  it("refuses to write without the search id typed at the call site", () => {
    // --apply alone is the single most likely way to reach an unintended
    // write, so it is an error rather than a prompt.
    expect(() => parseArgs(["--apply"])).toThrow(/--apply requires --search/);
  });

  it("writes only when --apply and --search are given together", () => {
    expect(parseArgs(["--apply", "--search", SEARCH_ID])).toEqual({
      apply: true,
      searchId: SEARCH_ID,
    });
  });

  it("lets the more cautious of two conflicting flags win", () => {
    expect(parseArgs(["--apply", "--dry-run"])).toEqual({
      apply: false,
      searchId: null,
    });
  });

  it("accepts a search id on a dry run, so the match can be checked first", () => {
    expect(parseArgs(["--search", SEARCH_ID])).toEqual({
      apply: false,
      searchId: SEARCH_ID,
    });
  });

  it("rejects --search with no value", () => {
    expect(() => parseArgs(["--search"])).toThrow(/--search expects an id/);
  });

  it("rejects a --search value that is really the next flag", () => {
    // `--apply --search --dry-run` must not read "--dry-run" as an id and
    // then silently proceed as a write.
    expect(() => parseArgs(["--search", "--dry-run"])).toThrow(
      /--search expects an id/,
    );
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--user", "someone-else"])).toThrow(
      /unknown argument/,
    );
  });
});

describe("SCRUBBED_COLUMNS", () => {
  it("is exactly the five confirmed columns and nothing else", () => {
    // The closed list is the whole safety story for scope: nothing outside it
    // can reach an update, because the update data is built from it.
    expect(
      SCRUBBED_COLUMNS.map((column) => `${column.table}.${column.column}`),
    ).toEqual([
      "user.bio",
      "user.pronouns",
      "user.preferredName",
      "carpool_search.company_name",
      "carpool_search.group_notes",
    ]);
  });
});

describe("planScrub", () => {
  it("plans all five columns with the values it would overwrite", () => {
    const plan = planScrub(user(), [search()], null);

    expect(plan).toMatchObject({ ok: true, searchId: SEARCH_ID });
    if (!plan.ok) throw new Error("expected a plan");

    expect(plan.fields.map((field) => [field.field, field.before])).toEqual([
      ["bio", "<script>alert(1)</script>"],
      ["pronouns", "they/them"],
      ["preferredName", "Sam"],
      ["companyName", "Acme"],
      ["groupNotes", "Meet by the side door"],
    ]);
  });

  it("refuses when the target user row is gone", () => {
    expect(planScrub(null, [search()], null)).toEqual({
      ok: false,
      reason: `user ${TARGET_USER_ID} was not found`,
    });
  });

  it("refuses a user row that is not the target", () => {
    const plan = planScrub(
      user({ id: "cmsomeoneelse0000000000" }),
      [search()],
      null,
    );

    expect(plan).toEqual({
      ok: false,
      reason:
        `the user row read back is cmsomeoneelse0000000000, not ` +
        `${TARGET_USER_ID}`,
    });
  });

  it("refuses when the user has no carpool search", () => {
    expect(planScrub(user(), [], null)).toEqual({
      ok: false,
      reason: `user ${TARGET_USER_ID} has no carpool_search row`,
    });
  });

  it("refuses when the user has more than one carpool search", () => {
    // The code assumes one search per user; the schema permits many. An
    // ambiguous target is a refusal, never a pick.
    expect(
      planScrub(
        user(),
        [search(), search({ id: "cmsecond000000000000000" })],
        null,
      ),
    ).toEqual({
      ok: false,
      reason:
        `user ${TARGET_USER_ID} has 2 carpool_search rows, expected exactly ` +
        `one`,
    });
  });

  it("refuses when the confirmed search id is not the row it read", () => {
    expect(planScrub(user(), [search()], "cmtypo00000000000000000")).toEqual({
      ok: false,
      reason:
        `--search cmtypo00000000000000000 does not match this user's ` +
        `carpool_search row ${SEARCH_ID}`,
    });
  });

  it("accepts a confirmed search id that matches", () => {
    expect(planScrub(user(), [search()], SEARCH_ID)).toMatchObject({
      ok: true,
      searchId: SEARCH_ID,
    });
  });
});

describe("pendingFields", () => {
  it("leaves out columns that are already empty, so a re-run is a no-op", () => {
    const plan = planScrub(
      user({ pronouns: "", preferredName: "" }),
      [search({ groupNotes: null })],
      null,
    );
    if (!plan.ok) throw new Error("expected a plan");

    expect(pendingFields(plan.fields).map((field) => field.field)).toEqual([
      "bio",
      "companyName",
    ]);
  });

  it("returns nothing once every column is clear", () => {
    const plan = planScrub(
      user({ bio: "", pronouns: "", preferredName: "" }),
      [search({ companyName: "", groupNotes: "" })],
      null,
    );
    if (!plan.ok) throw new Error("expected a plan");

    expect(pendingFields(plan.fields)).toEqual([]);
  });

  it("treats a whitespace-only value as content, not as empty", () => {
    // Someone typed those spaces. Clearing them is still the right outcome,
    // but they are a value to report and overwrite rather than skip silently.
    const plan = planScrub(user({ bio: "   " }), [search()], null);
    if (!plan.ok) throw new Error("expected a plan");

    expect(pendingFields(plan.fields).map((field) => field.field)).toContain(
      "bio",
    );
  });
});

describe("buildUpdateData", () => {
  it("writes the empty string to exactly the fields it is given", () => {
    const plan = planScrub(user(), [search()], null);
    if (!plan.ok) throw new Error("expected a plan");

    const userFields = plan.fields.filter((field) => field.table === "user");

    expect(buildUpdateData(userFields)).toEqual({
      bio: SCRUB_VALUE,
      pronouns: SCRUB_VALUE,
      preferredName: SCRUB_VALUE,
    });
  });

  it("clears the nullable column to the same empty string the app writes", () => {
    // groups.updatePreferences writes "" when a driver clears their notes, so
    // "" is byte-identical to the owner clearing the field themselves.
    const plan = planScrub(user(), [search()], null);
    if (!plan.ok) throw new Error("expected a plan");

    expect(
      buildUpdateData(
        plan.fields.filter((field) => field.field === "groupNotes"),
      ),
    ).toEqual({ groupNotes: "" });
  });

  it("produces no update at all for an empty field list", () => {
    expect(buildUpdateData([])).toEqual({});
  });
});

describe("recheckFields", () => {
  const planned = () => {
    const plan = planScrub(user(), [search()], null);
    if (!plan.ok) throw new Error("expected a plan");
    return plan.fields.filter((field) => field.table === "user");
  };

  it("writes the fields that are unchanged since the plan was built", () => {
    const result = recheckFields(planned(), user());

    expect(result.writes.map((field) => field.field)).toEqual([
      "bio",
      "pronouns",
      "preferredName",
    ]);
    expect(result.skips).toEqual([]);
  });

  it("skips a field the owner edited between the plan and the write", () => {
    // Overwriting text somebody typed in the meantime is the one way this
    // script could destroy something real.
    const result = recheckFields(planned(), user({ bio: "my actual bio" }));

    expect(result.writes.map((field) => field.field)).toEqual([
      "pronouns",
      "preferredName",
    ]);
    expect(result.skips).toEqual([
      { field: "bio", reason: "the value changed since the plan was built" },
    ]);
  });

  it("skips a field the owner cleared themselves in the meantime", () => {
    const result = recheckFields(planned(), user({ pronouns: "" }));

    expect(result.writes.map((field) => field.field)).toEqual([
      "bio",
      "preferredName",
    ]);
    expect(result.skips).toEqual([
      {
        field: "pronouns",
        reason: "the value changed since the plan was built",
      },
    ]);
  });

  it("writes nothing when the row has disappeared", () => {
    const result = recheckFields(planned(), null);

    expect(result.writes).toEqual([]);
    expect(result.skips).toEqual([
      { field: "bio", reason: "the row no longer exists" },
      { field: "pronouns", reason: "the row no longer exists" },
      { field: "preferredName", reason: "the row no longer exists" },
    ]);
  });
});

describe("verifyScrubbed", () => {
  const cleared = {
    user: user({ bio: "", pronouns: "", preferredName: "" }),
    search: search({ companyName: "", groupNotes: "" }),
  };

  it("reports every column clear once all five are empty", () => {
    const verification = verifyScrubbed(cleared.user, cleared.search);

    expect(verification.allClear).toBe(true);
    expect(verification.results).toHaveLength(5);
    expect(verification.results.every((result) => result.clear)).toBe(true);
  });

  it("accepts null as clear for the nullable column", () => {
    const verification = verifyScrubbed(
      cleared.user,
      search({ companyName: "", groupNotes: null }),
    );

    expect(verification.allClear).toBe(true);
  });

  it("fails and names the column when a value survived the write", () => {
    const verification = verifyScrubbed(
      cleared.user,
      search({ companyName: "", groupNotes: "still here" }),
    );

    expect(verification.allClear).toBe(false);
    expect(
      verification.results
        .filter((result) => !result.clear)
        .map((result) => result.column),
    ).toEqual(["carpool_search.group_notes"]);
  });

  it("fails when a whitespace-only remnant is left behind", () => {
    const verification = verifyScrubbed(
      user({ bio: " ", pronouns: "", preferredName: "" }),
      cleared.search,
    );

    expect(verification.allClear).toBe(false);
  });

  it("fails rather than passing vacuously when a row cannot be read back", () => {
    // A missing row must never read as "nothing left to find".
    expect(verifyScrubbed(null, cleared.search).allClear).toBe(false);
    expect(verifyScrubbed(cleared.user, null).allClear).toBe(false);
  });
});
