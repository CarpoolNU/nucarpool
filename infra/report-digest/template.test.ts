import { readFileSync } from "fs";
import { join } from "path";
import { REPORT_DIGEST_SCHEDULE } from "../../src/server/reportDigestWindow";

/**
 * The deploy template, checked for the handful of facts that are stated twice.
 *
 * **A CloudFormation template is configuration and mostly not worth testing**
 * — asserting that a `MemorySize` is 512 only restates the file. What is worth
 * testing is every place the template repeats something the TypeScript already
 * decides, because those are the pairs that drift silently and whose drift is
 * only discovered in production.
 *
 * There are five:
 *
 *   - the schedule, which `REPORT_DIGEST_SCHEDULE.eventBridge` owns;
 *   - the handler path, which the packaging script's output layout owns;
 *   - the From address, which `generateAdminReportDigestEmailParams` owns;
 *   - the architecture, which `prisma/schema.prisma`'s `binaryTargets` owns;
 *   - the environment, which the handler's import graph owns.
 *
 * Read as text rather than parsed as YAML, deliberately. Parsing would need a
 * YAML library with CloudFormation tag support that this repository does not
 * depend on, and every assertion here is about one scalar appearing in the
 * file. The weakness is honest: this proves the string is present, not that
 * CloudFormation accepts the document. Nothing offline can establish the
 * latter — see the header of `template.yaml`.
 */

const TEMPLATE = readFileSync(join(__dirname, "template.yaml"), "utf8");

describe("the schedule matches the one the code records", () => {
  it("carries REPORT_DIGEST_SCHEDULE.eventBridge as the default", () => {
    // Anchored to the parameter's Default line rather than searched for
    // anywhere in the file, so a copy of the expression in a comment cannot
    // satisfy this.
    expect(TEMPLATE).toContain(
      `    Default: ${REPORT_DIGEST_SCHEDULE.eventBridge}\n`,
    );
  });

  it("states the timezone the expression is written in", () => {
    // The expression's hour is a UTC hour. A stack that resolved it in another
    // zone would send the digest at the wrong time without failing anything.
    expect(TEMPLATE).toContain("ScheduleExpressionTimezone: UTC");
  });

  it("does not also hardcode the crontab spelling, which Scheduler rejects", () => {
    // `0 12 * * 1` is the five-field form for a different kind of scheduler.
    // Pasting it into ScheduleExpression is the obvious mistake here, and
    // Scheduler would reject `*` in both day fields rather than silently
    // misfire — but it would reject it at deploy time, which is later than
    // this.
    expect(TEMPLATE).not.toContain(
      `Default: cron(${REPORT_DIGEST_SCHEDULE.cron})`,
    );
    expect(TEMPLATE).not.toContain(
      `ScheduleExpression: ${REPORT_DIGEST_SCHEDULE.cron}`,
    );
  });
});

describe("it points at what the packaging script actually produces", () => {
  it("names the bundle's directory as CodeUri", () => {
    // `scripts/package-report-digest-lambda.sh` writes
    // build/report-digest-lambda/dist, relative to the repository root; this
    // path is relative to the template.
    expect(TEMPLATE).toContain(
      "CodeUri: ../../build/report-digest-lambda/dist",
    );
  });

  it("names index.handler, which is the bundle's entry point", () => {
    // esbuild writes the bundle to index.js and `handler` is exported from it.
    expect(TEMPLATE).toContain("Handler: index.handler");
  });

  it("pins x86_64, which is the only architecture the shipped engine runs on", () => {
    // The package carries Prisma's rhel-openssl-3.0.x engine. arm64 would
    // need linux-arm64-openssl-3.0.x generated and shipped instead, and the
    // mismatch would appear as a failure on the first query rather than at
    // deploy time.
    expect(TEMPLATE).toContain("Architectures: [x86_64]");
  });
});

