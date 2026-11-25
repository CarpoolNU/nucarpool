import { readableError } from "./readableError";

describe("readableError", () => {
  it("has nothing to say about a query that did not fail", () => {
    expect(readableError(undefined)).toBeNull();
  });

  it("passes through a message the service wrote for a person", () => {
    // The services write their refusals as sentences — see `ErrorNote` — and
    // replacing one with a generic apology would throw away the only part of
    // the failure that tells the reader what to do about it.
    expect(readableError("No such category: bogus")).toBe(
      "No such category: bogus",
    );
  });

  it("replaces the validator's issue list, which is written for a developer", () => {
    // What `posts.list` answers a pasted `?q=<101 chars>` with. tRPC puts the
    // serialized `ZodError` issues in `message`, and rendering that puts
    // `"code": "too_big"` and a JSON path on screen in a reading column.
    const dump = JSON.stringify([
      {
        origin: "string",
        code: "too_big",
        maximum: 100,
        inclusive: true,
        path: ["search"],
        message: "Too big: expected string to have <=100 characters",
      },
    ]);

    expect(readableError(dump)).toBe(
      "That link asked for something this page can't request.",
    );
  });

  it("leaves a sentence that merely begins with a bracket alone", () => {
    // The test that keeps the check from being `startsWith("[")`.
    expect(readableError("[Parking] posts are closed to new replies.")).toBe(
      "[Parking] posts are closed to new replies.",
    );
  });

  it("leaves a JSON array that is not a list of issues alone", () => {
    expect(readableError("[1, 2, 3]")).toBe("[1, 2, 3]");
  });
});
