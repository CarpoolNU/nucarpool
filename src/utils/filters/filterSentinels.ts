/**
 * The top of each Explore slider's range, where the filter switches off.
 *
 * These are not loose bounds that happen to admit everything: the scorer tests
 * `inputs.startDistance < DISTANCE_FILTER_ANY` before applying the distance
 * cutoff at all, so the top value means "any" rather than "at most 20 miles".
 * `candidateSearch` relies on the same reading to decide whether SQL may
 * narrow by a bounding box.
 *
 * Shared across the slider's `max`, its gradient arithmetic and its `20+`
 * label in `Filters.tsx`, the initial filter state in `pages/index.tsx`,
 * `DISTANCE_FILTER_MAX` in `candidateSearch.ts`, and the two comparisons in
 * `recommendation.ts`. Raising the ceiling in only one of them would leave the
 * others disagreeing silently: a slider that goes to 30 against a scorer that
 * stops filtering at 20 shows unfiltered results for the top third of the
 * track.
 *
 * Defined here, with no imports, so the client components, the shared scorer
 * and the server's candidate query can all read them without pulling anything
 * else across that boundary.
 */

/** Miles. `startDistance`/`endDistance` at this value mean "any distance". */
export const DISTANCE_FILTER_ANY = 20;

/**
 * Hours of schedule deviation. `startTime`/`endTime` at this value mean "any
 * time". It is a **maximum** deviation, so the top of the slider is the
 * loosest setting.
 */
export const TIME_FILTER_ANY = 4;
