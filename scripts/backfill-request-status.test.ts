import { RequestStatus } from "@prisma/client";
import { findAcceptedRequestIds, parseArgs } from "./backfill-request-status";

/**
 * The backfill for `Request.status` (SCRUM-228).
 *
 * Two things are worth pinning without a database: the pairing rule, which
 * decides which historical rows get rewritten, and the argument parsing, which
 * decides whether anything is written at all.
 */

const request = (
  id: string,
  fromUserId: string,
  toUserId: string,
  status: RequestStatus = RequestStatus.PENDING,
) => ({ id, status, fromUserId, toUserId });

const groups = (entries: Record<string, string | null>) =>
  new Map<string, string | null>(Object.entries(entries));

describe("findAcceptedRequestIds", () => {
  it("selects a request whose two users share a group", () => {
    const ids = findAcceptedRequestIds(
      [request("r1", "a", "b")],
      groups({ a: "group-1", b: "group-1" }),
    );

    expect(ids).toEqual(["r1"]);
  });

  it("ignores a pair in different groups", () => {
    const ids = findAcceptedRequestIds(
      [request("r1", "a", "b")],
      groups({ a: "group-1", b: "group-2" }),
    );

    expect(ids).toEqual([]);
  });

  it("ignores a pair where neither user is in a group", () => {
    // Two nulls are not a match. Without the explicit null check this is the
    // case that would rewrite every unanswered request on the platform.
    const ids = findAcceptedRequestIds(
      [request("r1", "a", "b")],
      groups({ a: null, b: null }),
    );

    expect(ids).toEqual([]);
  });

  it("ignores a pair where only one user is in a group", () => {
    const ids = findAcceptedRequestIds(
      [request("r1", "a", "b")],
      groups({ a: "group-1", b: null }),
    );

    expect(ids).toEqual([]);
  });

  it("ignores users with no CarpoolSearch at all", () => {
    // Absent from the map entirely, rather than present with a null.
    const ids = findAcceptedRequestIds([request("r1", "a", "b")], groups({}));

    expect(ids).toEqual([]);
  });

  it("leaves a request that is already accepted", () => {
    // Re-running the script has to be a no-op.
    const ids = findAcceptedRequestIds(
      [request("r1", "a", "b", RequestStatus.ACCEPTED)],
      groups({ a: "group-1", b: "group-1" }),
    );

    expect(ids).toEqual([]);
  });

  it("selects every matching pair in a group of three", () => {
    const ids = findAcceptedRequestIds(
      [
        request("r1", "driver", "rider-1"),
        request("r2", "driver", "rider-2"),
        request("r3", "driver", "outsider"),
      ],
      groups({
        driver: "group-1",
        "rider-1": "group-1",
        "rider-2": "group-1",
        outsider: null,
      }),
    );

    expect(ids).toEqual(["r1", "r2"]);
  });

  it("finds nothing in an empty database", () => {
    expect(findAcceptedRequestIds([], groups({}))).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("is a dry run by default", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("writes only when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("rejects an argument spelling that is not exactly --apply", () => {
    // The property that matters: no near-miss reaches a write.
    for (const arg of ["--Apply", "-apply", "apply", "--apply=true"]) {
      expect(() => parseArgs([arg])).toThrow();
    }
  });

  it("accepts a positive --max", () => {
    expect(parseArgs(["--max", "2000"]).max).toBe(2000);
  });

  it("rejects a --max that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "many", ""]) {
      expect(() => parseArgs(["--max", value])).toThrow();
    }
  });

  it("rejects unknown arguments rather than ignoring them", () => {
    expect(() => parseArgs(["--force"])).toThrow();
  });
});