describe("the IAM policy is scoped to the one thing the job does", () => {
  it("grants only ses:SendTemplatedEmail", () => {
    const actions = TEMPLATE.match(/Action: \S+/g) ?? [];
    expect(actions).toEqual(["Action: ses:SendTemplatedEmail"]);
  });

  it("scopes the grant to the digest's own From address", () => {
    // The address `generateAdminReportDigestEmailParams` sets. A condition that
    // named a different one would deny every send at runtime.
    expect(TEMPLATE).toContain("ses:FromAddress: no-reply@carpoolnu.com");
  });
});

describe("a failed or missed run is observable", () => {
  it("alarms on the Errors metric, which is what a thrown handler increments", () => {
    expect(TEMPLATE).toContain("MetricName: Errors");
  });

  /**
   * The missed-run alarm is the one with a subtle failure mode, so it gets the
   * specific assertion rather than a presence check.
   *
   * Lambda publishes no `Invocations` datapoint at all when nothing invokes the
   * function. A `LessThanThreshold` rule on a metric with no data sits in
   * `INSUFFICIENT_DATA` and never fires — so `TreatMissingData: breaching` is
   * not a tuning choice here, it is the entire mechanism. Losing that line
   * would leave an alarm that looks right and can never trigger, which is
   * exactly the invisible failure this alarm exists to catch.
   */
  it("treats missing Invocations data as breaching", () => {
    const missedRun = TEMPLATE.slice(TEMPLATE.indexOf("MissedRunAlarm:"));

    expect(missedRun).toContain("MetricName: Invocations");
    expect(missedRun).toContain("TreatMissingData: breaching");
    expect(missedRun).toContain("ComparisonOperator: LessThanThreshold");
  });

  it("dead-letters an invocation Scheduler could not deliver", () => {
    expect(TEMPLATE).toContain("DeadLetterConfig:");
    expect(TEMPLATE).toContain("Type: AWS::SQS::Queue");
  });

  it("routes every alarm to the notification topic", () => {
    const alarms = TEMPLATE.match(/Type: AWS::CloudWatch::Alarm/g) ?? [];
    const actions = TEMPLATE.match(/AlarmActions:/g) ?? [];

    expect(alarms).toHaveLength(3);
    expect(actions).toHaveLength(alarms.length);
  });
});

describe("the function's environment is what the handler reads, and no more", () => {
  /**
   * The variable names under `Environment.Variables`, in order. Sliced to the
   * block and matched at its indentation, so a variable named in a comment or
   * a parameter description elsewhere in the file cannot count.
   */
  const functionVariables = () => {
    const start = TEMPLATE.indexOf("        Variables:\n");
    const end = TEMPLATE.indexOf("      Policies:\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return [
      ...TEMPLATE.slice(start, end).matchAll(/^ {10}([A-Z][A-Z0-9_]*):/gm),
    ].map((match) => match[1]);
  };

  it("sets exactly DATABASE_URL, NEXT_PUBLIC_ENV, REGION_AWS and NODE_OPTIONS", () => {
    // `environment.test.ts` loads the handler with the first three and shows
    // they are enough; NODE_OPTIONS only turns on source maps. Anything added
    // here should be something the handler's graph genuinely reads.
    expect(functionVariables()).toEqual([
      "DATABASE_URL",
      "NEXT_PUBLIC_ENV",
      "REGION_AWS",
      "NODE_OPTIONS",
    ]);
  });

  it("no longer declares the four NEXT_PUBLIC_* values the digest never read", () => {
    // SCRUM-739. They were required only because `emailParams.ts` imported
    // `browserEnv`, which validates all five as one group.
    for (const name of [
      "MapboxAccessToken",
      "MixpanelProjectToken",
      "PusherKey",
      "PusherCluster",
      "NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN",
      "NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN",
      "NEXT_PUBLIC_PUSHER_KEY",
      "NEXT_PUBLIC_PUSHER_CLUSTER",
    ]) {
      expect(TEMPLATE).not.toContain(name);
    }
  });

  it("carries no AWS credential, which comes from the execution role", () => {
    for (const name of [
      "ACCESS_KEY_ID_AWS",
      "SECRET_ACCESS_KEY_AWS",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(functionVariables()).not.toContain(name);
    }
  });
});
