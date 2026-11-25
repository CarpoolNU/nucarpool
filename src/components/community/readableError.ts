/**
 * What a failed query should say to the reader.
 *
 * **Because `error.message` is not always written for one.** The services
 * write their refusals as sentences — "No such category: bogus" — and those go
 * through untouched; that message is the only part of a failure that tells the
 * reader what they did. But a request that the procedure's Zod schema rejects
 * never reaches a service, and tRPC puts the serialized issue list in
 * `message`, so rendering it verbatim prints `"code": "too_big"` and a JSON
 * path into a reading column. That is reachable without a crafted request:
 * `/community/search?q=<101 characters>` is a pasted URL, since the box caps
 * what can be typed and nothing caps what can be pasted (SCRUM-692).
 *
 * **It sniffs the message rather than the error code**, because the code does
 * not separate the two. `TEXT_TOO_LONG` and `TEXT_EMPTY` are BAD_REQUEST and
 * are sentences; the validator's dump is BAD_REQUEST and is not.
 */
const VALIDATOR_FALLBACK =
  "That link asked for something this page can't request.";

/** Whether a message is a serialized list of Zod issues rather than prose. */
const isIssueList = (message: string): boolean => {
  if (!message.trimStart().startsWith("[")) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // Prose that opens with a bracket, which is the case this guard exists for.
    return false;
  }

  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        "code" in issue &&
        "message" in issue,
    )
  );
};

export const readableError = (
  message: string | null | undefined,
): string | null => {
  if (message === null || message === undefined) return null;
  return isIssueList(message) ? VALIDATOR_FALLBACK : message;
};
