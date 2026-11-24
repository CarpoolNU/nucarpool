/**
 * The page-size policy every list in this module shares.
 *
 * **One place, because a second list would otherwise mean a second answer.**
 * The feed, a thread and the saved list all take a caller-supplied `limit` and
 * all have the same reason to bound it; a cap that differed between them would
 * be a difference nobody decided.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Bounds a caller-supplied page size.
 *
 * An unbounded `limit` is a denial-of-service vector on any list endpoint:
 * `limit=1000000` turns one request into a full table read. Clamping rather
 * than refusing keeps a slightly-too-eager client working.
 */
export const clampPageSize = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(requested)));
};
