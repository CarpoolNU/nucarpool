import { Prisma, Role, Status } from "@prisma/client";
import { integrationPrisma } from "../src/testing/integrationDatabase";
import { isProvablyDstWritten } from "../src/server/db/dstScheduleIntegrity";
import { repairStatement, toSqlDateTime } from "./repair-dst-schedule-times";

/**
 * The DST repair's compare-and-swap against real MySQL (SCRUM-726).
 *
 * Only MySQL can answer what the statement *means*: a bound string compared
 * with a `TIME(0)` column and a `datetime(3)` one, and whether the row count it
 * returns is the current committed row's or something else. The unit suite
 * pins the statement's shape and drives the loop against a fake; this is where
 * the predicates are shown to refuse the writes they exist to refuse.
 *
 * The stale-value cases are the reason the values are in the `WHERE` at all.
 * A raw `UPDATE` bypasses `@updatedAt`, so a schedule can change while
 * `date_modified` stands still, and a swap keyed on the timestamp alone would
 * then overwrite it with a value computed from what it replaced.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

/** What the plan read: inside one 2026 DST window, before the fix cutoff. */
const PLANNED_DATE_MODIFIED = new Date("2026-07-15T12:34:56.789Z");
const DATE_CREATED = new Date("2026-07-01T09:00:00.000Z");

/** The stamp a run would choose, past the fix cutoff. */
const STAMP = new Date("2026-11-17T15:00:00.123Z");

const storedAt = (hour: number, minute = 0) =>
  new Date(Date.UTC(1970, 0, 1, hour, minute, 0));

/** A search holding 13:00-21:00 with the planned timestamps, and its id. */
const seedPlannedSearch = async (): Promise<string> => {
  const user = await prisma.user.create({
    data: {
      name: "Planned",
      email: "planned@northeastern.edu",
      isOnboarded: true,
    },
  });
  const location = () =>
    prisma.location.create({
      data: {
        city: "Boston",
        state: "MA",
        street: "Congress St",
        streetAddress: "1 Congress St",
        coordLng: -71.05,
        coordLat: 42.36,
      },
    });
  const [home, company] = [await location(), await location()];
  const search = await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: Role.DRIVER,
      status: Status.ACTIVE,
      homeLocationId: home.id,
      companyLocationId: company.id,
      startTime: storedAt(13),
      endTime: storedAt(21),
    },
  });

  // Set raw so neither `@default(now())` nor `@updatedAt` decides them.
  await prisma.$executeRaw`
    UPDATE carpool_search
    SET date_created = ${toSqlDateTime(DATE_CREATED)},
        date_modified = ${toSqlDateTime(PLANNED_DATE_MODIFIED)}
    WHERE id = ${search.id}
  `;

  return search.id;
};

const readRow = (id: string) =>
  prisma.carpoolSearch.findUniqueOrThrow({
    where: { id },
    select: {
      startTime: true,
      endTime: true,
      dateCreated: true,
      dateModified: true,
    },
  });

/** The repair, keyed on the plan as `seedPlannedSearch` left it. */
const repair = (id: string, stampedAt: Date = STAMP) =>
  prisma.$executeRaw(
    repairStatement(
      {
        id,
        startTime: storedAt(13),
        endTime: storedAt(21),
        dateModified: PLANNED_DATE_MODIFIED,
      },
      { startTime: storedAt(14), endTime: storedAt(22) },
      stampedAt,
    ),
  );

/** The rollback exactly as the manifest's instructions write it. */
const rollback = (id: string) => prisma.$executeRaw`
  UPDATE carpool_search
  SET start_time = ${"13:00:00"}, end_time = ${"21:00:00"}
  WHERE id = ${id}
    AND start_time = ${"14:00:00"} AND end_time = ${"22:00:00"}
    AND date_modified = ${toSqlDateTime(STAMP)}
`;

describe("repairStatement against MySQL", () => {
  it("repairs a row that still matches the plan, and stamps it exactly", async () => {
    const id = await seedPlannedSearch();

    expect(await repair(id)).toBe(1);

    const row = await readRow(id);
    expect(row.startTime?.toISOString()).toBe(storedAt(14).toISOString());
    expect(row.endTime?.toISOString()).toBe(storedAt(22).toISOString());
    // To the millisecond: this is the value the rollback matches on.
    expect(row.dateModified.toISOString()).toBe(STAMP.toISOString());
  });

  it("cannot select the repaired row again", async () => {
    const id = await seedPlannedSearch();
    await repair(id);
    const row = await readRow(id);

    expect(
      isProvablyDstWritten({
        id,
        userId: "",
        role: Role.DRIVER,
        status: Status.ACTIVE,
        startDate: null,
        endDate: null,
        companyCoords: null,
        homeCoords: null,
        ...row,
      }),
    ).toBe(false);
  });

  describe("stale schedule values", () => {
    it.each([
      ["start_time", Prisma.sql`start_time = '12:00:00'`],
      ["end_time", Prisma.sql`end_time = '20:00:00'`],
    ])(
      "refuses a row whose %s changed while date_modified stood still",
      async (_column, assignment) => {
        const id = await seedPlannedSearch();
        // What a raw UPDATE or a console session does: no @updatedAt.
        await prisma.$executeRaw`
          UPDATE carpool_search SET ${assignment} WHERE id = ${id}
        `;
        const before = await readRow(id);
        expect(before.dateModified.toISOString()).toBe(
          PLANNED_DATE_MODIFIED.toISOString(),
        );

        expect(await repair(id)).toBe(0);
        expect(await readRow(id)).toEqual(before);
      },
    );

    it("refuses a row saved through Prisma, which moves date_modified", async () => {
      const id = await seedPlannedSearch();
      await prisma.carpoolSearch.update({
        where: { id },
        data: { companyName: "Edited" },
      });

      expect(await repair(id)).toBe(0);
      expect((await readRow(id)).startTime?.toISOString()).toBe(
        storedAt(13).toISOString(),
      );
    });

    it("refuses a date_modified one millisecond off", async () => {
      const id = await seedPlannedSearch();
      await prisma.$executeRaw`
        UPDATE carpool_search
        SET date_modified = ${toSqlDateTime(
          new Date(PLANNED_DATE_MODIFIED.getTime() + 1),
        )}
        WHERE id = ${id}
      `;

      expect(await repair(id)).toBe(0);
    });
  });

  describe("the manifest's rollback", () => {
    it("reverses a row this run wrote and nobody has touched since", async () => {
      const id = await seedPlannedSearch();
      await repair(id);

      expect(await rollback(id)).toBe(1);

      const row = await readRow(id);
      expect(row.startTime?.toISOString()).toBe(storedAt(13).toISOString());
      // date_modified is left at the stamp, so the row stays unselectable.
      expect(row.dateModified.toISOString()).toBe(STAMP.toISOString());
    });

    it("leaves alone an owner who retyped the same canonical value after the repair", async () => {
      // Their save stores exactly what the repair stored. A value-only
      // rollback would put the broken value back over what they typed.
      const id = await seedPlannedSearch();
      await repair(id);
      await prisma.carpoolSearch.update({
        where: { id },
        data: { startTime: storedAt(14), endTime: storedAt(22) },
      });

      expect(await rollback(id)).toBe(0);
      expect((await readRow(id)).startTime?.toISOString()).toBe(
        storedAt(14).toISOString(),
      );
    });

    it("matches nothing for a row whose write never landed", async () => {
      const id = await seedPlannedSearch();

      expect(await rollback(id)).toBe(0);
    });
  });
});
