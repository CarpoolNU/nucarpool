import { RequestStatus } from "@prisma/client";
import { findAcceptedRequestIds, parseArgs } from "./backfill-request-status";

/**
 * The backfill for `Request.status`.
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

  it("accepts --dry-run, which this script used to reject", () => {
    // Until SCRUM-719 this threw `unexpected argument: --dry-run`, alone among
    // the scripts sharing this parser. The flag an operator reaches for when
    // they want to be certain they are not writing now works here too.
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
  });

  it("lets the last of --apply and --dry-run win", () => {
    // An explicit --dry-run after --apply wins, so the more cautious of two
    // conflicting flags is reachable without retyping the command.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
    // And the reverse order writes. This is the case SCRUM-719 had to decide
    // rather than inherit: before convergence it threw and wrote nothing, so
    // this assertion is the record that the change was intentional, not the
    // accidental half of a refactor. Pinned here so a future reversal to a
    // sticky --dry-run has to argue with a test rather than slip through.
    expect(parseArgs(["--dry-run", "--apply"]).apply).toBe(true);
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

  it("reports both failures in the shared parser's wording", () => {
    // Nothing pinned either string before SCRUM-719, and converging onto
    // `lib/parseArgs.ts` reworded both: `--max needs a positive integer, got:
    // X` became `--max expects a positive integer, got X`, and `unexpected
    // argument: X` became `unknown argument: X`. Asserted so the divergence
    // cannot quietly come back, and so the next reader can tell which parser
    // produced a message they are looking at.
    expect(() => parseArgs(["--max", "0"])).toThrow(
      "--max expects a positive integer, got 0",
    );
    expect(() => parseArgs(["--force"])).toThrow("unknown argument: --force");
  });
});
