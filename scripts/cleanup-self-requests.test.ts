import {
  type RequestRow,
  parseArgs,
  selectSelfRequests,
} from "./cleanup-self-requests";

/**
 * This script deletes production rows, and unlike `cleanup-orphan-locations` it
 * takes message content with them. So the argument parser is the last thing
 * between a typo and irreversible loss, and the selection is the arithmetic
 * deciding which rows go.
 *
 * What a self-request *is* stays covered by `check-self-requests.test.ts`,
 * where `findSelfRequestIds` lives — this module imports that predicate rather
 * than restating it, so there is one definition to test. What is covered here
 * is everything the cleanup adds on top: that deleting is opt-in, that the
 * message count is attached to the right row, and that a non-self request is
 * never selected however the rows are ordered.
 *
 * Importing this module is safe: it only calls `main()` when run directly.
 */

const row = (
  id: string,
  fromUserId: string,
  toUserId: string,
  overrides: Partial<RequestRow> = {},
): RequestRow => ({
  id,
  fromUserId,
  toUserId,
  conversationId: null,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("cleanup-self-requests argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only deletes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // The more cautious of two conflicting flags wins, matching
    // `cleanup-orphan-conversations`.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    // `--aply` must not silently become a dry run the operator reads as
    // "it deleted nothing, so there was nothing to delete".
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["extra"])).toThrow(/unknown argument/);
  });

  it("rejects a --max that is not a positive integer", () => {
    expect(() => parseArgs(["--max", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "-1"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "many"])).toThrow(/positive integer/);
    expect(parseArgs(["--max", "10"]).max).toBe(10);
  });
});

describe("cleanup-self-requests candidate selection", () => {
  it("selects only rows whose two ends are the same user", () => {
    const requests = [
      row("req-self", "user-a", "user-a"),
      row("req-pair", "user-a", "user-b"),
      row("req-reverse", "user-b", "user-a"),
    ];

    expect(selectSelfRequests(requests, new Map()).map((c) => c.id)).toEqual([
      "req-self",
    ]);
  });

  it("selects nothing when every request is between two people", () => {
    const requests = [
      row("req-1", "user-a", "user-b"),
      row("req-2", "user-b", "user-c"),
    ];

    expect(selectSelfRequests(requests, new Map())).toEqual([]);
  });

  it("attaches the message count of the conversation the row links to", () => {
    // The count is what tells the operator whether a row held anything a user
    // typed, and it is printed immediately before the delete. Attaching it to
    // the wrong row would misreport what a run destroyed.
    const requests = [
      row("req-1", "user-a", "user-a", { conversationId: "conversation-1" }),
    ];

    const [candidate] = selectSelfRequests(
      requests,
      new Map([
        ["conversation-1", 3],
        ["conversation-2", 99],
      ]),
    );

    expect(candidate).toMatchObject({
      id: "req-1",
      userId: "user-a",
      conversationId: "conversation-1",
      messages: 3,
    });
  });

  it("reports zero messages for a self-request with no conversation", () => {
    // Most requests have no conversation at all — the model postdates them —
    // so this is the ordinary case rather than a defensive one.
    const requests = [row("req-1", "user-a", "user-a")];

    expect(selectSelfRequests(requests, new Map())[0]).toMatchObject({
      conversationId: null,
      messages: 0,
    });
  });

  it("reports zero rather than throwing when the count is missing", () => {
    // A conversation row deleted between the two reads leaves the groupBy with
    // no entry for it. Reporting 0 is right: there are no messages to delete.
    const requests = [
      row("req-1", "user-a", "user-a", { conversationId: "conversation-gone" }),
    ];

    expect(selectSelfRequests(requests, new Map())[0].messages).toBe(0);
  });

  it("orders oldest first so two runs report the same sequence", () => {
    const requests = [
      row("req-new", "user-a", "user-a", {
        dateCreated: new Date("2026-04-15T00:00:00.000Z"),
      }),
      row("req-old", "user-b", "user-b", {
        dateCreated: new Date("2026-02-18T00:00:00.000Z"),
      }),
    ];

    expect(selectSelfRequests(requests, new Map()).map((c) => c.id)).toEqual([
      "req-old",
      "req-new",
    ]);
  });

  it("breaks ties on id, because dateCreated is not unique", () => {
    const sameInstant = new Date("2026-02-18T00:00:00.000Z");
    const requests = [
      row("req-b", "user-a", "user-a", { dateCreated: sameInstant }),
      row("req-a", "user-b", "user-b", { dateCreated: sameInstant }),
    ];

    expect(selectSelfRequests(requests, new Map()).map((c) => c.id)).toEqual([
      "req-a",
      "req-b",
    ]);
  });
});
