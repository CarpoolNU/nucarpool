import { randomBytes } from "crypto";

/**
 * A short random reference for one request, so a masked client message and a
 * redacted server log line can be tied together.
 *
 * SCRUM-388 stopped sending unexpected error messages to the browser, which
 * left a user with "Something went wrong. Please try again." and nothing to
 * quote, and whoever reads the log with no way to find that particular
 * failure among the rest. This is the thing both ends can name.
 *
 * **Deliberately carries no information.** Not a user id, not a session id,
 * not a timestamp, because the whole point of the masking it supports is that
 * the client is told nothing about the fault. It is random, and it means
 * nothing outside the log.
 *
 * Eight hex characters, which is short enough for someone to read off a screen
 * into a support message. That is 4 bytes, so identifiers do repeat over a
 * large enough number of errors - the job is to isolate one failure inside the
 * window someone is searching, not to be globally unique, and a duplicate
 * costs a second line of output to scan. If it ever needs to be a real
 * primary key, widen it here.
 */
export const newRequestId = (): string => randomBytes(4).toString("hex");
