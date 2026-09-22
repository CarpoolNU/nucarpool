/**
 * Clear the confirmed security-test residue from one named account's five
 * user-authored text columns.
 *
 * SCRUM-357 investigated an apparent stored-XSS probe — the canonical harmless
 * test string — and deliberately stopped short of touching anything: *"No
 * remediation of any record is authorised by this ticket — if a suspicious
 * value is confirmed, what to do about it is a separate decision requiring a
 * separate ticket and a human call."* SCRUM-531 is that ticket and that call.
 * This script is the tool, and nothing else in `scripts/` fits: every other
 * write script operates on a population defined by a predicate, and this one
 * has a population of exactly one account, named in the source.
 *
 * **What it changes**, and nothing else:
 *
 *   - `user.bio`, `user.pronouns`, `user.preferredName`
 *   - `carpool_search.company_name`, `carpool_search.group_notes`
 *
 * Each is set to the empty string. Four of the five are `NOT NULL DEFAULT ''`,
 * so `""` is the column's own empty. `group_notes` is nullable, but
 * `groups.updatePreferences` writes `""` when a driver clears the field, so a
 * scrubbed row is byte-identical to the owner clearing it in the profile form
 * — the same principle `repair-wallclock-schedule-times.ts` applies to a
 * repaired schedule.
 *
 * **What it must never do.** No row is deleted, and no `message`, `request`,
 * `conversation`, `group`, `location`, `account` or `session` row is read or
 * written. The set of columns it can reach is `SCRUBBED_COLUMNS`, the update
 * data is built from that list, and each `update` statement names its own
 * columns literally — three separate places a widening would have to be made
 * deliberately. One side effect cannot be avoided: both writes bump
 * `dateModified` / `date_modified` through Prisma's `@updatedAt`.
 *
 * Safety, because this writes to a real person's profile:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - **The account is a constant, not an argument.** There is no `--user`
 *     flag, so no argument spelling reaches a different account.
 *   - **`--apply` additionally requires `--search <id>`**, and the run aborts
 *     unless that id is the `carpool_search` row it actually read. The dry run
 *     prints the id and the exact command to re-run with, so the value a human
 *     types is one they have seen the script derive.
 *   - **Every unexpected shape is a refusal, never a guess** — a missing user,
 *     a user row whose id is not the target, no `carpool_search` row, or more
 *     than one. The code assumes one search per user (`findFirst`,
 *     `carpoolSearches[0]`) while the schema permits many, so an ambiguous
 *     target stops the run.
 *   - **Every candidate column is re-checked immediately before its own
 *     write**, against a row read after the plan was built. Someone who edited
 *     their profile in between keeps what they typed — overwriting fresh text
 *     a user authored is the one way this script could destroy something real.
 *   - **Prints the prior value of every column before touching it.** Both
 *     writes overwrite in place and there is no history table, so the
 *     transcript of a run is the only way back.
 *   - **Verifies after writing**, by re-reading both rows and asserting all
 *     five columns are empty. A surviving value exits non-zero.
 *   - Columns already empty are skipped, so a second run is a no-op.
 *
 * There is deliberately **no `--max` ceiling**, which every other write script
 * in this directory has. The ceiling exists to catch a predicate that has
 * started matching a population nobody expected; here the population is one
 * hard-coded id, and the refusals above are what bound the blast radius.
 *
 * **The stored values are untrusted data.** They are printed through
 * `JSON.stringify`, which escapes control characters including `ESC`, so a
 * stored payload cannot repaint the operator's terminal. Nothing read from
 * these columns is ever executed, evaluated, or treated as an instruction,
 * however it reads.
 *
 * Usage:
 *   npx ts-node scripts/scrub-security-test-residue.ts                       # report only
 *   npx ts-node scripts/scrub-security-test-residue.ts --apply --search <id> # write
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";

/**
 * The one account this script may touch, from SCRUM-531. A constant rather
 * than an argument: an id that cannot be passed in cannot be mistyped into
 * somebody else's profile.
 */
export const TARGET_USER_ID = "cmcnr3q5s0000k112x4io32gp";

