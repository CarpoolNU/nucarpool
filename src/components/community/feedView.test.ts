import { feedHref, readFeedView, searchSubmitHref } from "./feedView";

describe("readFeedView", () => {
  it("defaults to the newest-first feed with no category", () => {
    expect(readFeedView({})).toEqual({ sort: "new" });
  });

  it("reads a category and a sort out of the query", () => {
    expect(readFeedView({ category: "parking", sort: "top" })).toEqual({
      categorySlug: "parking",
      sort: "top",
    });
  });

  it("takes the first value when Next repeats a parameter", () => {
    // `?category=a&category=b` arrives as an array, which would otherwise be
    // passed to the router as one and rejected by the Zod string.
    expect(
      readFeedView({ category: ["parking", "commuting"], sort: ["top"] }),
    ).toEqual({
      categorySlug: "parking",
      sort: "top",
    });
  });

  it.each([["hot"], [""], ["TOP"], ["new"]])(
    "falls back to newest-first for the unrecognized sort %p",
    (sort) => {
      expect(readFeedView({ sort }).sort).toBe("new");
    },
  );

  it("ignores an empty category rather than filtering on nothing", () => {
    expect(readFeedView({ category: "" }).categorySlug).toBeUndefined();
  });

  it("reads a search term out of the query", () => {
    expect(readFeedView({ q: "garage rates" })).toEqual({
      term: "garage rates",
      sort: "new",
    });
  });

  it("ignores an all-whitespace term rather than searching for nothing", () => {
    // The server reads it the same way; agreeing here keeps the page from
    // rendering "no results for ' '" over a feed that has plenty.
    expect(readFeedView({ q: "   " }).term).toBeUndefined();
  });

  it("reads a term alongside a category and a sort", () => {
    expect(
      readFeedView({ q: "garage", category: "parking", sort: "top" }),
    ).toEqual({
      term: "garage",
      categorySlug: "parking",
      sort: "top",
    });
  });
});

describe("feedHref", () => {
  it.each([
    [{ sort: "new" as const }, "/community"],
    [{ sort: "top" as const }, "/community?sort=top"],
    [
      { categorySlug: "parking", sort: "new" as const },
      "/community?category=parking",
    ],
    [
      { categorySlug: "parking", sort: "top" as const },
      "/community?category=parking&sort=top",
    ],
  ])("links %p to %s", (view, expected) => {
    expect(feedHref(view)).toBe(expected);
  });

  it.each([
    [{ term: "garage", sort: "new" as const }, "/community/search?q=garage"],
    [
      { term: "garage", sort: "top" as const },
      "/community/search?q=garage&sort=top",
    ],
    [
      { term: "garage", categorySlug: "parking", sort: "new" as const },
      "/community/search?q=garage&category=parking",
    ],
  ])(
    "sends the view with a term %p to the search route: %s",
    (view, expected) => {
      // A term changes which page the view lives on, which is why one function
      // owns both routes: a chip on the search page must keep the term, and a
      // chip on the feed must not invent one.
      expect(feedHref(view)).toBe(expected);
    },
  );

  it("escapes a term rather than pasting it into the query", () => {
    expect(feedHref({ term: "a&b=c", sort: "new" })).toBe(
      "/community/search?q=a%26b%3Dc",
    );
  });

  it("escapes a category slug rather than pasting it into the query", () => {
    expect(feedHref({ categorySlug: "a&b=c", sort: "top" })).toBe(
      "/community?category=a%26b%3Dc&sort=top",
    );
  });

  it.each([
    [{ sort: "new" as const }],
    [{ sort: "top" as const }],
    [{ categorySlug: "commuting", sort: "top" as const }],
    [{ term: "garage rates", sort: "new" as const }],
    [{ term: "garage", categorySlug: "commuting", sort: "top" as const }],
  ])("round-trips %p through the URL", (view) => {
    const query = feedHref(view).split("?")[1] ?? "";
    const parsed = Object.fromEntries(new URLSearchParams(query));
    expect(readFeedView(parsed)).toEqual(view);
  });
});

describe("searchSubmitHref", () => {
  it("sends a typed term to the search route", () => {
    expect(searchSubmitHref("garage rates")).toBe(
      "/community/search?q=garage+rates",
    );
  });

  it("trims what was typed", () => {
    expect(searchSubmitHref("  garage  ")).toBe("/community/search?q=garage");
  });

  it("returns to the unfiltered feed when the box is submitted empty", () => {
    // Clearing the box and pressing Enter is how someone leaves a search, so
    // it has to lead somewhere rather than re-running a search for nothing.
    expect(searchSubmitHref("")).toBe("/community");
    expect(searchSubmitHref("   ")).toBe("/community");
  });

  it("searches every category, whatever the reader was browsing", () => {
    // Deliberately not a narrowing of the current view: the complaint this
    // feature answers is that an existing answer could not be found, and
    // silently scoping a new search to one category is a way to not find it.
    // The chips on the results page are how a reader narrows afterwards.
    expect(searchSubmitHref("garage")).toBe("/community/search?q=garage");
  });
});
