import { Role } from "@prisma/client";
import {
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

  it("does not flag a VIEWER at (0, 0)", () => {
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
});