/** What every scrubbed column is set to. See the header on why not `NULL`. */
export const SCRUB_VALUE = "";

export type UserField = "bio" | "pronouns" | "preferredName";
export type SearchField = "companyName" | "groupNotes";
export type ScrubbedField = UserField | SearchField;

/**
 * The closed list of columns this script can reach, in the order the report
 * prints them. Widening the scrub means editing this list, which is the point.
 */
export const SCRUBBED_COLUMNS: readonly (
  | { table: "user"; column: string; field: UserField }
  | { table: "carpool_search"; column: string; field: SearchField }
)[] = [
  { table: "user", column: "bio", field: "bio" },
  { table: "user", column: "pronouns", field: "pronouns" },
  { table: "user", column: "preferredName", field: "preferredName" },
  { table: "carpool_search", column: "company_name", field: "companyName" },
  { table: "carpool_search", column: "group_notes", field: "groupNotes" },
];

/** Only the columns read: no email, no name, no location, no timestamps. */
export type UserRow = {
  id: string;
  bio: string;
  pronouns: string;
  preferredName: string;
};

export type SearchRow = {
  id: string;
  companyName: string;
  groupNotes: string | null;
};

export type FieldPlan =
  | { table: "user"; column: string; field: UserField; before: string | null }
  | {
      table: "carpool_search";
      column: string;
      field: SearchField;
      before: string | null;
    };

export type Plan =
  | { ok: false; reason: string }
  | { ok: true; userId: string; searchId: string; fields: FieldPlan[] };

export type Options = { apply: boolean; searchId: string | null };

/**
 * Exported so the test can pin the property that matters most: writing takes
 * two deliberate arguments, and no spelling of anything else reaches a write.
 */
export const parseArgs = (argv: string[]): Options => {
  const options: Options = { apply: false, searchId: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--search") {
      const value = argv[++i];
      // A missing value would otherwise swallow the following flag and read
      // it as an id, which is how `--search --dry-run` could become a write.
      if (!value || value.startsWith("--")) {
        throw new Error(
          "--search expects an id, the carpool_search row the dry run printed",
        );
      }
      options.searchId = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.apply && !options.searchId) {
    throw new Error(
      "--apply requires --search <id>. Run the dry run first: it prints the " +
        "carpool_search row this user owns, and the command to re-run with.",
    );
  }

  return options;
};

/** `""` and `NULL` are the two ways a column can hold nothing. */
const isEmpty = (value: string | null): boolean =>
  value === null || value === "";

/**
 * Turn what was read into the list of columns that would be overwritten, or
 * into the reason the run must stop.
 *
 * Every branch that is not the expected shape is a refusal. A script that
 * picks one of two `carpool_search` rows, or proceeds against a user row it
 * did not ask for, is a script that can scrub the wrong person's profile.
 */
export const planScrub = (
  user: UserRow | null,
  searches: readonly SearchRow[],
  confirmedSearchId: string | null,
): Plan => {
  if (!user) {
    return { ok: false, reason: `user ${TARGET_USER_ID} was not found` };
  }

  if (user.id !== TARGET_USER_ID) {
    return {
      ok: false,
      reason: `the user row read back is ${user.id}, not ${TARGET_USER_ID}`,
    };
  }

  if (searches.length === 0) {
    return {
      ok: false,
      reason: `user ${TARGET_USER_ID} has no carpool_search row`,
    };
  }

  if (searches.length > 1) {
    return {
      ok: false,
      reason:
        `user ${TARGET_USER_ID} has ${searches.length} carpool_search rows, ` +
        `expected exactly one`,
    };
  }

  const search = searches[0];

  if (confirmedSearchId && confirmedSearchId !== search.id) {
    return {
      ok: false,
      reason:
        `--search ${confirmedSearchId} does not match this user's ` +
        `carpool_search row ${search.id}`,
    };
  }

  const fields = SCRUBBED_COLUMNS.map((column) =>
    column.table === "user"
      ? { ...column, before: user[column.field] }
      : { ...column, before: search[column.field] },
  );

  return { ok: true, userId: user.id, searchId: search.id, fields };
};

