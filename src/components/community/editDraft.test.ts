import { editDraftState, type DraftField } from "./editDraft";

const field = (value: string, original: string, max = 150): DraftField => ({
  value,
  original,
  max,
});

describe("editDraftState", () => {
  it("accepts a draft that changed and fits", () => {
    const state = editDraftState([field("New title", "Old title")]);

    expect(state).toEqual({ canSubmit: true, blockedBy: null });
  });

  it("refuses a draft nobody has changed", () => {
    const state = editDraftState([field("Same", "Same")]);

    expect(state).toEqual({ canSubmit: false, blockedBy: "unchanged" });
  });

  /**
   * The server trims before it stores, so whitespace either side is not a
   * change it would record — it would spend a `CONTENT_EDIT` charge and set
   * `editedAt` to write the identical row.
   */
  it("treats a whitespace-only difference as unchanged", () => {
    const state = editDraftState([field("  Same  ", "Same")]);

    expect(state.blockedBy).toBe("unchanged");
  });

  it("refuses a field emptied out", () => {
    const state = editDraftState([field("   ", "Old title")]);

    expect(state).toEqual({ canSubmit: false, blockedBy: "empty" });
  });

  it("refuses a field over its column width", () => {
    const state = editDraftState([field("x".repeat(151), "Old title", 150)]);

    expect(state).toEqual({ canSubmit: false, blockedBy: "too-long" });
  });

  it("measures the trimmed value against the maximum, as the server does", () => {
    const state = editDraftState([
      field(`  ${"x".repeat(150)}  `, "Old title", 150),
    ]);

    expect(state.canSubmit).toBe(true);
  });

  it("is submittable when any one of several fields changed", () => {
    const state = editDraftState([
      field("Same title", "Same title"),
      field("New body", "Old body", 5000),
    ]);

    expect(state.canSubmit).toBe(true);
  });

  it("is unchanged only when every field is", () => {
    const state = editDraftState([
      field("Same title", "Same title"),
      field("Same body", "Same body", 5000),
    ]);

    expect(state.blockedBy).toBe("unchanged");
  });

  /**
   * Emptiness is reported ahead of length, and the order is pinned rather than
   * incidental: a person who has cleared one field and overrun another is told
   * about the empty one, which is the fault they are one keystroke from having
   * caused.
   */
  it("reports an empty field ahead of an over-long one", () => {
    const state = editDraftState([
      field("", "Old title"),
      field("x".repeat(5001), "Old body", 5000),
    ]);

    expect(state.blockedBy).toBe("empty");
  });

  it("reports a length fault ahead of an unchanged draft", () => {
    // Reachable when the stored value is already over a maximum that has since
    // been tightened: nothing has changed, and it still cannot be saved.
    const state = editDraftState([
      field("x".repeat(151), "x".repeat(151), 150),
    ]);

    expect(state.blockedBy).toBe("too-long");
  });
});
