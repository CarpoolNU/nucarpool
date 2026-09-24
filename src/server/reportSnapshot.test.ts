import {
  buildConversationSnapshot,
  parseConversationSnapshot,
} from "./reportSnapshot";

/**
 * The stored shape of a report's conversation copy (SCRUM-555), both ways.
 * `getReports` depends on the parse never throwing, since one bad row would
 * otherwise take the whole admin queue down.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));

describe("buildConversationSnapshot", () => {
  it("stores the messages oldest first, whatever order they arrive in", () => {
    const stored = buildConversationSnapshot([
      { userId: "b", content: "second", dateCreated: at(2) },
      { userId: "a", content: "first", dateCreated: at(1) },
    ]);

    expect(JSON.parse(stored)).toEqual([
      { senderId: "a", content: "first", sentAt: "2026-09-01T12:01:00.000Z" },
      { senderId: "b", content: "second", sentAt: "2026-09-01T12:02:00.000Z" },
    ]);
  });

  it("stores an empty thread as an empty list", () => {
    expect(buildConversationSnapshot([])).toBe("[]");
  });
});

describe("parseConversationSnapshot", () => {
  it("reads back what the builder wrote, with real dates", () => {
    const stored = buildConversationSnapshot([
      { userId: "a", content: "<b>hi</b>", dateCreated: at(1) },
    ]);

    expect(parseConversationSnapshot(stored)).toEqual([
      { senderId: "a", content: "<b>hi</b>", sentAt: at(1) },
    ]);
  });

  it("answers null for a report with no snapshot", () => {
    expect(parseConversationSnapshot(null)).toBeNull();
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["JSON of the wrong shape", JSON.stringify({ messages: [] })],
    ["a message missing its sender", JSON.stringify([{ content: "x" }])],
  ])("answers null rather than throwing for %s", (_label, stored) => {
    expect(parseConversationSnapshot(stored)).toBeNull();
  });
});
