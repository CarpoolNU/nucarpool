import { memberSinceLabel, profileHref, readHandleParam } from "./profileView";

describe("profileHref", () => {
  it("links a handle to its profile", () => {
    expect(profileHref("Avery")).toBe("/community/u/Avery");
  });

  it("preserves the casing the author chose", () => {
    // The display handle is what is shown everywhere else, and the server
    // normalizes on lookup — so the link carries the author's own spelling
    // rather than a lowercased one nobody typed.
    expect(profileHref("HuskyCommuter")).toBe("/community/u/HuskyCommuter");
  });

  it("escapes a handle rather than pasting it into the path", () => {
    // Unreachable through a claimed handle, which is `[A-Za-z0-9_]` only. It
    // is escaped anyway because this function takes a string from a payload,
    // and "the data is always clean" is the assumption that stops being true
    // exactly once.
    expect(profileHref("a/../b?c")).toBe("/community/u/a%2F..%2Fb%3Fc");
  });
});

describe("readHandleParam", () => {
  it("reads the handle out of the route", () => {
    expect(readHandleParam({ handle: "Avery" })).toBe("Avery");
  });

  it("takes the first value when Next repeats the parameter", () => {
    expect(readHandleParam({ handle: ["Avery", "Parker"] })).toBe("Avery");
  });

  it.each([
    ["an absent parameter", undefined],
    ["an empty one", ""],
    ["an empty array", [] as string[]],
  ])("returns undefined for %s", (_label, handle) => {
    // Undefined is what the page waits on: on the first render Next has not
    // populated the route yet, so a query fired with `""` would ask the server
    // about a handle nobody typed and get a refusal the reader would see.
    expect(readHandleParam({ handle })).toBeUndefined();
  });
});

describe("memberSinceLabel", () => {
  it("reads a join month as a month and a year", () => {
    expect(memberSinceLabel("2026-10")).toBe("October 2026");
  });

  it("names every month", () => {
    expect(memberSinceLabel("2026-01")).toBe("January 2026");
    expect(memberSinceLabel("2026-12")).toBe("December 2026");
  });

  it("returns the raw value when it is not a month this understands", () => {
    // The server sends `YYYY-MM` and nothing else, so this is unreachable —
    // but a header that rendered "undefined 2026" would be worse than one
    // that renders what it was given.
    expect(memberSinceLabel("whenever")).toBe("whenever");
    expect(memberSinceLabel("2026-13")).toBe("2026-13");
  });
});