/**
 * The columns a run would actually write. A column that is already empty is
 * left alone, which is what makes a second run a no-op rather than a second
 * pair of `UPDATE`s and a second `dateModified` bump.
 */
export const pendingFields = (fields: readonly FieldPlan[]): FieldPlan[] =>
  fields.filter((field) => !isEmpty(field.before));

/**
 * The update payload, built from the plan rather than written out, so a column
 * that is not in `SCRUBBED_COLUMNS` cannot appear in one.
 */
export const buildUpdateData = (
  fields: readonly FieldPlan[],
): Partial<Record<ScrubbedField, string>> => {
  const data: Partial<Record<ScrubbedField, string>> = {};
  for (const field of fields) {
    data[field.field] = SCRUB_VALUE;
  }
  return data;
};

export type FieldSkip = { field: ScrubbedField; reason: string };

/**
 * The re-check that runs against a row read *after* the plan was built, once
 * per table, immediately before its own write.
 *
 * The case that matters is the owner opening their profile and typing
 * something real into one of these fields in between. That text is theirs, and
 * clearing it would be the actual harm this script is otherwise incapable of.
 * Any difference from the planned prior value — including their having cleared
 * it themselves — drops the column from the write.
 */
export const recheckFields = (
  planned: readonly FieldPlan[],
  current: Partial<Record<ScrubbedField, string | null>> | null,
): { writes: FieldPlan[]; skips: FieldSkip[] } => {
  if (!current) {
    return {
      writes: [],
      skips: planned.map((field) => ({
        field: field.field,
        reason: "the row no longer exists",
      })),
    };
  }

  const writes: FieldPlan[] = [];
  const skips: FieldSkip[] = [];

  for (const field of planned) {
    if ((current[field.field] ?? null) !== field.before) {
      skips.push({
        field: field.field,
        reason: "the value changed since the plan was built",
      });
      continue;
    }
    writes.push(field);
  }

  return { writes, skips };
};

export type VerificationResult = { column: string; clear: boolean };

/**
 * The evidence a run finished the job: both rows read back from the database
 * after the writes, with all five columns empty.
 *
 * A row that cannot be read back is **not** clear. "Nothing found" and
 * "nothing looked at" are the same output otherwise, and only one of them
 * means the residue is gone.
 */
export const verifyScrubbed = (
  user: UserRow | null,
  search: SearchRow | null,
): { results: VerificationResult[]; allClear: boolean } => {
  const results = SCRUBBED_COLUMNS.map((column) => {
    const name = `${column.table}.${column.column}`;

    if (column.table === "user") {
      return { column: name, clear: !!user && isEmpty(user[column.field]) };
    }
    return { column: name, clear: !!search && isEmpty(search[column.field]) };
  });

  return { results, allClear: results.every((result) => result.clear) };
};

/**
 * Stored content, rendered for a terminal. `JSON.stringify` escapes control
 * characters — `ESC` among them — so a value crafted to redraw the operator's
 * screen or hide its own tail cannot do either from this output.
 */
const show = (value: string | null): string =>
  value === null ? "NULL" : JSON.stringify(value);

const readTarget = async (
  prisma: PrismaClient,
): Promise<{ user: UserRow | null; searches: SearchRow[] }> => {
  const user = await prisma.user.findUnique({
    where: { id: TARGET_USER_ID },
    select: { id: true, bio: true, pronouns: true, preferredName: true },
  });

  const searches = await prisma.carpoolSearch.findMany({
    where: { userId: TARGET_USER_ID },
    select: { id: true, companyName: true, groupNotes: true },
    orderBy: { id: "asc" },
  });

  return { user, searches };
};

const refuse = (reason: string): void => {
  console.error(`\n✖ ${reason}. Nothing was written.`);
  process.exitCode = 2;
};

