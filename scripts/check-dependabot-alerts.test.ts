import { triage, DEFAULT_MAX_AGE_DAYS } from "./check-dependabot-alerts";

/**
 * Which open Dependabot alerts the staleness check calls stuck.
 *
 * `triage` is the whole decision this script exists to make, and the two ways
 * it can be wrong are not symmetric. Missing a stuck alert restores exactly the
 * silence the check was added to break — an advisory nobody is told about,
 * which is how three `brace-expansion` alerts sat for 25 days. Reporting one
 * that is fine is worse than it sounds too: a check that fails on alerts
 * nobody can act on gets ignored, and then it is not a check. So the negative
 * cases below carry as much weight as the positive ones.
 *
 * Every case fixes `now` explicitly. Age is elapsed-time arithmetic in whole
 * days, so these assertions hold identically under both time zones CI runs the
 * suite in — there is no wall-clock reading anywhere in the decision.
 */

/** An instant to measure every fixture against. Arbitrary, but fixed. */
const NOW = new Date("2026-10-26T12:00:00Z");

/** `days` before `NOW`, as the API's `created_at` string. */
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * A raw alert in the shape `GET /repos/{owner}/{repo}/dependabot/alerts`
 * returns, trimmed to the fields `summarise` reads.
 *
 * Built as the nested API shape rather than the flat summary, so these cases
 * exercise the extraction too. A field renamed in `summarise` without the
 * fixture following breaks here, which is the point.
 */
const alert = (overrides: {
  number: number;
  state?: string;
  ageDays?: number;
  severity?: string;
  ghsaId?: string;
  package?: string;
  scope?: string | null;
  firstPatchedVersion?: string | null;
}) => ({
  number: overrides.number,
  state: overrides.state ?? "open",
  created_at: daysAgo(overrides.ageDays ?? 0),
  html_url: `https://github.com/CarpoolNU/nucarpool/security/dependabot/${overrides.number}`,
  security_advisory: {
    ghsa_id: overrides.ghsaId ?? `GHSA-fake-${overrides.number}`,
    severity: overrides.severity ?? "high",
    summary: "A fixture advisory",
  },
  security_vulnerability: {
    first_patched_version:
      overrides.firstPatchedVersion === null
        ? null
        : { identifier: overrides.firstPatchedVersion ?? "1.2.3" },
  },
  dependency: {
    package: { name: overrides.package ?? "brace-expansion" },
    scope: overrides.scope === undefined ? "development" : overrides.scope,
  },
});

const run = (
  alerts: ReturnType<typeof alert>[],
  options: { maxAgeDays?: number; retained?: unknown[] } = {},
) =>
  triage(alerts, {
    now: NOW,
    maxAgeDays: options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    // Defaulted to empty rather than left to the script's own `RETAINED`, so a
    // real retention added later cannot silently change what these cases mean.
    retained: options.retained ?? [],
  } as never);

