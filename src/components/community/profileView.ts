/**
 * The profile route, in both directions.
 *
 * **A handle in the path, not in a query string.** `/community/u/Avery` is a
 * name of a place; `/community/profile?handle=Avery` is a lookup someone ran.
 * The first is what people paste to each other, and it is also what makes the
 * page feel like somewhere a handle *is* rather than a report about it.
 *
 * Kept out of the page so the parsing has tests: `router.query` hands back
 * `string | string[] | undefined`, and the handle is attacker-supplied text on
 * its way into a URL.
 */

/** Next gives `string[]` for a repeated route parameter. */
type QueryValue = string | string[] | undefined;

/**
 * The link to a handle's profile.
 *
 * `encodeURIComponent` is belt-and-braces: a claimed handle is
 * `[A-Za-z0-9_]` only, so this never changes a real one. It is here because
 * the argument comes from a payload rather than from the validator, and the
 * cost of being wrong about that is a crafted handle steering a link.
 */
export const profileHref = (handle: string): string =>
  `/community/u/${encodeURIComponent(handle)}`;

/**
 * Reads the handle out of the route — the inverse of {@link profileHref}.
 *
 * **Returns `undefined` rather than `""` when the route is not ready.** Next
 * renders once before `router.query` is populated, and a query fired with an
 * empty handle would ask the server about a handle nobody typed and get back
 * the same NOT_FOUND a real miss produces — showing the reader "no such
 * handle" for a profile that is about to load.
 */
export const readHandleParam = (query: {
  handle?: QueryValue;
}): string | undefined => {
  const single = Array.isArray(query.handle) ? query.handle[0] : query.handle;
  return single === undefined || single.length === 0 ? undefined : single;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * A join month, as a header renders it.
 *
 * **Month granularity, because that is all the server sends.** `PublicProfile`
 * carries `YYYY-MM` rather than a timestamp on purpose — a precise join time
 * is a correlation handle, matchable against sign-up logs — so this formats
 * what arrives and has no way to show more.
 *
 * **Named months rather than `toLocaleDateString`.** Parsing `2026-10` into a
 * `Date` to print it puts the answer at the mercy of the renderer's time zone,
 * which on a server render is the server's: a UTC-midnight first-of-month goes
 * backwards into September for anyone west of Greenwich. A table has no such
 * failure mode.
 */
export const memberSinceLabel = (memberSince: string): string => {
  const match = /^(\d{4})-(\d{2})$/.exec(memberSince);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : memberSince;
};
