# Deployment

The app runs on **AWS Amplify Hosting**. [`amplify.yml`](../amplify.yml) is the build specification, and a file at that path **takes precedence over the Amplify console's build settings** — so the repository is authoritative for how the app is built.

## The build

Amplify's build phase writes the container's environment into `.env.production` so `envsafe` can read it at runtime, then runs:

```
yarn run build:${BUILD_ENV}
```

`BUILD_ENV` is set **per branch in the Amplify console**, so the repository cannot tell you which script runs. All three differ only in `NODE_ENV`:

| Script              | Command                                              |
| ------------------- | ---------------------------------------------------- |
| `build:main`        | `prisma generate && next build`                      |
| `build:development` | `NODE_ENV=development prisma generate && next build` |
| `build:production`  | `NODE_ENV=production prisma generate && next build`  |

The `&&` is load-bearing. With a single `&`, `prisma generate` is backgrounded and its exit code discarded, so the build can compile against a stale client.

> **A `package.json` script is part of the deploy surface.** Because the console selects one by variable name, adding a `build:*` script puts it one console field away from running against a deployed environment. A previous `build:preview` entry force-pushed the schema and re-seeded; it was deleted for that reason.

## The environment contract

Two separate things have to be true, and only the first used to be checked:

| Check                | Question                                                    |
| -------------------- | ----------------------------------------------------------- |
| `yarn check:env`     | Does `.env.example` document every variable the app needs?  |
| `yarn check:amplify` | Does `amplify.yml` carry every variable to the **runtime**? |

A variable set in the Amplify console reaches the build shell for free but **not** the runtime. That gap once left `S3_BUCKET_NAME` resolved from the console at build time while the running server silently fell back to a hardcoded default.

Both checks derive their variable list from the `envsafe` modules, so the list cannot drift. `amplify.yml` copies variables with `env | grep` lines, and the strictness of each line is enforced:

| The line covers         | It must be                          |
| ----------------------- | ----------------------------------- |
| a required variable     | strict — a no-match fails the build |
| only optional variables | tolerant (`\|\| true`)              |
| nothing in the contract | unconstrained                       |

`grep` exits 1 when nothing matches, and Amplify fails the build on any non-zero exit — so a pattern for a legitimately absent variable stops the deploy. Only the `S3_` line is tolerant, because both `S3_*` variables default in code.

> Every secret the app uses ends up in `.env.production`, which AWS documents as readable by anyone with access to the deployment artifacts. That is why the `AWS_COMMIT_ID` patterns match by exact name — a prefix match would sweep the build container's own IAM credentials into the same file.

## Checking what is live

`GET /api/version` reports the build identity of whatever is running, so "has this shipped?" is answerable without console access:

```bash
curl -s https://<host>/api/version
{"commit":"0f1e2d3…","branch":"main","jobId":"42","environment":"production"}
```

`git branch --contains <sha>` resolves the commit locally; `jobId` finds the build in the console.

**Read this before completing an expand/contract migration.** Dropping a column or deleting a backfill script is irreversible, and the precondition is always "no running code touches it any more". Inferring that from row data does not work: zero rows is equally consistent with "not deployed" and with "deployed, and nobody has used the feature since". Check the commit instead.

The route is unauthenticated, which is safe because of what it returns rather than who asks — a commit SHA and branch from a public repository, a build number, and `NEXT_PUBLIC_ENV`, which ships in the client bundle anyway. A test pins the exact key set so it cannot grow a config field. It sends `Cache-Control: no-store`, because CloudFront sits in front of Amplify and a cached answer would report the previous build across exactly the boundary being checked.

Outside Amplify every field reads `unknown`.

## Two things that stay true

- **Nothing applies migration files to a shared database.** No step runs `prisma migrate deploy`; schema promotion is a PlanetScale Deploy Request. See [the database docs](../src/server/db/README.md#changing-the-schema).
- **Server-side tRPC calls resolve their origin from `NEXTAUTH_URL`**, falling back to `http://localhost:3000`. Nothing takes that path today because `ssr: false` is set, but **enabling SSR makes it live** — confirm `NEXTAUTH_URL` is set in every deployed environment first. See [`getBaseUrl`](../src/utils/getBaseUrl.ts).

## Content Security Policy

[`next.config.js`](../next.config.js) sends security headers on every route, pinned by [`next.config.test.ts`](../next.config.test.ts). All enforce immediately except the CSP, which is deliberately **report-only** — it has never been exercised in a browser against the map, chat and picture upload, and enforcing it blind could break Mapbox's workers.

Violations post to `/api/csp-report`, which logs one line each, prefixed `[csp-report]`. `effectiveDirective` is the directive that would have blocked the load and `blockedUri` is what it would have blocked; together they say which line of the policy is too narrow.

**Enforcing it** means renaming the header from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Exactly one test fails when you do, and updating it is part of the change. The bar is not zero reports — browser extensions generate violations the app cannot prevent. It is that, having exercised sign-in, the map, chat and a picture upload on a deployed environment:

- no violation whose `blockedUri` is a first-party path or an origin the app calls deliberately;
- no `worker-src` or `child-src` violation, which would mean the map is actually broken;
- everything remaining attributable to extensions (`chrome-extension:`, `moz-extension:`, `data:`).

Three caveats before relying on the reports:

- **`script-src` keeps `'unsafe-inline'` and `'unsafe-eval'`** — the Pages Router inlines its hydration payload and mapbox-gl evaluates style expressions. Enforcement therefore buys protection against unexpected _origins_, not against XSS. Closing that needs per-request nonces.
- The rate limit is 100 reports per minute **per server instance**, so a serverless deployment's real ceiling scales with concurrency. Drops are logged, so loss is never silent.
- Safari and Firefox only implement the deprecated `report-uri`, so `report-to` is effectively Chrome and Edge. The policy sends both.
