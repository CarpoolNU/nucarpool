/**
 * The argument parser shared by the `--apply` / `--max` ops scripts.
 *
 * Seven scripts under `scripts/` had this function copied out, six of them
 * character for character. That is not an aesthetic complaint: every one of
 * them is a destructive tool where `--apply` is the difference between a report
 * and a write, and `--max` is the ceiling that stops a logic error from running
 * away across the whole table. A hardening change to this parsing had to be
 * made seven times to be true, and a copy that was missed kept the old
 * behaviour with nothing to show that it had been left behind. SCRUM-716
 * collapsed the six identical ones; SCRUM-719 brought in the seventh.
 *
 * The contract, unchanged from the six copies it replaced and, since
 * SCRUM-719, the one it changed:
 *
 *   - **Dry run by default.** `apply` starts false and only `--apply` sets it.
 *   - `--dry-run` sets it back to false, so the last of the two flags on the
 *     command line wins. `--apply --dry-run` reports; `--dry-run --apply`
 *     writes. SCRUM-719 settled that ordering on purpose rather than let it be
 *     inherited, because converging `backfill-request-status.ts` onto this
 *     parser turned `--dry-run --apply` there from a throw into a write. Last
 *     wins because it is the only rule under which the flags mean what they
 *     say: each one states an intent, and the later statement is the operator's
 *     current one. A `--dry-run` that outranked `--apply` regardless of
 *     position would be safer in exactly one keystroke order and more
 *     surprising in every other, and it would make the flag a mode rather than
 *     a correction. The cautious reading is still available and is the one
 *     worth teaching: put `--dry-run` last.
 *   - `--max N` requires a positive integer and throws on anything else,
 *     including a missing value — `Number(undefined)` is `NaN`, which is not an
 *     integer.
 *   - **Anything else throws.** An unrecognised argument is never ignored,
 *     because a silently dropped flag on a script like this is how an operator
 *     comes to believe a guard is in force when it is not. That also rules out
 *     every near-miss spelling of `--apply`: `--Apply`, `-apply`, `apply` and
 *     `--apply=true` all land in the final branch and throw.
 *
 * `scripts/backfill-request-status.ts` joined in SCRUM-719. Its copy had no
 * `--dry-run` branch and worded both error messages differently, so converging
 * it changed behaviour rather than merely moving it — which is why SCRUM-716
 * left it out rather than fold it in silently. Three things changed there:
 * `--dry-run` is accepted instead of throwing, `--dry-run --apply` writes
 * instead of throwing, and the two error strings now read as they do here. No
 * test pinned any of them beforehand; `backfill-request-status.test.ts` pins
 * them now.
 *
 * `cleanup-orphan-conversations.ts` (a superset, with `--limit` and
 * `--older-than`) and `measure-layout.ts` (an unrelated parser that happens to
 * share the name) are still not callers.
 */

/** The options every caller of {@link createParseArgs} parses into. */
export type Options = { apply: boolean; max: number };

/**
 * Build a `parseArgs` bound to one script's `--max` default.
 *
 * The default is a parameter rather than a constant because it is the one thing
 * the callers legitimately disagree about:
 * `repair-wallclock-schedule-times.ts` uses 50, a deliberately tighter ceiling
 * on a repair that overwrites schedule columns, where the rest use 500.
 * Normalising that to a single shared number would have loosened a guard by
 * five times under cover of a refactor.
 *
 * Each caller re-exports the result as its own `parseArgs` so that its test can
 * keep importing the name from the script, and so importing it still costs
 * nothing: the scripts guard their `main()` behind an entry-point check, and
 * this module opens no database and reads no environment.
 */
export const createParseArgs =
  (defaultMax: number) =>
  (argv: string[]): Options => {
    const options: Options = { apply: false, max: defaultMax };

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--apply") {
        options.apply = true;
      } else if (arg === "--dry-run") {
        options.apply = false;
      } else if (arg === "--max") {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`--max expects a positive integer, got ${argv[i]}`);
        }
        options.max = value;
      } else {
        throw new Error(`unknown argument: ${arg}`);
      }
    }

    return options;
  };
