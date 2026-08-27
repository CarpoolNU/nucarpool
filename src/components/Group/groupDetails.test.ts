import {
  DEFAULT_GROUP_DETAILS,
  GROUP_DETAILS_PREFIX,
  GroupDetails,
  NOTES_MAX_LENGTH,
  conversationStyleOptions,
  hasAnyDetail,
  musicPreferenceOptions,
  normalizeDetails,
  parseGroupDetails,
  resolveGroupDetails,
  trimDetails,
} from "./groupDetails";

const details = (overrides: Partial<GroupDetails> = {}): GroupDetails => ({
  ...DEFAULT_GROUP_DETAILS,
  ...overrides,
});

/**
 * Builds a legacy `GROUP_DETAILS_V1:` value.
 *
 * This used to be `serializeGroupDetails` in the module itself. Since SCRUM-253
 * nothing in production writes the encoding - the values live in real columns -
 * so the encoder belongs here, where it exists only to manufacture the un-
 * backfilled rows the read path still has to cope with.
 */
const encodeLegacy = (input: GroupDetails): string => {
  const normalized = normalizeDetails(input);

  if (!hasAnyDetail(normalized)) {
    return "";
  }

  return `${GROUP_DETAILS_PREFIX}${JSON.stringify(normalized)}`;
};

