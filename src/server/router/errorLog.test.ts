import {
  ERROR_LOG_PREFIX,
  formatServerError,
  logServerError,
  NO_REQUEST_ID,
  type ServerErrorFields,
  type ServerErrorInput,
} from "./errorLog";

/**
 * The server-error log line (SCRUM-400, part 2's decision-independent half).
 *
 * `[trpc].ts` handed an object to `console.error` as a second argument, which
 * Node renders with `util.inspect` — six lines for one fault, and six events
 * in a hosted log viewer. The correlation id added in part 1 exists to make a
 * masked client message findable, and an id that arrives in a different event
 * from the request that produced it is markedly harder to find.
 *
 * The assertions that matter here are the two the old form failed: that the
 * output is **one line**, and that it is **parseable** — those are what make a
 * metric filter or a Logs Insights query on `requestId` possible at all. The
 * rest pin the field set, because SCRUM-400 puts redaction explicitly out of
 * scope and this had to be a formatting change and nothing more.
 */

const FIELDS: ServerErrorFields = {
  requestId: "a1b2c3d4",
  path: "user.edit",
  type: "mutation",
  code: "INTERNAL_SERVER_ERROR",
  causeName: "PrismaClientKnownRequestError",
};

/** The JSON body, with the prefix stripped. */
const payloadOf = (line: string): Record<string, unknown> =>
  JSON.parse(line.slice(ERROR_LOG_PREFIX.length + 1));

describe("formatServerError", () => {
  it("emits exactly one line", () => {
    // The defect. `util.inspect` broke one fault across six events, so the
    // request id and the path it belonged to were no longer in the same record.
    const line = formatServerError(FIELDS);

    expect(line.split("\n")).toHaveLength(1);
  });

  it("emits a parseable JSON body behind a greppable prefix", () => {
    const line = formatServerError(FIELDS);

    expect(line.startsWith(`${ERROR_LOG_PREFIX} `)).toBe(true);
    expect(() => payloadOf(line)).not.toThrow();
  });

  it("carries every field it was given", () => {
    expect(payloadOf(formatServerError(FIELDS))).toEqual({
      requestId: "a1b2c3d4",
      path: "user.edit",
      type: "mutation",
      code: "INTERNAL_SERVER_ERROR",
      causeName: "PrismaClientKnownRequestError",
    });
  });

  it("carries no field it was not given", () => {
    // Redaction is out of scope for this change, so the field set has to be
    // exactly what `[trpc].ts` already logged. A formatter that quietly grew a
    // `message` or a `stack` would be a disclosure, not a formatting change.
    expect(Object.keys(payloadOf(formatServerError(FIELDS))).sort()).toEqual([
      "causeName",
      "code",
      "path",
      "requestId",
      "type",
    ]);
  });

  it("keeps the field set stable when values are absent", () => {
    // `JSON.stringify` drops undefined-valued keys, which would make the shape
    // vary line to line — and a query written against a field that is
    // sometimes absent silently matches nothing for those rows. Normalised to
    // null so the key is always present.
    const line = formatServerError({
      ...FIELDS,
      path: undefined,
      causeName: undefined,
    });
    const payload = payloadOf(line);

    expect(payload.path).toBeNull();
    expect(payload.causeName).toBeNull();
    expect(Object.keys(payload)).toHaveLength(5);
  });

  it("records the no-context request id verbatim", () => {
    // `"none"` is what `[trpc].ts` logs when `createContext` threw and the
    // client therefore got no reference. It must survive as a real value
    // rather than being treated as missing.
    expect(
      payloadOf(formatServerError({ ...FIELDS, requestId: "none" })).requestId,
    ).toBe("none");
  });

  it("does not begin with the message shown to users", () => {
    // The line used to start "Something went wrong", which is
    // `UNEXPECTED_ERROR_MESSAGE` almost verbatim — it read as a copy of the
    // client string rather than as a server event, and made a poor search
    // term. `[csp-report]` is the convention this now follows.
    expect(formatServerError(FIELDS)).not.toMatch(/^Something went wrong/);
    expect(ERROR_LOG_PREFIX).toBe("[trpc-error]");
  });

  it("survives a cause name that would break a log line", () => {
    // `causeName` is a constructor name today, so this is defence rather than
    // an observed case — but the whole value of one-line JSON is that a single
    // embedded newline cannot split the record back into two events.
    const line = formatServerError({
      ...FIELDS,
      causeName: 'Evil\nName" with "quotes',
    });

    expect(line.split("\n")).toHaveLength(1);
    expect(payloadOf(line).causeName).toBe('Evil\nName" with "quotes');
  });
});

/**
 * The log decision itself, which used to live inline in
 * `src/pages/api/trpc/[trpc].ts` where no test file may exist — a filename
 * there is also a URL. These are the assertions that were previously
 * unreachable: which branch runs, what the production branch is allowed to
 * carry, and what happens when there is no request context.
 */
