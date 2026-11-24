/**
 * Keyset pagination cursors.
 *
 * **Keyset, not offset.** The index tuples `(categoryId, dateCreated, id)` and
 * `(categoryId, voteCount, id)` *are* these cursors: a page is
 * `WHERE (dateCreated, id) < (?, ?) ORDER BY dateCreated DESC, id DESC`, and
 * the same shape over `voteCount` for the Top feed.
 *
 * **The `id` tiebreak is load-bearing.** Two posts created in the same
 * millisecond — which a seed script or a burst produces readily — would
 * otherwise sort unstably, so a row could be served twice or skipped entirely
 * across a page boundary. On the Top feed the tie is not an accident but the
 * common case: most posts share a vote count, and without the id the whole
 * feed would reshuffle between pages. The id makes both orderings total.
 *
 * **A cursor carries the sort it was issued for, and the decoder refuses a
 * replay under the other one.** The two shapes are both "a number and an id";
 * untagged, a Top cursor read as a New one turns a vote count into a timestamp
 * near 1970 and silently serves the wrong page rather than failing. The tag is
 * the only thing standing between a sort toggle and that page.
 *
 * The encoded form is opaque to the client: it is a position in a sort, not a
 * document anyone should construct by hand.
 */

/** The orders a post feed can be read in. */
export type SortKey = "new" | "top";

/** A position in the newest-first feed, and in a comment thread. */
export type NewCursor = {
  sort: "new";
  dateCreated: Date;
  id: string;
};

/**
 * A position in the Top feed.
 *
 * **`voteCount` is mutable and non-monotonic**, unlike `dateCreated` — a post's
 * count moves while a reader is paging. See `PostService.list` for what that
 * costs and why it is accepted rather than fixed.
 */
export type TopCursor = {
  sort: "top";
  voteCount: number;
  id: string;
};

export type Cursor = NewCursor | TopCursor;

const SEPARATOR = "|";

export const encodeCursor = (cursor: Cursor): string => {
  const key =
    cursor.sort === "new"
      ? cursor.dateCreated.toISOString()
      : String(cursor.voteCount);
  return Buffer.from(
    [cursor.sort, key, cursor.id].join(SEPARATOR),
    "utf8",
  ).toString("base64url");
};

/**
 * Returns `null` for anything that is not a cursor this module produced for
 * `expected` — including a well-formed cursor issued under the other sort.
 *
 * It does not throw: a stale, mangled or cross-sort cursor should restart the
 * list from the beginning, which is a mild inconvenience, rather than fail the
 * whole request, which is a broken feed. A caller that needs to distinguish
 * the two can compare against the input.
 */
export const decodeCursor = <S extends SortKey>(
  encoded: string,
  expected: S,
): Extract<Cursor, { sort: S }> | null => {
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  // Split off the tag and the key, and leave everything after them to the id,
  // which may itself contain a separator.
  const tagAt = decoded.indexOf(SEPARATOR);
  if (tagAt <= 0 || decoded.slice(0, tagAt) !== expected) {
    return null;
  }
  const keyAt = decoded.indexOf(SEPARATOR, tagAt + 1);
  if (keyAt <= tagAt + 1) {
    return null;
  }

  const key = decoded.slice(tagAt + 1, keyAt);
  const id = decoded.slice(keyAt + 1);
  if (id.length === 0) {
    return null;
  }

  const cursor = expected === "new" ? newCursor(key, id) : topCursor(key, id);
  // The branch above is keyed on `expected`, so the shape matches the return
  // type by construction — which the compiler cannot see through the generic.
  return cursor as Extract<Cursor, { sort: S }> | null;
};

const newCursor = (key: string, id: string): NewCursor | null => {
  const dateCreated = new Date(key);
  return Number.isNaN(dateCreated.getTime())
    ? null
    : { sort: "new", dateCreated, id };
};

/**
 * A vote count is a non-negative integer. Anything else — a float, a sign, a
 * word — is not a count this codec wrote, and rejecting it keeps a hand-built
 * cursor from reaching the `WHERE` clause.
 */
const topCursor = (key: string, id: string): TopCursor | null => {
  if (!/^\d+$/.test(key)) {
    return null;
  }
  const voteCount = Number(key);
  return Number.isSafeInteger(voteCount)
    ? { sort: "top", voteCount, id }
    : null;
};
