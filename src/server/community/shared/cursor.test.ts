import { decodeCursor, encodeCursor } from "./cursor";

describe("cursor: the newest-first shape", () => {
  const cursor = {
    sort: "new" as const,
    dateCreated: new Date("2026-10-09T12:00:00.000Z"),
    id: "abc123",
  };

  it("round-trips a cursor", () => {
    const decoded = decodeCursor(encodeCursor(cursor), "new");
    expect(decoded?.id).toBe("abc123");
    expect(decoded?.dateCreated.toISOString()).toBe("2026-10-09T12:00:00.000Z");
  });

  it("preserves millisecond precision, which the id tiebreak depends on", () => {
    const precise = {
      ...cursor,
      dateCreated: new Date("2026-10-09T12:00:00.123Z"),
    };
    expect(
      decodeCursor(encodeCursor(precise), "new")?.dateCreated.getTime(),
    ).toBe(precise.dateCreated.getTime());
  });

  it("round-trips an id containing the separator", () => {
    // ids are cuids today and contain no separator, but the decoder splits off
    // only the leading fields precisely so this stays true if that changes.
    const odd = { ...cursor, id: "a|b|c" };
    expect(decodeCursor(encodeCursor(odd), "new")?.id).toBe("a|b|c");
  });

  it.each([
    ["not base64 at all", "!!!!"],
    ["empty", ""],
    ["base64 of nonsense", Buffer.from("nonsense").toString("base64url")],
    [
      "an untagged cursor from an older build",
      Buffer.from("2026-10-09T12:00:00.000Z|abc").toString("base64url"),
    ],
    [
      "missing id",
      Buffer.from("new|2026-10-09T12:00:00.000Z|").toString("base64url"),
    ],
    ["unparseable date", Buffer.from("new|never|abc").toString("base64url")],
  ])("returns null rather than throwing for %s", (_label, input) => {
    expect(decodeCursor(input, "new")).toBeNull();
  });
});

describe("cursor: the Top shape", () => {
  const cursor = { sort: "top" as const, voteCount: 42, id: "abc123" };

  it("round-trips a vote count and its id tiebreak", () => {
    const decoded = decodeCursor(encodeCursor(cursor), "top");
    expect(decoded).toEqual(cursor);
  });

  it("round-trips a zero count, which is where a Top feed ends", () => {
    expect(
      decodeCursor(encodeCursor({ ...cursor, voteCount: 0 }), "top")?.voteCount,
    ).toBe(0);
  });

  it("round-trips an id containing the separator", () => {
    expect(
      decodeCursor(encodeCursor({ ...cursor, id: "a|b|c" }), "top")?.id,
    ).toBe("a|b|c");
  });

  it.each([
    ["a non-numeric count", Buffer.from("top|lots|abc").toString("base64url")],
    ["a fractional count", Buffer.from("top|1.5|abc").toString("base64url")],
    ["a negative count", Buffer.from("top|-1|abc").toString("base64url")],
    ["an empty count", Buffer.from("top||abc").toString("base64url")],
    ["missing id", Buffer.from("top|3|").toString("base64url")],
  ])("returns null rather than throwing for %s", (_label, input) => {
    expect(decodeCursor(input, "top")).toBeNull();
  });
});

describe("cursor: cross-sort replay", () => {
  // A Top cursor read as a New one would reinterpret a vote count as a
  // timestamp, and a New cursor read as a Top one would reinterpret a date as
  // a count. Both produce a plausible-looking page of the wrong rows, which is
  // worse than restarting the feed.
  const dated = {
    sort: "new" as const,
    dateCreated: new Date("2026-10-09T12:00:00.000Z"),
    id: "abc123",
  };
  const voted = { sort: "top" as const, voteCount: 42, id: "abc123" };

  it("refuses a Top cursor replayed under New", () => {
    expect(decodeCursor(encodeCursor(voted), "new")).toBeNull();
  });

  it("refuses a New cursor replayed under Top", () => {
    expect(decodeCursor(encodeCursor(dated), "top")).toBeNull();
  });

  it("refuses a tag that names no sort at all", () => {
    expect(
      decodeCursor(Buffer.from("hot|3|abc").toString("base64url"), "top"),
    ).toBeNull();
  });
});
