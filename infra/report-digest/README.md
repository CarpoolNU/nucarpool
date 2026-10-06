# Weekly report digest — the trigger

SCRUM-626. The digest itself is SCRUM-625's and lives in `src/server/`; this
directory is only what fires it every Monday.

```
EventBridge Scheduler  ──cron(0 12 ? * MON *)──▶  Lambda  ──▶  sendReportDigest()
         │                                          │               (unchanged)
         └── DLQ ──▶ alarm                           └── throws ──▶ Errors alarm
                                                     no invocation ──▶ missed-run alarm
```

| File                                      | What it is                                            |
| ----------------------------------------- | ----------------------------------------------------- |
| `handler.ts`                              | The adapter. Derives nothing, sends nothing itself.   |
| `template.yaml`                           | SAM: function, schedule, DLQ, three alarms, SNS topic |
| `handler.test.ts`                         | Which week, which payloads are refused, what throws   |
| `template.test.ts`                        | The four facts the template repeats from the code     |
| `scripts/package-report-digest-lambda.sh` | Builds the deployment package                         |

## Nothing here has been deployed

**This has never run in AWS.** It was written without AWS credentials, so it has
not been through `sam validate`, a change set or a deploy, and the first deploy
is also its first test. Read the change set rather than trusting the file, and
expect to fix something.

What _has_ been tested offline: the built bundle loads, exports `handler`, and
runs the real window derivation and the real delivery claim through to an
`already_sent` skip against a stub database. The packaging script produces a
7.6 MB zip. Both are reproducible with `yarn package:report-digest`.

## Why a Lambda rather than a GitHub Actions cron

Because of where the credentials end up. A scheduled workflow needs the
production `DATABASE_URL` and the three suffixed AWS keys as repository secrets
— a set this repository deliberately has none of today, reachable by every
workflow in it. The Lambda needs **no AWS credential at all**: its execution
role carries `ses:SendTemplatedEmail` for one From address and nothing else, and
the SDK resolves it from the role. The one secret it does need is the database
URL, which is the same value Amplify already holds.

GitHub's scheduled runs are also best-effort and can be dropped, which Scheduler
is not.

## What the job needs in its environment

Six variables, and only the first is a secret.

| Variable                             | Why                                             |
| ------------------------------------ | ----------------------------------------------- |
| `DATABASE_URL`                       | **Secret.** The reports and the delivery claim. |
| `NEXT_PUBLIC_ENV`                    | `emailParams.ts` reads it for staging's filter  |
| `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`    | Unused by the digest — see below                |
| `NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN` | Unused by the digest                            |
| `NEXT_PUBLIC_PUSHER_KEY`             | Unused by the digest                            |
| `NEXT_PUBLIC_PUSHER_CLUSTER`         | Unused by the digest                            |

The four marked unused are there because `browserEnv` validates all five
`NEXT_PUBLIC_*` variables as one group with `envsafe`, which **throws at import
time** for any one that is missing — measured by loading the built bundle
without them, which fails with `Missing environment variables` before the
handler is reached. They are public by construction: Next inlines every
`NEXT_PUBLIC_*` value into the client bundle, so every browser already has them.

`REGION_AWS` is optional and names SES's region; left empty, the handler falls
back to the region the Lambda runs in.

**Neither `yarn check:env` nor `yarn check:amplify` is affected**, and that is by
design rather than by luck: both derive their list from the two `envsafe`
modules, and this change adds no variable to either. The Lambda reuses the
app's existing contract in a second runtime instead of extending it.

## Deploying it

You need the AWS CLI authenticated against the account that owns the SES
identity, the SAM CLI (`brew install aws-sam-cli`), and permission to create
CloudFormation stacks, Lambda functions, IAM roles, Scheduler schedules, SQS
queues, SNS topics and CloudWatch alarms.

### 1. Confirm which account and region you are pointed at

```bash
aws sts get-caller-identity
aws configure get region
```

The region must be the one holding the verified `carpoolnu.com` identity, or
pass that region as `SesRegion` in step 5.

### 2. Make sure the SES template exists

`AdminReportDigestTemplate` lives in AWS, not in this repository. Until it is
published, every send answers `TemplateDoesNotExist`.

```bash
aws ses get-template --template-name AdminReportDigestTemplate   # does it exist?
python3 scripts/emailtemplate.py --apply                         # publish, if not
```

> `emailtemplate.py` **mutates SES templates** in the configured account. Check
> step 1 first.

### 3. See what the digest would say

A dry run claims nothing and sends nothing, so it is safe against production and
it tells you whether the roster resolves to anybody.

```bash
npx ts-node scripts/send-report-digest.ts
```

If `recipients` is `0`, fix the admin roster before deploying — the scheduled
run would skip with `no_recipients` every week and never alarm, because a skip
is a successful invocation.

### 4. Build the package

```bash
yarn package:report-digest
```

Writes `build/report-digest-lambda/dist` (gitignored), which `template.yaml`
points at. Re-run it after any change under `src/server/` or `infra/`, because
the bundle is a snapshot rather than a reference.

### 5. Put the database URL in SSM, then deploy with the schedule off

Storing it first keeps the connection string out of your shell history.

```bash
aws ssm put-parameter \
  --name /nucarpool/production/DATABASE_URL \
  --type SecureString \
  --value "<the production connection string>"
```

Consider appending `?connection_limit=1` to the value: a Lambda handles one
invocation at a time, so a larger pool only holds connections open on a frozen
container.