describe("parseGroupDetails — the un-backfilled read path", () => {
  it("returns the empty default for null, undefined and empty string", () => {
    expect(parseGroupDetails(null)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(parseGroupDetails(undefined)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(parseGroupDetails("")).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads back an encoded value", () => {
    const encoded = encodeLegacy(
      details({
        notes: "Meet at the north entrance",
        musicPreference: "Podcasts",
        conversationStyle: "Quiet",
      }),
    );

    expect(parseGroupDetails(encoded)).toEqual({
      notes: "Meet at the north entrance",
      musicPreference: "Podcasts",
      conversationStyle: "Quiet",
    });
  });

  it("treats a message written before the encoding existed as all note", () => {
    expect(parseGroupDetails("just text, no prefix")).toEqual(
      details({ notes: "just text, no prefix" }),
    );
  });

  it("fills missing keys rather than producing undefined fields", () => {
    const partial = `${GROUP_DETAILS_PREFIX}{"notes":"only notes"}`;

    expect(parseGroupDetails(partial)).toEqual(
      details({ notes: "only notes" }),
    );
  });

  it("ignores the retired rideVibe key that older rows still carry", () => {
    const legacy = `${GROUP_DETAILS_PREFIX}${JSON.stringify({
      notes: "n",
      musicPreference: "Rock",
      conversationStyle: "Quiet",
      rideVibe: "Chill",
    })}`;

    const parsed = parseGroupDetails(legacy);

    expect(parsed).toEqual({
      notes: "n",
      musicPreference: "Rock",
      conversationStyle: "Quiet",
    });
    expect(parsed).not.toHaveProperty("rideVibe");
  });

  it("surfaces a corrupt blob raw in the note", () => {
    const corrupt = `${GROUP_DETAILS_PREFIX}{not json`;

    expect(parseGroupDetails(corrupt)).toEqual(details({ notes: corrupt }));
  });

  it("clamps a corrupt blob to the column width so the driver can still save", () => {
    // Before SCRUM-253 this came back at full length, which would now exceed
    // `group_notes` and make every save fail on text the user never wrote.
    const corrupt = `${GROUP_DETAILS_PREFIX}{${"x".repeat(400)}`;

    expect(parseGroupDetails(corrupt).notes.length).toBe(NOTES_MAX_LENGTH);
  });

  it("clamps a long pre-encoding message, which lived in a TEXT column", () => {
    expect(parseGroupDetails("y".repeat(500)).notes).toBe(
      "y".repeat(NOTES_MAX_LENGTH),
    );
  });

  it("round-trips every fixed option through the legacy encoding", () => {
    for (const musicPreference of musicPreferenceOptions) {
      for (const conversationStyle of conversationStyleOptions) {
        const original = details({ musicPreference, conversationStyle });
        expect(parseGroupDetails(encodeLegacy(original))).toEqual(original);
      }
    }
  });
});

describe("resolveGroupDetails — the single read path", () => {
  it("returns the default when nothing is loaded", () => {
    expect(resolveGroupDetails(null)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(resolveGroupDetails(undefined)).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("prefers the real columns over the legacy blob", () => {
    const resolved = resolveGroupDetails({
      groupNotes: "from the column",
      groupMusicPreference: "Rock",
      groupConversationStyle: "Quiet",
      groupMessage: encodeLegacy(details({ notes: "from the blob" })),
    });

    expect(resolved).toEqual({
      notes: "from the column",
      musicPreference: "Rock",
      conversationStyle: "Quiet",
    });
  });

  it("falls back to the legacy blob while all three columns are null", () => {
    expect(
      resolveGroupDetails({
        groupNotes: null,
        groupMusicPreference: null,
        groupConversationStyle: null,
        groupMessage: encodeLegacy(
          details({ notes: "not backfilled yet", musicPreference: "Pop" }),
        ),
      }),
    ).toEqual({
      notes: "not backfilled yet",
      musicPreference: "Pop",
      conversationStyle: "",
    });
  });

  /**
   * The reason all-null has to mean "never saved" rather than "empty". If a
   * cleared form were stored as three nulls it would be indistinguishable from
   * an un-migrated row, and the next read would hand the driver back the very
   * blob they had just deleted.
   */
  it("does not resurrect the legacy blob after the form is deliberately cleared", () => {
    const resolved = resolveGroupDetails({
      groupNotes: "",
      groupMusicPreference: "",
      groupConversationStyle: "",
      groupMessage: encodeLegacy(details({ notes: "old note" })),
    });

    expect(resolved).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("counts a single non-null column as migrated", () => {
    // A driver who set only a music preference: the other two are "" from the
    // same save, but even one non-null value must stop the fallback.
    expect(
      resolveGroupDetails({
        groupNotes: "",
        groupMusicPreference: "Hip-hop",
        groupConversationStyle: "",
        groupMessage: encodeLegacy(details({ notes: "old note" })),
      }),
    ).toEqual({
      notes: "",
      musicPreference: "Hip-hop",
      conversationStyle: "",
    });
  });

  it("treats an unselected column as not-saved rather than as empty", () => {
    // `undefined`, not `null` - a caller that did not select the columns must
    // not be read as a row whose preferences are blank.
    expect(
      resolveGroupDetails({
        groupMessage: encodeLegacy(details({ notes: "still here" })),
      }),
    ).toEqual(details({ notes: "still here" }));
  });

  it("clamps column values, so a widened column cannot break the form", () => {
    expect(
      resolveGroupDetails({ groupNotes: "z".repeat(200) }).notes.length,
    ).toBe(NOTES_MAX_LENGTH);
  });
});

describe("trimDetails — the write path", () => {
  it("trims surrounding whitespace", () => {
    expect(trimDetails(details({ notes: "  hello  " })).notes).toBe("hello");
  });

  /**
   * The AC 5 distinction. `normalizeDetails` clamps because stored values have
   * to fit the form; `trimDetails` must not, so an over-length value reaches the
   * server and comes back as a visible error instead of being silently shortened
   * the way the old serialise path did.
   */
  it("does not shorten an over-length note", () => {
    const long = "x".repeat(NOTES_MAX_LENGTH + 25);

    expect(trimDetails(details({ notes: long })).notes).toBe(long);
    expect(normalizeDetails(details({ notes: long })).notes).toHaveLength(
      NOTES_MAX_LENGTH,
    );
  });
});

describe("normalizeDetails and hasAnyDetail", () => {
  it("trims whitespace-only values to empty", () => {
    expect(normalizeDetails(details({ notes: "   " })).notes).toBe("");
  });

  it("slices before trimming, so leading whitespace costs note budget", () => {
    // Surprising but pre-existing, and only reachable for stored values since
    // the textarea enforces maxLength on new input.
    expect(
      normalizeDetails(
        details({ notes: `  ${"x".repeat(NOTES_MAX_LENGTH + 25)}  ` }),
      ).notes,
    ).toBe("x".repeat(NOTES_MAX_LENGTH - 2));
  });

  it("treats whitespace-only input as no detail at all", () => {
    expect(hasAnyDetail(details({ notes: "  " }))).toBe(false);
  });
});
