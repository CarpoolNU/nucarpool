import {
  DEFAULT_GROUP_DETAILS,
  GroupDetails,
  NOTES_MAX_LENGTH,
  detailsEqual,
  hasAnyDetail,
  resolveGroupDetails,
  trimDetails,
} from "./groupDetails";

const details = (overrides: Partial<GroupDetails> = {}): GroupDetails => ({
  ...DEFAULT_GROUP_DETAILS,
  ...overrides,
});

describe("resolveGroupDetails — the single read path", () => {
  it("returns the default when nothing is loaded", () => {
    expect(resolveGroupDetails(null)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(resolveGroupDetails(undefined)).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads the three columns", () => {
    expect(
      resolveGroupDetails({
        groupNotes: "from the column",
        groupMusicPreference: "Rock",
        groupConversationStyle: "Quiet",
      }),
    ).toEqual({
      notes: "from the column",
      musicPreference: "Rock",
      conversationStyle: "Quiet",
    });
  });

  it("reads a null column as empty", () => {
    expect(
      resolveGroupDetails({
        groupNotes: null,
        groupMusicPreference: null,
        groupConversationStyle: null,
      }),
    ).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads an unselected column as empty", () => {
    // `undefined` rather than `null`, from a caller that did not select them.
    // Before SCRUM-287 this was the case that chose the legacy fallback, so it
    // had to be told apart from a blank row; now both are simply empty.
    expect(resolveGroupDetails({})).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads a deliberately cleared form as empty", () => {
    expect(
      resolveGroupDetails({
        groupNotes: "",
        groupMusicPreference: "",
        groupConversationStyle: "",
      }),
    ).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads one set column alongside two blank ones", () => {
    expect(
      resolveGroupDetails({
        groupNotes: "",
        groupMusicPreference: "Hip-hop",
        groupConversationStyle: "",
      }),
    ).toEqual(details({ musicPreference: "Hip-hop" }));
  });

  it("trims stored whitespace", () => {
    expect(resolveGroupDetails({ groupNotes: "  spaced  " }).notes).toBe(
      "spaced",
    );
  });

  /**
   * The read path used to clamp to the column width, because a corrupt
   * `GROUP_DETAILS_V1:` blob could surface as note text far longer than
   * `group_notes` accepts. With the legacy column dropped there is no such
   * source, and clamping was worse than redundant: `textLimits.ts` counts UTF-16
   * code units while MySQL counts characters, so a column-legal note of emoji
   * has a JS `length` above the limit and a `slice` on read would have truncated
   * a value the database stored happily.
   */
  it("does not clamp a stored value to the column width", () => {
    const long = "z".repeat(NOTES_MAX_LENGTH + 110);

    expect(resolveGroupDetails({ groupNotes: long }).notes).toBe(long);
  });

  it("returns a 90-character note of emoji whole", () => {
    // 90 astral characters: legal in `VARCHAR(90)`, JS `length` 180.
    const emoji = "🚗".repeat(NOTES_MAX_LENGTH);

    expect(resolveGroupDetails({ groupNotes: emoji }).notes).toBe(emoji);
  });
});

describe("trimDetails", () => {
  it("trims surrounding whitespace", () => {
    expect(trimDetails(details({ notes: "  hello  " })).notes).toBe("hello");
  });

  it("trims whitespace-only values to empty", () => {
    expect(trimDetails(details({ notes: "   " })).notes).toBe("");
  });

  /**
   * Deliberate, and now the only behaviour: an over-length value reaches the
   * server and comes back as a visible error rather than being silently
   * shortened the way the old serialise path did.
   */
  it("does not shorten an over-length note", () => {
    const long = "x".repeat(NOTES_MAX_LENGTH + 25);

    expect(trimDetails(details({ notes: long })).notes).toBe(long);
  });
});

describe("hasAnyDetail", () => {
  it("treats whitespace-only input as no detail at all", () => {
    expect(hasAnyDetail(details({ notes: "  " }))).toBe(false);
  });

  it("is true when any one field carries a value", () => {
    expect(hasAnyDetail(details({ musicPreference: "Pop" }))).toBe(true);
  });
});

/**
 * The comparison `useGroupDetails`'s sync effect bails out on.
 *
 * Its job is narrow: answer whether two `GroupDetails` carry the same values,
 * so that resolving the same stored row twice is not a state change. The
 * interesting cases are the ones where being wrong is invisible - a difference
 * in exactly one field, which a comparison that forgot that field would report
 * as equal, and which would then never reach the form.
 */
describe("detailsEqual", () => {
  const full: GroupDetails = {
    notes: "Leaves from Ruggles at 7:45",
    musicPreference: "Podcasts",
    conversationStyle: "Light chat",
  };

  it("is true for two separately built objects with the same values", () => {
    // The whole point: `===` on the objects is false here, and this must not
    // be. `resolveGroupDetails` returns a fresh object every call.
    expect({ ...full }).not.toBe(full);
    expect(detailsEqual({ ...full }, full)).toBe(true);
  });

  it("is true for the same reference", () => {
    expect(detailsEqual(full, full)).toBe(true);
  });

  it("is true for two empty defaults", () => {
    expect(detailsEqual(details(), DEFAULT_GROUP_DETAILS)).toBe(true);
  });

  it.each(Object.keys(full) as (keyof GroupDetails)[])(
    "is false when only %s differs",
    (field) => {
      expect(detailsEqual(full, { ...full, [field]: "something else" })).toBe(
        false,
      );
    },
  );

  it("is false when a field is cleared rather than changed", () => {
    // Clearing the notes is a real edit and must sync. An `||`-style
    // comparison that treated "" as "no value" would miss it.
    expect(detailsEqual(full, { ...full, notes: "" })).toBe(false);
  });

  it("does not trim or normalise before comparing", () => {
    // Deliberate. `resolveGroupDetails` has already normalised both sides by
    // the time the effect compares them, so trimming here would only hide a
    // difference between a normalised value and an un-normalised one - which
    // is a bug worth seeing rather than smoothing over.
    expect(detailsEqual(full, { ...full, notes: `${full.notes} ` })).toBe(
      false,
    );
  });

  it("compares every field of GroupDetails, not a subset", () => {
    // The guard against the quiet version of that loop: a field left out of
    // the comparison is a field whose changes never reach the form.
    // `COMPARED_FIELDS` is `Record<keyof GroupDetails, true>` so omitting one
    // fails `tsc`, and this asserts the runtime half of the same thing.
    const fields = Object.keys(DEFAULT_GROUP_DETAILS) as (keyof GroupDetails)[];

    for (const field of fields) {
      expect(detailsEqual(full, { ...full, [field]: "changed" })).toBe(false);
    }
    expect(fields).toHaveLength(3);
  });
});
