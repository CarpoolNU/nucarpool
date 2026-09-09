/**
 * The shape of a server-error log line.
 *
 * `[trpc].ts` built this object inline and handed it to `console.error` as a
 * second argument, which Node renders with `util.inspect` — so a single fault
 * in production came out as **six lines**:
 *
 * ```
 * Something went wrong {
 *   requestId: 'a1b2c3',
 *   path: 'user.edit',
 *   ...
 * }
 * ```
 *
 * A hosted log viewer treats those as six separate events. That defeats the
 * point of the correlation id this ticket added in part 1: the id is meant to
 * make a masked client message findable, and it is hard to search for a value
 * that arrives in a different event from the request that produced it. It also
 * makes a CloudWatch metric filter or a Logs Insights query on any of these
 * fields impractical, because none of them is a queryable field — the whole
 * block is one `util.inspect` string.
 *
 * **This is the pattern the CSP collector already uses**, one directory over
 * and for the stated reason: `cspReport.ts` emits
 * `` `${LOG_PREFIX} ${JSON.stringify(violation)}` `` because "one line per
 * violation is what makes these greppable in a hosted log viewer". The more
 * important sink was the one not doing it.
 *
 * **What this deliberately does not change: the fields themselves.** SCRUM-388
 * and SCRUM-399 settle what may be disclosed where, and SCRUM-400 states that
 * changing redaction is out of scope. Production carries the *shape* of a
 * fault and never its contents, exactly as before — this is a formatting
 * change, and the tests assert the field set is unchanged.
 *
 * It is also not the error reporter. That decision is a product and
 * data-handling one and is still open (SCRUM-400 AC 5/6). This is the shape
 * whichever reporter is chosen would consume, and it is worth having either
 * way: if a reporter is adopted these are the fields it receives, and if none
 * is, the existing sink becomes queryable instead of staying six lines of
 * `util.inspect`.
 */

/**
 * The greppable prefix, matching `cspReport.ts`'s `[csp-report]`.
 *
 * The line used to begin `"Something went wrong"`, which is the *client-facing*
 * message in `errorMasking.ts` almost verbatim — a poor thing to search a log
 * for, since it reads as a copy of the string shown to users rather than as a
 * server event.
 */
export const ERROR_LOG_PREFIX = "[trpc-error]";

/** Exactly the fields `[trpc].ts` already logged, named. */
export type ServerErrorFields = {
  /** The reference the client was given, or `"none"` when there was no context. */
  requestId: string;
  /** The procedure that failed. `undefined` when the failure precedes routing. */
  path: string | undefined;
  /** `query`, `mutation`, `subscription`, or `unknown`. */
  type: string;
  /** The tRPC error code. Always `INTERNAL_SERVER_ERROR` at the only call site. */
  code: string;
  /**
   * `error.cause?.name` — the constructor name, not the message. A Prisma error
   * quotes its parameters in the *message*, which here would mean addresses and
   * emails; the name is the part that says what kind of fault it was without
   * saying what data caused it.
   */
  causeName: string | undefined;
};

/**
 * One line, prefixed and JSON, for a hosted log viewer.
 *
 * `undefined` is normalised to `null` rather than left out. `JSON.stringify`
 * drops undefined-valued keys entirely, which would make the field set vary
 * between lines — and a metric filter or an Insights query written against a
 * field that is sometimes absent silently matches nothing for those rows.
 *
 * @param fields the redacted fields, already chosen by the caller
 */
export function formatServerError(fields: ServerErrorFields): string {
  const payload = {
    requestId: fields.requestId,
    path: fields.path ?? null,
    type: fields.type,
    code: fields.code,
    causeName: fields.causeName ?? null,
  };

  return `${ERROR_LOG_PREFIX} ${JSON.stringify(payload)}`;
}

/**
 * The part of tRPC's `onError` payload this reads.
 *
 * Structural rather than tRPC's own types, so a test can build one without
 * constructing a real `TRPCError` — the same reason `PrismaLogEvent` in
 * `prismaLog.ts` is declared structurally.
 */
export type ServerErrorInput = {
  error: { code: string; cause?: { name?: string } | undefined };
  path: string | undefined;
  type: string;
  ctx?: { requestId?: string } | undefined;
};

/** What `[trpc].ts` logs when no request context exists to take an id from. */
export const NO_REQUEST_ID = "none";

/**
 * Writes one server error to the process output.
 *
 * This lives here rather than inline in `src/pages/api/trpc/[trpc].ts` because
 * **no test file may exist under `src/pages/`** — a filename there is also a
 * URL. The handler is the HTTP edge; the decision about what gets disclosed is
 * this, and it is the half worth pinning.
 *
 * `requestId` comes off the context rather than being generated here, so
 * `errorFormatter` reports the identical value without either callback
 * depending on running first. `ctx` is undefined when `createContext` itself
 * threw, which is also the case where the client got no reference — recording
 * `"none"` is the honest answer, because the alternative is a log line
 * carrying an id that appears nowhere else.
 *
 * **Production carries the shape of the fault, never its contents.** An error
 * payload can quote the values that caused it: a failing Prisma query includes
 * its parameters, which in this application means addresses and emails. So
 * production gets `cause.name` — the constructor name, which says what kind of
 * fault it was — and never the message or the stack. Development gets the raw
 * `Error` as a separate argument so the console renders its stack, which is
 * the whole value of the local path. The same split `formatPrismaLog` makes,
 * for the same reason.
 *
 * @param input the fields tRPC hands to `onError`
 * @param nodeEnv injectable so a test never mutates `process.env`
 * @param logger injectable so a test does not have to spy on the console
 */
export function logServerError(
  input: ServerErrorInput,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  logger: (...args: unknown[]) => void = console.error,
): void {
  const requestId = input.ctx?.requestId ?? NO_REQUEST_ID;

  if (nodeEnv === "production") {
    logger(
      formatServerError({
        requestId,
        path: input.path,
        type: input.type,
        code: input.error.code,
        causeName: input.error.cause?.name,
      }),
    );
    return;
  }

  logger(
    `${ERROR_LOG_PREFIX} ${JSON.stringify({
      requestId,
      path: input.path ?? null,
      type: input.type,
    })}`,
    input.error,
  );
}