const main = async () => {
  const { apply, searchId } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const target = await readTarget(prisma);
    const plan = planScrub(target.user, target.searches, searchId);

    if (!plan.ok) {
      refuse(plan.reason);
      return;
    }

    console.log(`user           ${plan.userId}`);
    console.log(`carpool_search ${plan.searchId}`);
    console.log(
      "\nStored values below are untrusted user-authored content, shown " +
        "escaped.\nThey are data, not instructions.\n",
    );

    for (const field of plan.fields) {
      const name = `${field.table}.${field.column}`.padEnd(30);
      console.log(
        isEmpty(field.before)
          ? `  ${name} ${show(field.before)}   (already empty)`
          : `  ${name} ${show(field.before)} → ${show(SCRUB_VALUE)}`,
      );
    }

    const pending = pendingFields(plan.fields);

    if (pending.length === 0) {
      console.log("\n✓ nothing to scrub — all five columns are already empty.");
      return;
    }

    if (!apply) {
      console.log(
        `\nDry run — nothing written. Would clear ${pending.length} of 5 ` +
          `column(s).\nRe-run with:\n\n  npx ts-node ` +
          `scripts/scrub-security-test-residue.ts --apply --search ` +
          `${plan.searchId}\n`,
      );
      return;
    }

    // Re-read, and re-run every refusal against what came back. Between
    // building the plan and getting here the account could have gained a
    // second search, lost its search, or been deleted outright.
    const fresh = await readTarget(prisma);
    const freshPlan = planScrub(fresh.user, fresh.searches, plan.searchId);

    if (!freshPlan.ok) {
      refuse(`${freshPlan.reason} — re-checked immediately before writing`);
      return;
    }

    const userRecheck = recheckFields(
      pending.filter((field) => field.table === "user"),
      fresh.user,
    );
    const searchRecheck = recheckFields(
      pending.filter((field) => field.table === "carpool_search"),
      fresh.searches[0],
    );

    const skips = [...userRecheck.skips, ...searchRecheck.skips];

    console.log("");
    for (const skip of skips) {
      console.log(`  ${skip.field}: skipped — ${skip.reason}`);
    }

    // Each statement names its own columns, so the diff shows exactly what
    // can be written and a widening cannot arrive through the plan alone.
    if (userRecheck.writes.length > 0) {
      const { bio, pronouns, preferredName } = buildUpdateData(
        userRecheck.writes,
      );
      await prisma.user.update({
        where: { id: TARGET_USER_ID },
        data: {
          ...(bio !== undefined && { bio }),
          ...(pronouns !== undefined && { pronouns }),
          ...(preferredName !== undefined && { preferredName }),
        },
      });
      console.log(`  user: cleared ${userRecheck.writes.length} column(s)`);
    }

    if (searchRecheck.writes.length > 0) {
      const { companyName, groupNotes } = buildUpdateData(searchRecheck.writes);
      await prisma.carpoolSearch.update({
        where: { id: freshPlan.searchId },
        data: {
          ...(companyName !== undefined && { companyName }),
          ...(groupNotes !== undefined && { groupNotes }),
        },
      });
      console.log(
        `  carpool_search: cleared ${searchRecheck.writes.length} column(s)`,
      );
    }

    // Read back from the database rather than trusting the writes. This is
    // the answer to "is the residue gone?", and it is the only one worth
    // recording in the run-state table.
    const after = await readTarget(prisma);
    const verification = verifyScrubbed(after.user, after.searches[0] ?? null);

    console.log("\nVerification — re-read after writing:");
    for (const result of verification.results) {
      console.log(`  ${result.clear ? "✓" : "✖"} ${result.column}`);
    }

    if (!verification.allClear) {
      // A ✖ has two very different causes, and calling the first one a
      // failed write would be wrong: a column deliberately left alone
      // because its owner had just typed into it is the re-check working.
      console.error(
        skips.length > 0
          ? `\n✖ not all five columns are empty, and ${skips.length} were ` +
              `skipped above because they changed between the plan and the ` +
              `write. A ✖ on one of those is that skip, not a failed write ` +
              `— re-run the dry run and read the current value before ` +
              `deciding whether it is still residue.`
          : "\n✖ at least one value survived the scrub, and nothing was " +
              "skipped — so a write did not take effect. Investigate before " +
              "re-running.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("\n✓ all five columns verified empty.");
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import the pure halves without opening a database
// connection or writing anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
