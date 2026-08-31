import {
  buildPayloads,
  countRows,
  narrowMessage,
  reduction,
  serializedBytes,
  syntheticScenario,
} from "./measure-requests-payload";

/**
 * The arithmetic behind the SCRUM-301 measurement, tested for the same reason as
 * `measure-candidate-rows.test.ts`: a measurement that quietly counts wrong is
 * worse than no measurement, and this one is quoted in the ticket and the PR.
 */

const message = (id: string, userId: string) => ({
  id,
  conversationId: "conversation-1",
  content: "hello",
  userId,
  isRead: false,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  // Present on the row Prisma returns, absent from the narrow selection.
  User: { id: userId, email: `${userId}@northeastern.edu` },
});

describe("countRows", () => {
  const base = {
    requests: 2,
    conversations: 2,
    messages: 100,
    authorIds: ["a", "b", "a", "b", "a"],
    counterpartIds: ["b", "c"],
  };

  it("deduplicates authors, because a to-one include is one IN (...)", () => {
    // The correction this script exists to make: 100 messages by two people
    // read two user rows, not 100. Overstating this would overstate the change.
    const counts = countRows({
      ...base,
      joins: { messageAuthors: true, counterparts: false },
    });

    expect(counts.user).toBe(2);
    expect(counts.total).toBe(2 + 2 + 100 + 2);
  });

  it("counts authors and counterparts as one set, since they overlap", () => {
    const counts = countRows({
      ...base,
      joins: { messageAuthors: true, counterparts: true },
    });

    // a, b from authors; b already counted, c is new.
    expect(counts.user).toBe(3);
  });

  it("reads no user rows once both joins are gone", () => {
    const counts = countRows({
      ...base,
      joins: { messageAuthors: false, counterparts: false },
    });

    expect(counts.user).toBe(0);
    expect(counts.total).toBe(2 + 2 + 100);
  });

  it("never changes the message row count, because this narrows columns", () => {
    // The whole point: rows are the same either way, so a reader is not told
    // that fewer messages were fetched.
    const withJoins = countRows({
      ...base,
      joins: { messageAuthors: true, counterparts: true },
    });
    const without = countRows({
      ...base,
      joins: { messageAuthors: false, counterparts: false },
    });

    expect(withJoins.message).toBe(100);
    expect(without.message).toBe(100);
  });

  it("is zero for an empty result", () => {
    expect(
      countRows({
        requests: 0,
        conversations: 0,
        messages: 0,
        authorIds: [],
        counterpartIds: [],
        joins: { messageAuthors: true, counterparts: true },
      }),
    ).toEqual({
      request: 0,
      conversation: 0,
      message: 0,
      user: 0,
      total: 0,
    });
  });
});

