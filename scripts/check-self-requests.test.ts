import { findSelfRequestIds } from "./check-self-requests";

/**
 * The detection half of the check, tested without a database.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

const row = (id: string, fromUserId: string, toUserId: string) => ({
  id,
  fromUserId,
  toUserId,
});

describe("findSelfRequestIds", () => {
  it("finds rows whose two ends are the same user", () => {
    expect(
      findSelfRequestIds([
        row("a", "alice", "bob"),
        row("b", "alice", "alice"),
        row("c", "bob", "alice"),
        row("d", "bob", "bob"),
      ]),
    ).toEqual(["b", "d"]);
  });

  it("returns nothing when every request is between two people", () => {
    expect(
      findSelfRequestIds([row("a", "alice", "bob"), row("b", "bob", "alice")]),
    ).toEqual([]);
  });

  it("handles an empty table", () => {
    expect(findSelfRequestIds([])).toEqual([]);
  });

  it("compares the ids rather than assuming an ordering", () => {
    // A reciprocal pair between two people is not a self-request, however it
    // is ordered, and must not be swept up.
    expect(
      findSelfRequestIds([row("a", "bob", "alice"), row("b", "alice", "bob")]),
    ).toEqual([]);
  });
});