```bash
sam deploy --guided \
  --template infra/report-digest/template.yaml \
  --stack-name nucarpool-report-digest \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "DatabaseUrl=$(aws ssm get-parameter \
        --name /nucarpool/production/DATABASE_URL \
        --with-decryption --query Parameter.Value --output text)" \
    "AlarmEmail=<your address>" \
    "DeployEnv=production" \
    "MapboxAccessToken=<value>" \
    "MixpanelProjectToken=<value>" \
    "PusherKey=<value>" \
    "PusherCluster=<value>" \
    "ScheduleState=DISABLED"
```

`ScheduleState=DISABLED` is the point of this step: the stack is created and the
function is invocable, but nothing fires on its own until step 8. **Read the
change set before confirming it.**

> The URL lands in the Lambda's environment configuration, readable by anyone
> with `lambda:GetFunctionConfiguration` — the same exposure class as the
> Amplify console variable it mirrors, and the reason the `ps`-visible command
> substitution above is not the weakest link. Moving it to a Secrets Manager
> fetch at cold start is a real hardening step and a separate ticket, not
> something to bolt on during this deploy.

### 6. Confirm the alarm subscription

SNS emails a confirmation link. **Until you click it, every alarm in this stack
is silently undeliverable** — which is the failure this stack exists to prevent,
one level up.

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn "$(aws cloudformation describe-stacks \
      --stack-name nucarpool-report-digest \
      --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" \
      --output text)"
```

`SubscriptionArn` reading `PendingConfirmation` means it is not done.

### 7. Invoke it once by hand

This is the step that cannot be replaced by a test — it proves the function
loads in AWS, reaches the database, and that SES accepts the template.

```bash
aws lambda invoke \
  --function-name nucarpool-report-digest-send \
  --payload '{}' --cli-binary-format raw-in-base64-out \
  /tmp/digest-out.json

cat /tmp/digest-out.json
```

Expect `{"status":"sent",...}` and an email. Then confirm the row:

```sql
SELECT window_start, status, report_count, recipient_count
FROM report_digest_delivery
ORDER BY window_start DESC LIMIT 3;
```

**Now run exactly the same invoke a second time.** This is SCRUM-626's last
acceptance criterion, and it has to be demonstrated here rather than inferred
from the unit tests:

```bash
aws lambda invoke \
  --function-name nucarpool-report-digest-send \
  --payload '{}' --cli-binary-format raw-in-base64-out \
  /tmp/digest-again.json

cat /tmp/digest-again.json   # {"status":"skipped","reason":"already_sent",...}
```

No second email, and `report_digest_delivery` still holds one row for the week.
A `FunctionError` here, or a second email, is a genuine failure — stop and
report it rather than enabling the schedule.

### 8. Arm the schedule

```bash
sam deploy \
  --template infra/report-digest/template.yaml \
  --stack-name nucarpool-report-digest \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ScheduleState=ENABLED
```

`sam deploy` reuses the stored values for every parameter you do not repeat, so
the database URL does not have to be passed again.

Then confirm it is actually armed and when it next runs:

```bash
aws scheduler list-schedules --query "Schedules[?contains(Name,'report-digest')]"
```

## After the first Monday

One thing is still unverified at this point: that the schedule fires. Nothing
offline can establish it. Check the Monday after deploying —

```bash
aws logs tail /aws/lambda/nucarpool-report-digest-send --since 2d
```

— and record the result in the SCRUM-626 Jira comment, because there is
deliberately no run-state table in this repository.

## When something goes wrong

| Symptom                          | Where to look                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `-failed` alarm                  | Function logs. The claim was released, so the next run retries the same week; nothing was lost.                        |
| `-missed` alarm                  | The schedule is disabled, deleted, or not reaching the function. Send the skipped week with the `week` payload below.  |
| `-dead-lettered` alarm           | The DLQ message body says why Scheduler could not invoke it.                                                           |
| `TemplateDoesNotExist`           | Step 2 was skipped.                                                                                                    |
| `Missing environment variables`  | One of the five `NEXT_PUBLIC_*` values is unset. The log names which.                                                  |
| Skips `no_recipients` every week | No `permission != USER` user has a deliverable address. On staging, only `gmail.com` is deliverable.                   |
| `state_not_recorded`             | The mail went out but the row does not say so. Check `report_digest_delivery` before the next Monday — it may re-send. |

### Sending a week that was missed

Any date inside the week wanted; each week is its own row, so a skipped week is
never folded into the next digest.

```bash
aws lambda invoke \
  --function-name nucarpool-report-digest-send \
  --payload '{"week":"2026-09-28"}' --cli-binary-format raw-in-base64-out \
  /tmp/digest-week.json
```

The payload is validated by the same `parseDigestArgs` the ops script uses, so a
malformed date is refused before anything is claimed.

## Two options deliberately left on the table

**A fixed Boston hour.** A plain UTC cron cannot hold one, which is why
`REPORT_DIGEST_SCHEDULE` documents landing on 08:00 ET in summer and 07:00 in
winter. EventBridge Scheduler _can_: set `ScheduleExpressionTimezone` to
`America/New_York` and the hour to `8`. Not done here, because SCRUM-625 decided
the cadence and a test pins `utcHour` — changing it is its own decision, not a
side effect of adding a trigger.

**Tearing the stack down.** `sam delete --stack-name nucarpool-report-digest`
removes everything here and nothing else: no table, no row, no SES template. The
digest goes back to being manual, and a week nobody sent stays claimable. That
is what makes this trigger replaceable — correctness never lived in it.