describe("logServerError", () => {
  const input = (overrides: Partial<ServerErrorInput> = {}): ServerErrorInput =>
    ({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        cause: { name: "PrismaClientKnownRequestError" },
      },
      path: "user.edit",
      type: "mutation",
      ctx: { requestId: "a1b2c3d4" },
      ...overrides,
    }) as ServerErrorInput;

  /** Collects what the logger was handed, instead of spying on the console. */
  const capture = () => {
    const calls: unknown[][] = [];
    return { calls, logger: (...args: unknown[]) => calls.push(args) };
  };

  it("writes one argument, one line, in production", () => {
    const { calls, logger } = capture();

    logServerError(input(), "production", logger);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(String(calls[0][0]).split("\n")).toHaveLength(1);
  });

  it("never hands production the error object", () => {
    // The disclosure that matters. A Prisma error's *message* quotes the
    // parameters that caused it — addresses and emails here — and passing the
    // Error as a second argument is how a console renders that message and its
    // stack. Production gets a string and nothing else.
    const { calls, logger } = capture();

    logServerError(input(), "production", logger);

    // Every argument is a primitive string. The class *name* is carried
    // deliberately — it says what kind of fault it was and holds no data — so
    // the invariant is the absence of the object, not the absence of the name.
    // The test below covers the message, which is the part that quotes values.
    expect(calls[0].every((arg) => typeof arg === "string")).toBe(true);
    expect(payloadOf(String(calls[0][0])).causeName).toBe(
      "PrismaClientKnownRequestError",
    );
  });

  it("carries the cause's name and not the cause itself", () => {
    const { calls, logger } = capture();

    logServerError(
      input({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          cause: Object.assign(new Error("addresses and emails in here"), {
            name: "PrismaClientKnownRequestError",
          }),
        },
      }),
      "production",
      logger,
    );

    expect(String(calls[0][0])).not.toContain("addresses and emails");
    expect(payloadOf(String(calls[0][0])).causeName).toBe(
      "PrismaClientKnownRequestError",
    );
  });

  it("keeps the raw error in development, for its stack", () => {
    const { calls, logger } = capture();
    const cause = new Error("local detail");

    logServerError(
      input({ error: { code: "INTERNAL_SERVER_ERROR", cause } }),
      "development",
      logger,
    );

    expect(calls[0]).toHaveLength(2);
    expect(calls[0][1]).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      cause,
    });
  });

  it("treats an unset NODE_ENV as not-production", () => {
    // Deliberately the same default as `formatPrismaLog` and the opposite of
    // `errorMasking`: losing a local stack to an unset variable is the worse
    // outcome here, and an unset NODE_ENV is not a deployed environment.
    const { calls, logger } = capture();

    logServerError(input(), undefined, logger);

    expect(calls[0]).toHaveLength(2);
  });

  it("prefixes both branches the same way, so one search finds either", () => {
    const production = capture();
    const development = capture();

    logServerError(input(), "production", production.logger);
    logServerError(input(), "development", development.logger);

    expect(String(production.calls[0][0]).startsWith(ERROR_LOG_PREFIX)).toBe(
      true,
    );
    expect(String(development.calls[0][0]).startsWith(ERROR_LOG_PREFIX)).toBe(
      true,
    );
  });

  it("records the request id the client was given", () => {
    // The whole point of part 1: a user quotes this and it is findable here.
    const { calls, logger } = capture();

    logServerError(input(), "production", logger);

    expect(payloadOf(String(calls[0][0])).requestId).toBe("a1b2c3d4");
  });

  it('records "none" when createContext itself threw', () => {
    // No context means the client got no reference either, so there is no id
    // to report. Inventing one would put an id in the log that appears nowhere
    // else — worse than admitting there is none.
    const { calls, logger } = capture();

    logServerError(input({ ctx: undefined }), "production", logger);

    expect(payloadOf(String(calls[0][0])).requestId).toBe(NO_REQUEST_ID);
    expect(NO_REQUEST_ID).toBe("none");
  });

  it("survives a context with no request id on it", () => {
    const { calls, logger } = capture();

    logServerError(input({ ctx: {} }), "production", logger);

    expect(payloadOf(String(calls[0][0])).requestId).toBe(NO_REQUEST_ID);
  });

  it("survives a failure that never reached a procedure", () => {
    // `path` is undefined when the fault precedes routing.
    const { calls, logger } = capture();

    logServerError(input({ path: undefined }), "production", logger);

    expect(payloadOf(String(calls[0][0])).path).toBeNull();
  });

  it("survives an error with no cause", () => {
    const { calls, logger } = capture();

    logServerError(
      input({ error: { code: "INTERNAL_SERVER_ERROR" } }),
      "production",
      logger,
    );

    expect(payloadOf(String(calls[0][0])).causeName).toBeNull();
  });
});
