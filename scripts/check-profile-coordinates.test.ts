import { Role } from "@prisma/client";
import {
  exitCodeFor,
  findProfileDataProblems,
  SearchRow,
} from "./check-profile-coordinates";

/**
 * The detection half of the check, tested without a database.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

const slot = (
  coordLng: number,
  coordLat: number,
  streetAddress = "12 Elm St",
) => ({
  id: `loc-${coordLng}-${coordLat}`,
  streetAddress,
  coordLng,
  coordLat,
});

const BOSTON = slot(-71.0589, 42.3601, "100 Congress St, Boston, MA");
const SOMERVILLE = slot(-71.0995, 42.3876, "12 Highland Ave, Somerville, MA");

const search = (overrides: Partial<SearchRow> = {}): SearchRow => ({
  id: "search-1",
  userId: "user-1",
  role: Role.RIDER,
  isOnboarded: true,
  startDate: new Date("2026-01-31T00:00:00.000Z"),
  endDate: new Date("2026-06-30T00:00:00.000Z"),
  homeLocation: SOMERVILLE,
  companyLocation: BOSTON,
  ...overrides,
});

describe("findProfileDataProblems", () => {
  it("reports nothing for a healthy row", () => {
    expect(findProfileDataProblems([search()])).toEqual([]);
  });

  it("handles an empty table", () => {
    expect(findProfileDataProblems([])).toEqual([]);
  });

  it("flags an unresolved home coordinate", () => {
    const [finding] = findProfileDataProblems([
      search({ homeLocation: slot(0, 0, "12 Highland Ave, Somerville, MA") }),
    ]);

    expect(finding.searchId).toBe("search-1");
    expect(finding.problems).toHaveLength(1);
    expect(finding.problems[0]).toContain("home coordinates unresolved");
    // The address is quoted so the remedy is identifiable without a second
    // query.
    expect(finding.problems[0]).toContain("12 Highland Ave, Somerville, MA");
  });

  it("says so when an unresolved row has no address either", () => {
    const [finding] = findProfileDataProblems([
      search({ companyLocation: slot(0, 0, "") }),
    ]);

    expect(finding.problems[0]).toContain("(no address stored)");
  });

  it("does not flag an onboarded VIEWER at (0, 0)", () => {
    // Expected for a VIEWER, and counting them would bury the real findings.
    expect(
      findProfileDataProblems([
        search({
          role: Role.VIEWER,
          homeLocation: slot(0, 0, ""),
          companyLocation: slot(0, 0, ""),
          startDate: null,
          endDate: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("flags an out-of-range coordinate whatever the role", () => {
    // Out of range is never legitimate, so the VIEWER exemption does not apply.
    const [finding] = findProfileDataProblems([
      search({ role: Role.VIEWER, homeLocation: slot(-71.05, 421.3) }),
    ]);

    expect(finding.problems[0]).toContain("home coordinates out of range");
  });

  it("reports out of range rather than unresolved when both could apply", () => {
    // Range is the stronger statement and the two messages would be redundant.
    const [finding] = findProfileDataProblems([
      search({ homeLocation: slot(0, -900) }),
    ]);

    expect(finding.problems).toEqual([
      "home coordinates out of range (0, -900)",
    ]);
  });

  it("flags a reversed co-op range", () => {
    const [finding] = findProfileDataProblems([
      search({
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(finding.problems).toEqual([
      "co-op range reversed: 2027-01-31 to 2026-01-31",
    ]);
  });

  it("accepts a single-month co-op", () => {
    const march = new Date("2026-03-31T00:00:00.000Z");
    expect(
      findProfileDataProblems([search({ startDate: march, endDate: march })]),
    ).toEqual([]);
  });

  it("flags a missing location row", () => {
    // `relationMode = \"prisma\"` emulates the foreign key, so the id can dangle.
    const [finding] = findProfileDataProblems([
      search({ companyLocation: null }),
    ]);

    expect(finding.problems).toEqual(["company location row is missing"]);
  });

  it("collects every problem on one row", () => {
    const [finding] = findProfileDataProblems([
      search({
        homeLocation: slot(0, 0, ""),
        companyLocation: slot(999, 999),
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(finding.problems).toHaveLength(3);
  });

  it("keeps only the rows with problems, and carries their identity", () => {
    const findings = findProfileDataProblems([
      search({ id: "ok-1", userId: "alice" }),
      search({ id: "bad-1", userId: "bob", homeLocation: slot(0, 0, "") }),
      search({ id: "ok-2", userId: "carol" }),
      search({ id: "bad-2", userId: "dave", companyLocation: slot(0, 0, "") }),
    ]);

    expect(findings.map((f) => f.searchId)).toEqual(["bad-1", "bad-2"]);
    expect(findings.map((f) => f.userId)).toEqual(["bob", "dave"]);
  });

  it("marks an unresolved coordinate actionable for an onboarded user", () => {
    const [finding] = findProfileDataProblems([
      search({ isOnboarded: true, homeLocation: slot(0, 0, "") }),
    ]);

    expect(finding.actionable).toBe(true);
  });

  it("still reports an unresolved coordinate for a non-onboarded user", () => {
    // Reported, so the population stays visible in the output rather than
    // disappearing. Just not actionable.
    const [finding] = findProfileDataProblems([
      search({ isOnboarded: false, homeLocation: slot(0, 0, "") }),
    ]);

    expect(finding.problems).toEqual([
      'home coordinates unresolved (0, 0) for "(no address stored)"',
    ]);
    expect(finding.isOnboarded).toBe(false);
    expect(finding.actionable).toBe(false);
  });

  it("keeps a reversed co-op range actionable for a non-onboarded user", () => {
    // An inverted range becomes live the moment that user comes back and
    // finishes, and no onboarding state makes it correct.
    const [finding] = findProfileDataProblems([
      search({
        isOnboarded: false,
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(finding.problems).toEqual([
      "co-op range reversed: 2027-01-31 to 2026-01-31",
    ]);
    expect(finding.actionable).toBe(true);
  });

  it("keeps a reversed co-op range actionable whatever the search status", () => {
    // Production holds 47 of these, 7 of them not ACTIVE. Status is not read
    // at all, and that is deliberate: a search reactivates without its dates
    // being touched, so the inverted range is waiting when it does.
    const [finding] = findProfileDataProblems([
      search({
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(finding.actionable).toBe(true);
  });

  it("is actionable when a non-onboarded row also has a reversed range", () => {
    // Both lines are reported; the reversed range is what makes the row
    // actionable and the unresolved coordinate rides along on the same report.
    const [finding] = findProfileDataProblems([
      search({
        isOnboarded: false,
        homeLocation: slot(0, 0, ""),
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(finding.problems).toHaveLength(2);
    expect(finding.actionable).toBe(true);
  });

  it("keeps an out-of-range coordinate actionable for a non-onboarded user", () => {
    // Only the (0, 0) sentinel is explained by an abandoned sign-up. A value
    // outside WGS 84 is not, whoever owns it.
    const [finding] = findProfileDataProblems([
      search({ isOnboarded: false, homeLocation: slot(-71.05, 421.3) }),
    ]);

    expect(finding.problems[0]).toContain("home coordinates out of range");
    expect(finding.actionable).toBe(true);
  });

  it("keeps a missing location row actionable for a non-onboarded user", () => {
    const [finding] = findProfileDataProblems([
      search({ isOnboarded: false, companyLocation: null }),
    ]);

    expect(finding.problems).toEqual(["company location row is missing"]);
    expect(finding.actionable).toBe(true);
  });

  it("does not flag a non-onboarded VIEWER at (0, 0) either", () => {
    // Excluded before onboarding is consulted, so it is absent rather than
    // present-but-not-actionable.
    expect(
      findProfileDataProblems([
        search({
          role: Role.VIEWER,
          isOnboarded: false,
          homeLocation: slot(0, 0, ""),
          companyLocation: slot(0, 0, ""),
          startDate: null,
          endDate: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("reports both populations from one pass, in table order", () => {
    // The shape of production: a large non-onboarded (0, 0) population and a
    // small actionable one, returned together so the run can print both.
    const findings = findProfileDataProblems([
      search({
        id: "noise-1",
        isOnboarded: false,
        homeLocation: slot(0, 0, ""),
      }),
      search({ id: "ok-1" }),
      search({
        id: "real-1",
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
      search({
        id: "noise-2",
        isOnboarded: false,
        companyLocation: slot(0, 0, ""),
      }),
    ]);

    expect(findings.map((f) => [f.searchId, f.actionable])).toEqual([
      ["noise-1", false],
      ["real-1", true],
      ["noise-2", false],
    ]);
  });
});

/**
 * SCRUM-550: 22 production searches store years like 1901 and 2069, and every
 * one runs forwards, so the reversed-range line above never named them. `now`
 * is pinned because the ceiling moves with the clock.
 */