describe("narrowMessage", () => {
  it("keeps exactly the six columns the resolver now selects", () => {
    expect(Object.keys(narrowMessage(message("m1", "a")))).toEqual([
      "id",
      "conversationId",
      "content",
      "userId",
      "isRead",
      "dateCreated",
    ]);
  });

  it("drops the embedded author row", () => {
    expect(narrowMessage(message("m1", "a"))).not.toHaveProperty("User");
  });

  it("preserves the values it keeps, so sizes stay comparable", () => {
    const narrowed = narrowMessage(message("m1", "author-1"));

    expect(narrowed.id).toBe("m1");
    expect(narrowed.userId).toBe("author-1");
    expect(narrowed.isRead).toBe(false);
    expect(narrowed.dateCreated).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("serializedBytes", () => {
  it("measures the superjson envelope tRPC actually sends, not bare JSON", () => {
    // A Date costs more than its ISO string because superjson records its type
    // alongside it. Measuring plain JSON would understate every payload here.
    const withDate = serializedBytes({ at: new Date("2026-01-01") });
    const withString = serializedBytes({ at: "2026-01-01T00:00:00.000Z" });

    expect(withDate).toBeGreaterThan(withString);
  });

  it("grows with the payload", () => {
    expect(serializedBytes([1, 2, 3])).toBeGreaterThan(serializedBytes([1]));
  });
});

describe("reduction", () => {
  it("reports the percentage saved", () => {
    expect(reduction(100, 25)).toBe(75);
    expect(reduction(672, 159)).toBe(76);
  });

  it("is zero rather than negative when nothing was saved", () => {
    expect(reduction(100, 100)).toBe(0);
    expect(reduction(100, 200)).toBe(0);
  });

  it("is zero for an empty before, rather than dividing by it", () => {
    expect(reduction(0, 0)).toBe(0);
  });
});

describe("buildPayloads", () => {
  const userById = (id: string) => ({
    id,
    email: `${id}@northeastern.edu`,
    image: "x".repeat(256),
  });

  const rows = [
    {
      id: "request-1",
      counterpartId: "user-b",
      messages: [message("m1", "user-a"), message("m2", "user-b")],
    },
  ];

  it("attaches an author row per message in the before shape", () => {
    const { before } = buildPayloads(rows, userById);

    expect(before[0]!.messages).toHaveLength(2);
    for (const message of before[0]!.messages) {
      expect(message).toHaveProperty("User");
    }
  });

  it("attaches the discarded counterpart join in the before shape only", () => {
    const { before, after } = buildPayloads(rows, userById);

    expect(before[0]).toHaveProperty("counterpart");
    expect(after[0]).not.toHaveProperty("counterpart");
  });

  it("makes the after shape smaller for the same rows", () => {
    const { before, after } = buildPayloads(rows, userById);

    expect(serializedBytes(after)).toBeLessThan(serializedBytes(before));
  });

  it("repeats the same author row once per message, which is the defect", () => {
    // Two messages from the same person carry that person twice. This is what
    // made a long thread expensive, and what the narrow select removes.
    const sameAuthor = [
      {
        id: "request-1",
        counterpartId: "user-b",
        messages: [message("m1", "user-a"), message("m2", "user-a")],
      },
    ];
    const { before } = buildPayloads(sameAuthor, userById);

    expect(before[0]!.messages[0]!.User).toEqual(before[0]!.messages[1]!.User);
  });
});

describe("syntheticScenario", () => {
  it("builds the shape the ticket describes", () => {
    const { rows } = syntheticScenario();

    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.messages.length === 60)).toBe(true);
  });

  it("alternates authors, so both parties appear in every thread", () => {
    const { caller, rows } = syntheticScenario(1, 4);
    const authors = rows[0]!.messages.map((m) => m.userId);

    expect(new Set(authors).size).toBe(2);
    expect(authors[0]).toBe(caller);
  });

  it("is adjustable, so a heavier or lighter case can be checked", () => {
    const { rows } = syntheticScenario(2, 5);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.messages).toHaveLength(5);
  });

  it("shows a large byte saving and only a small row saving", () => {
    // The headline claim, asserted rather than left to the console output: the
    // change is about bytes on the wire, not rows read.
    const { rows } = syntheticScenario(10, 60);
    const userById = (id: string) => ({
      id,
      email: `${id}@northeastern.edu`,
      image: "x".repeat(256),
      bio: "y".repeat(120),
    });

    const { before, after } = buildPayloads(rows, userById);
    const byteSaving = reduction(
      serializedBytes(before),
      serializedBytes(after),
    );

    const messages = rows.reduce((sum, row) => sum + row.messages.length, 0);
    const authorIds = rows.flatMap((row) =>
      row.messages.map((m) => String(m.userId)),
    );
    const counterpartIds = rows.map((row) => row.counterpartId);
    const rowSaving = reduction(
      countRows({
        requests: rows.length,
        conversations: rows.length,
        messages,
        authorIds,
        counterpartIds,
        joins: { messageAuthors: true, counterparts: true },
      }).total,
      countRows({
        requests: rows.length,
        conversations: rows.length,
        messages,
        authorIds,
        counterpartIds,
        joins: { messageAuthors: false, counterparts: false },
      }).total,
    );

    expect(byteSaving).toBeGreaterThan(60);
    expect(rowSaving).toBeLessThan(10);
  });
});
