import { findCandidates, parseArgs } from "./backfill-group-preferences";
import { GROUP_DETAILS_PREFIX } from "../src/components/Group/groupDetails";

/**
 * The property worth pinning hardest is that writing
 * needs `--apply`: everything else here is recoverable, a stray write to
 * production is not.
 */
describe("parseArgs", () => {
  it("does not write without --apply", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(["--max", "10"]).apply).toBe(false);
  });

  it("writes only for the exact --apply spelling", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(() => parseArgs(["--Apply"])).toThrow();
    expect(() => parseArgs(["-apply"])).toThrow();
    expect(() => parseArgs(["apply"])).toThrow();
    expect(() => parseArgs(["--apply=true"])).toThrow();
  });

  it("defaults --max and accepts an override", () => {
    expect(parseArgs([]).max).toBe(500);
    expect(parseArgs(["--max", "2000"]).max).toBe(2000);
  });

  it("rejects a --max that is not a positive integer", () => {
    expect(() => parseArgs(["--max", "0"])).toThrow();
    expect(() => parseArgs(["--max", "-5"])).toThrow();
    expect(() => parseArgs(["--max", "1.5"])).toThrow();
    expect(() => parseArgs(["--max", "lots"])).toThrow();
    expect(() => parseArgs(["--max"])).toThrow();
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--force"])).toThrow();
  });
});

describe("findCandidates", () => {
  const encoded = (details: Record<string, string>) =>
    `${GROUP_DETAILS_PREFIX}${JSON.stringify(details)}`;

  it("decodes an encoded blob into the three fields", () => {
    const candidates = findCandidates([
      {
        id: "s1",
        groupMessage: encoded({
          notes: "Side door",
          musicPreference: "Podcasts",
          conversationStyle: "Quiet",
        }),
      },
    ]);

    expect(candidates).toEqual([
      {
        id: "s1",
        details: {
          notes: "Side door",
          musicPreference: "Podcasts",
          conversationStyle: "Quiet",
        },
      },
    ]);
  });

  it("keeps a pre-encoding plain-text message as notes", () => {
    // AC 3: "plain-text legacy messages are preserved as notes".
    const candidates = findCandidates([
      { id: "s1", groupMessage: "See you at 8:45" },
    ]);

    expect(candidates[0].details).toEqual({
      notes: "See you at 8:45",
      musicPreference: "",
      conversationStyle: "",
    });
  });

  it("keeps a corrupt blob as notes rather than discarding it", () => {
    const candidates = findCandidates([
      { id: "s1", groupMessage: `${GROUP_DETAILS_PREFIX}{not json` },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].details.notes).toContain(GROUP_DETAILS_PREFIX);
  });

  it("skips rows that decode to nothing, rather than marking them migrated", () => {
    // Writing three empty strings would flip these rows to "migrated" for no
    // gain; left null they resolve identically through the fallback.
    expect(
      findCandidates([
        { id: "a", groupMessage: null },
        { id: "b", groupMessage: "" },
        { id: "c", groupMessage: "   " },
        { id: "d", groupMessage: encoded({ notes: "", musicPreference: "" }) },
      ]),
    ).toEqual([]);
  });

  it("drops the retired rideVibe key", () => {
    const candidates = findCandidates([
      {
        id: "s1",
        groupMessage: encoded({
          notes: "n",
          musicPreference: "Rock",
          conversationStyle: "Quiet",
          rideVibe: "Chill",
        }),
      },
    ]);

    expect(candidates[0].details).not.toHaveProperty("rideVibe");
  });

  it("processes a mixed batch, keeping only the rows worth writing", () => {
    const candidates = findCandidates([
      { id: "empty", groupMessage: "" },
      { id: "plain", groupMessage: "hello" },
      { id: "null", groupMessage: null },
      { id: "encoded", groupMessage: encoded({ musicPreference: "Pop" }) },
    ]);

    expect(candidates.map((c) => c.id)).toEqual(["plain", "encoded"]);
  });
});