describe("findProfileDataProblems — implausible co-op years", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it("flags production's commonest shape, actionably", () => {
    const [finding] = findProfileDataProblems(
      [search({ startDate: day("1901-01-31"), endDate: day("1908-06-30") })],
      now,
    );

    expect(finding.problems).toEqual([
      "co-op year implausible: 1901-01-31 to 1908-06-30 (allowed 2022–2036)",
    ]);
    expect(finding.actionable).toBe(true);
  });

  it("flags a year past the ceiling", () => {
    expect(
      findProfileDataProblems(
        [search({ startDate: day("2069-01-31"), endDate: day("2073-06-30") })],
        now,
      ),
    ).toHaveLength(1);
  });

  it("reports both lines for a range that is absurd and reversed", () => {
    const [finding] = findProfileDataProblems(
      [search({ startDate: day("1913-01-31"), endDate: day("1907-06-30") })],
      now,
    );

    expect(finding.problems).toEqual([
      "co-op range reversed: 1913-01-31 to 1907-06-30",
      "co-op year implausible: 1913-01-31 to 1907-06-30 (allowed 2022–2036)",
    ]);
  });

  it("keeps it actionable for a non-onboarded user", () => {
    const [finding] = findProfileDataProblems(
      [
        search({
          isOnboarded: false,
          startDate: day("1902-01-31"),
          endDate: day("1908-06-30"),
        }),
      ],
      now,
    );

    expect(finding.actionable).toBe(true);
  });

  it("does not flag a VIEWER, exactly as it does not flag one at (0, 0)", () => {
    expect(
      findProfileDataProblems(
        [
          search({
            role: Role.VIEWER,
            startDate: day("1901-01-31"),
            endDate: day("1906-06-30"),
          }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("accepts a range spanning exactly the bound", () => {
    expect(
      findProfileDataProblems(
        [search({ startDate: day("2022-01-31"), endDate: day("2036-12-31") })],
        now,
      ),
    ).toEqual([]);
  });
});

describe("exitCodeFor", () => {
  it("exits 0 on a clean database", () => {
    expect(exitCodeFor(findProfileDataProblems([search()]))).toBe(0);
  });

  it("exits 0 when every finding is a non-onboarded (0, 0) row", () => {
    // The staging shape, and 579 of production's 626. A gate that is
    // permanently red gates nothing, which is what SCRUM-408 fixes.
    const findings = findProfileDataProblems([
      search({
        id: "noise-1",
        isOnboarded: false,
        homeLocation: slot(0, 0, ""),
      }),
      search({
        id: "noise-2",
        isOnboarded: false,
        companyLocation: slot(0, 0, ""),
      }),
    ]);

    expect(findings).toHaveLength(2);
    expect(exitCodeFor(findings)).toBe(0);
  });

  it("exits 1 as soon as one finding is actionable", () => {
    const findings = findProfileDataProblems([
      search({
        id: "noise-1",
        isOnboarded: false,
        homeLocation: slot(0, 0, ""),
      }),
      search({
        id: "real-1",
        startDate: new Date("2027-01-31T00:00:00.000Z"),
        endDate: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ]);

    expect(exitCodeFor(findings)).toBe(1);
  });
});