describe("triage", () => {
  describe("which alerts it looks at", () => {
    it("reports nothing for an empty alert list", () => {
      const result = run([]);

      expect(result.open).toBe(0);
      expect(result.stuck).toEqual([]);
      expect(result.pending).toEqual([]);
    });

    it("ignores every settled state, however old", () => {
      // The live list is almost entirely `fixed`: 143 of 145 at the time this
      // was written. Counting those would make the check fail permanently on
      // history, so the state filter is what makes it usable at all.
      const result = run([
        alert({ number: 1, state: "fixed", ageDays: 400 }),
        alert({ number: 2, state: "dismissed", ageDays: 400 }),
        alert({ number: 3, state: "auto_dismissed", ageDays: 400 }),
      ]);

      expect(result.open).toBe(0);
      expect(result.stuck).toEqual([]);
    });

    it("counts an open alert whatever its age", () => {
      const result = run([
        alert({ number: 1, ageDays: 0 }),
        alert({ number: 2, ageDays: 400 }),
      ]);

      expect(result.open).toBe(2);
    });
  });

  describe("the age threshold", () => {
    it("calls an alert stuck once it reaches the threshold", () => {
      const result = run([alert({ number: 1, ageDays: 14 })], {
        maxAgeDays: 14,
      });

      expect(result.stuck.map((a: { number: number }) => a.number)).toEqual([
        1,
      ]);
      expect(result.pending).toEqual([]);
    });

    it("leaves an alert one day short of the threshold pending", () => {
      // The boundary in the other direction. An off-by-one here is the
      // difference between a check that fires a week early and one that is
      // correct, and neither shows up in a run against a clean alert list.
      const result = run([alert({ number: 1, ageDays: 13 })], {
        maxAgeDays: 14,
      });

      expect(result.stuck).toEqual([]);
      expect(result.pending.map((a: { number: number }) => a.number)).toEqual([
        1,
      ]);
    });

    it("honours a threshold passed in place of the default", () => {
      const alerts = [alert({ number: 1, ageDays: 20 })];

      expect(run(alerts, { maxAgeDays: 30 }).stuck).toEqual([]);
      expect(run(alerts, { maxAgeDays: 7 }).stuck).toHaveLength(1);
    });

    it("reports an alert with no patched version like any other", () => {
      // An advisory with no fix yet cannot be cleared by any lockfile refresh,
      // so it is exactly the kind that sits open. It is still a finding: the
      // decision it needs is a retention entry, not silence.
      const result = run(
        [alert({ number: 1, ageDays: 90, firstPatchedVersion: null })],
        { maxAgeDays: 14 },
      );

      expect(result.stuck).toHaveLength(1);
      expect(result.stuck[0].firstPatchedVersion).toBeNull();
    });
  });

  describe("alerts retained on purpose", () => {
    const retention = {
      ghsaId: "GHSA-known-0001",
      package: "postcss",
      reason: "Reachable only through next's nested copy; needs a resolution.",
      reviewBy: "2026-12-01",
    };

    it("keeps a retained alert out of the stuck list", () => {
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: retention.ghsaId,
            package: retention.package,
          }),
        ],
        { retained: [retention] },
      );

      expect(result.stuck).toEqual([]);
      expect(result.retained).toHaveLength(1);
      expect(result.retained[0].reason).toBe(retention.reason);
    });

    it("returns an expired retention to the stuck list, saying so", () => {
      // The reason `reviewBy` is required. A retention that outlives its review
      // date is a decision nobody has revisited, which is strictly worse than
      // an alert nobody has triaged — it looks handled.
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: retention.ghsaId,
            package: retention.package,
          }),
        ],
        { retained: [{ ...retention, reviewBy: "2026-01-01" }] },
      );

      expect(result.retained).toEqual([]);
      expect(result.stuck).toHaveLength(1);
      expect(result.stuck[0].expiredRetention.reviewBy).toBe("2026-01-01");
    });

    it("treats an unparseable review date as expired", () => {
      // The one way a retention could have become permanent. `new Date` on a
      // malformed date gives Invalid Date, every comparison against NaN is
      // false, and reading that as "not expired yet" would make a typo
      // indistinguishable from a decision — holding the alert quiet forever,
      // which is precisely what `reviewBy` exists to stop.
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: retention.ghsaId,
            package: retention.package,
          }),
        ],
        { retained: [{ ...retention, reviewBy: "31-12-2026" }] },
      );

      expect(result.retained).toEqual([]);
      expect(result.stuck).toHaveLength(1);
    });

    it("expires a retention on its review date, not a day after it", () => {
      // "Review by the 1st" means it is due on the 1st. An off-by-one here
      // buys a day of silence nobody asked for.
      const onTheDay = { ...retention, reviewBy: "2026-10-26" };
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: retention.ghsaId,
            package: retention.package,
          }),
        ],
        { retained: [onTheDay] },
      );

      expect(result.retained).toEqual([]);
      expect(result.stuck).toHaveLength(1);
    });

    it("does not quiet the same advisory against a different package", () => {
      // One advisory can raise an alert against several packages. Keying the
      // retention on the GHSA alone would suppress all of them, retiring an
      // alert nobody decided anything about.
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: retention.ghsaId,
            package: "some-other-package",
          }),
        ],
        { retained: [retention] },
      );

      expect(result.retained).toEqual([]);
      expect(result.stuck).toHaveLength(1);
    });

    it("does not quiet a different advisory against the same package", () => {
      const result = run(
        [
          alert({
            number: 1,
            ageDays: 90,
            ghsaId: "GHSA-different-0002",
            package: retention.package,
          }),
        ],
        { retained: [retention] },
      );

      expect(result.retained).toEqual([]);
      expect(result.stuck).toHaveLength(1);
    });
  });

  describe("the order findings are reported in", () => {
    it("sorts by severity first, then by age", () => {
      // A truncated read has to show the worst of it. Ordered by age alone, a
      // critical alert open for 15 days sits below a low one open for 200.
      const result = run(
        [
          alert({ number: 1, ageDays: 200, severity: "low" }),
          alert({ number: 2, ageDays: 15, severity: "critical" }),
          alert({ number: 3, ageDays: 20, severity: "high" }),
          alert({ number: 4, ageDays: 100, severity: "high" }),
        ],
        { maxAgeDays: 14 },
      );

      expect(result.stuck.map((a: { number: number }) => a.number)).toEqual([
        2, 4, 3, 1,
      ]);
    });

    it("sorts an unrecognised severity last rather than first", () => {
      // `SEVERITY_ORDER.indexOf` returns -1 for a name it does not know, and
      // -1 sorts above "critical". A severity GitHub adds later must not become
      // the top of every report by accident.
      const result = run(
        [
          alert({ number: 1, ageDays: 20, severity: "apocalyptic" }),
          alert({ number: 2, ageDays: 20, severity: "low" }),
        ],
        { maxAgeDays: 14 },
      );

      expect(result.stuck.map((a: { number: number }) => a.number)).toEqual([
        2, 1,
      ]);
    });
  });

  describe("what it reads off an alert", () => {
    it("carries the fields the report and the issue body need", () => {
      const result = run(
        [
          alert({
            number: 42,
            ageDays: 30,
            severity: "medium",
            ghsaId: "GHSA-cccc-dddd-eeee",
            package: "brace-expansion",
            scope: "development",
            firstPatchedVersion: "1.1.21",
          }),
        ],
        { maxAgeDays: 14 },
      );

      expect(result.stuck[0]).toMatchObject({
        number: 42,
        severity: "medium",
        ghsaId: "GHSA-cccc-dddd-eeee",
        package: "brace-expansion",
        scope: "development",
        firstPatchedVersion: "1.1.21",
        ageDays: 30,
      });
    });

    it("does not invent a scope GitHub did not attribute", () => {
      // Defaulting a missing scope to "runtime" would overstate the blast
      // radius and to "development" would understate it; neither is a reading
      // of the data.
      const result = run([alert({ number: 1, ageDays: 30, scope: null })], {
        maxAgeDays: 14,
      });

      expect(result.stuck[0].scope).toBe("unknown");
    });
  });
});
