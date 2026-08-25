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
  serializeGroupDetails,
} from "./groupDetails";

const details = (overrides: Partial<GroupDetails> = {}): GroupDetails => ({
  ...DEFAULT_GROUP_DETAILS,
  ...overrides,
});

describe("parseGroupDetails", () => {
  it("returns the empty default for null, undefined and empty string", () => {
    expect(parseGroupDetails(null)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(parseGroupDetails(undefined)).toEqual(DEFAULT_GROUP_DETAILS);
    expect(parseGroupDetails("")).toEqual(DEFAULT_GROUP_DETAILS);
  });

  it("reads back an encoded value", () => {
    const encoded = serializeGroupDetails(
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
    // Re-saving drops it from storage, so a row heals itself on the next write.
    expect(serializeGroupDetails(parsed)).not.toContain("rideVibe");
  });

  it("surfaces a corrupt blob raw in the note, unchanged from before the refactor", () => {
    const corrupt = `${GROUP_DETAILS_PREFIX}{not json`;

    expect(parseGroupDetails(corrupt)).toEqual(details({ notes: corrupt }));
  });
});

describe("serializeGroupDetails", () => {
  it("stores an empty string when nothing is set, so the preview shows its empty state", () => {
    expect(serializeGroupDetails(DEFAULT_GROUP_DETAILS)).toBe("");
    expect(serializeGroupDetails(details({ notes: "   " }))).toBe("");
  });

  it("prefixes the JSON so a plain-text row is distinguishable", () => {
    const encoded = serializeGroupDetails(details({ notes: "hi" }));

    expect(encoded.startsWith(GROUP_DETAILS_PREFIX)).toBe(true);
    expect(JSON.parse(encoded.slice(GROUP_DETAILS_PREFIX.length))).toEqual({
      notes: "hi",
      musicPreference: "",
      conversationStyle: "",
    });
  });

  it("round-trips every fixed option", () => {
    for (const musicPreference of musicPreferenceOptions) {
      for (const conversationStyle of conversationStyleOptions) {
        const original = details({ musicPreference, conversationStyle });
        expect(parseGroupDetails(serializeGroupDetails(original))).toEqual(
          original,
        );
      }
    }
  });

  it("truncates an over-long note to the maximum", () => {
    const encoded = serializeGroupDetails(
      details({ notes: "x".repeat(NOTES_MAX_LENGTH + 25) }),
    );

    expect(parseGroupDetails(encoded).notes).toBe("x".repeat(NOTES_MAX_LENGTH));
  });

  it("slices before trimming, so leading whitespace costs note budget", () => {
    // Pre-existing behaviour of normalizeDetails, kept as-is by SCRUM-252 and
    // pinned here because it is surprising: the slice happens first, so two
    // leading spaces mean two fewer characters survive rather than the full
    // NOTES_MAX_LENGTH. Only reachable for stored values, since the textarea
    // enforces maxLength on new input.
    const encoded = serializeGroupDetails(
      details({ notes: `  ${"x".repeat(NOTES_MAX_LENGTH + 25)}  ` }),
    );

    expect(parseGroupDetails(encoded).notes).toBe(
      "x".repeat(NOTES_MAX_LENGTH - 2),
    );
  });

  /**
   * `group.message` is VARCHAR(191) and this blob is written to it verbatim.
   * The encoding overhead plus a full-length note leaves no headroom, so a note
   * containing characters JSON must escape pushes the value over the column
   * width and the write throws. Fixing that is SCRUM-253; this test exists so
   * the margin cannot quietly shrink further in the meantime.
   */
  it("fits VARCHAR(191) for a full-length plain note but not an escaped one", () => {
    const worstOptions = {
      musicPreference: "No preference",
      conversationStyle: "Depends on mood",
    };

    const plain = serializeGroupDetails(
      details({ notes: "x".repeat(NOTES_MAX_LENGTH), ...worstOptions }),
    );
    expect(plain.length).toBeLessThanOrEqual(191);

    const escaped = serializeGroupDetails(
      details({ notes: '"'.repeat(NOTES_MAX_LENGTH), ...worstOptions }),
    );
    expect(escaped.length).toBeGreaterThan(191);
  });
});

describe("normalizeDetails and hasAnyDetail", () => {
  it("trims whitespace-only values to empty", () => {
    expect(normalizeDetails(details({ notes: "   " })).notes).toBe("");
  });

  it("treats whitespace-only input as no detail at all", () => {
    expect(hasAnyDetail(details({ notes: "  " }))).toBe(false);
    expect(hasAnyDetail(details({ notes: "a" }))).toBe(true);
    expect(hasAnyDetail(details({ musicPreference: "Rock" }))).toBe(true);
    expect(hasAnyDetail(DEFAULT_GROUP_DETAILS)).toBe(false);
  });
});
