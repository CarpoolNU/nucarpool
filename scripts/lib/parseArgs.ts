/**
 * The argument parser shared by the `--apply` / `--max` ops scripts.
 *
 * Six scripts under `scripts/` had this function copied out character for
 * character. That is not an aesthetic complaint: every one of them is a
 * destructive tool where `--apply` is the difference between a report and a
 * write, and `--max` is the ceiling that stops a logic error from running away
 * across the whole table. A hardening change to this parsing had to be made six
 * times to be true, and a copy that was missed kept the old behaviour with
 * nothing to show that it had been left behind. SCRUM-716 collapsed them so
 * there is one place to change.
 *
 * The contract, unchanged from the copies it replaces:
 *
 *   - **Dry run by default.** `apply` starts false and only `--apply` sets it.
 *   - `--dry-run` sets it back to false, so the last of the two flags on the
 *     command line wins.
 *   - `--max N` requires a positive integer and throws on anything else,
 *     including a missing value — `Number(undefined)` is `NaN`, which is not an
 *     integer.
 *   - **Anything else throws.** An unrecognised argument is never ignored,
 *     because a silently dropped flag on a script like this is how an operator
 *     comes to believe a guard is in force when it is not. That also rules out
 *     every near-miss spelling of `--apply`: `--Apply`, `-apply`, `apply` and
 *     `--apply=true` all land in the final branch and throw.
 *
 * `scripts/backfill-request-status.ts` deliberately does **not** use this. Its
 * parser has no `--dry-run` branch, so `--dry-run` throws there and is accepted
 * here; folding it in would have changed the behaviour of a destructive script
 * rather than merely moving it. SCRUM-719 carries that divergence on its own.
 * `cleanup-orphan-conversations.ts` (a superset, with `--limit` and
 * `--older-than`) and `measure-layout.ts` (an unrelated parser that happens to
 * share the name) are likewise not callers.
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
