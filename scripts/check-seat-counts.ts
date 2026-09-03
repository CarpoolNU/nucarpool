/**
 * Report `CarpoolSearch` rows whose `seats_avail` is outside
 * `[0, MAX_SEATS_AVAILABLE]`.
 *
 * The invariant has been claimed in `carpoolSeats.ts` since it was written and
 * enforced by nothing: not the column (a plain `Int`; `UNSIGNED` and CHECK are
 * both a PlanetScale deploy-request exercise under `relationMode = "prisma"`,
 * and Prisma 4 cannot express a CHECK at all), not the router, and not any
 * script. `clampSeats` bounds computed values only on the release path.
 *
 * So when the accounting bugs SCRUM-229 fixed pushed a driver to `-1`, nothing
 * noticed, and nothing has since. That row was found by hand-written SQL a
 * year and a half later — still ACTIVE, still being offered to riders, still
 * refusing every one of them. **This script is the piece whose absence let
 * that happen**, which is why it exists even though the read path no longer
 * cares what the column holds.
 *
 * A negative count is the shape that has actually occurred. Above
 * MAX_SEATS_AVAILABLE is reported too and has never been seen: `user.edit`'s
 * Zod input and both profile forms cap it, and `releaseSeats` clamps. It is
 * here because "out of range" is one question and splitting it into two
 * invites the second one to go unasked.
 *
 * **Read-only. This script changes nothing.** The repair is
 * `repair-seat-residue.ts`, separately, because every `check-*` script in this
 * directory reports and stops — see the note in `scripts/README.md`.
 *
 * Usage:
 *   npx ts-node scripts/check-seat-counts.ts
 *
 * Exits 0 when every row is in range, 1 when any is not, so it can gate the
 * repair. **Run this against production**: the count there is unknown, because
 * read queries against the PlanetScale `main` branch return 403 with the
 * credentials available in this repository. One driver on staging is a lower
 * bound, not the answer.
 */

import { PrismaClient } from "@prisma/client";
import { findOutOfRangeSeatRows } from "../src/server/db/seatIntegrity";
import { MAX_SEATS_AVAILABLE } from "../src/utils/carpoolSeats";

/** Rows listed before the report truncates. */
const SAMPLE_SIZE = 20;

const main = async () => {
  if (process.argv.length > 2) {
    throw new Error(
      `unexpected argument(s): ${process.argv.slice(2).join(", ")}. ` +
        `This script takes none and only reads. The repair is ` +
        `repair-seat-residue.ts.`,
    );
  }

  const prisma = new PrismaClient();

  try {
    const rows = await prisma.carpoolSearch.findMany({
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        seatsAvail: true,
        carpoolId: true,
      },
    });

    const outOfRange = findOutOfRangeSeatRows(rows);

    console.log(`${rows.length} carpool search row(s)`);
    console.log(
      `${outOfRange.length} with seats_avail outside [0, ${MAX_SEATS_AVAILABLE}]`,
    );

    if (outOfRange.length === 0) {
      console.log(`\n✓ every seat count is in range.`);
      return;
    }

    // Negatives and overflows are counted separately because they say
    // different things: a negative is the residue of the old accounting, an
    // overflow would mean a cap is being bypassed somewhere and is a live bug
    // rather than a historical one.
    const negative = outOfRange.filter(({ row }) => row.seatsAvail < 0);
    const excessive = outOfRange.filter(
      ({ row }) => row.seatsAvail > MAX_SEATS_AVAILABLE,
    );

    for (const { row, repairTo } of outOfRange.slice(0, SAMPLE_SIZE)) {
      console.log(
        `\n    search   ${row.id}  seats_avail ${row.seatsAvail} → ${repairTo}`,
      );
      console.log(
        `      user   ${row.userId}  ${row.role}  ${row.status}` +
          `${row.carpoolId ? `  carpool ${row.carpoolId}` : ""}`,
      );
    }
    if (outOfRange.length > SAMPLE_SIZE) {
      console.log(`\n    ... and ${outOfRange.length - SAMPLE_SIZE} more`);
    }

    if (negative.length > 0) {
      console.log(
        `\n✖ ${negative.length} row(s) below zero. These are what the ` +
          `pre-SCRUM-229 seat accounting left behind. The read path no longer ` +
          `offers them — non-positive is unavailable everywhere now — so an ` +
          `ACTIVE driver here is not stuck in the dead end any more, but they ` +
          `are advertising no space at all until the count is repaired. ` +
          `Repair with repair-seat-residue.ts, then consider telling them to ` +
          `re-enter their seat count: the repair writes 0, not their capacity, ` +
          `which is not recoverable from the data.`,
      );
    }

    if (excessive.length > 0) {
      console.log(
        `\n✖ ${excessive.length} row(s) above ${MAX_SEATS_AVAILABLE}. This ` +
          `shape has never been observed and every write path caps it, so ` +
          `treat it as a live bug and find the writer before repairing — ` +
          `clamping first destroys the evidence.`,
      );
    }

    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import this module without opening a database
// connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
