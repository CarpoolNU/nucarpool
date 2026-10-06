#!/usr/bin/env bash
#
# Build the deployment package for the weekly report digest Lambda.
#
#     ./scripts/package-report-digest-lambda.sh
#
# Writes build/report-digest-lambda/dist/ (what `sam deploy` uploads) and
# build/report-digest-lambda/report-digest-lambda.zip (the same tree zipped, for
# `aws lambda update-function-code` without SAM). `/build` is gitignored, so
# nothing here is ever committed.
#
# **This touches no AWS account.** It bundles, copies and zips; it makes no API
# call, reads no credential and deploys nothing. `infra/report-digest/README.md`
# holds the deploy steps, which are run by a human.
#
# ## Why the Prisma client is copied rather than bundled
#
# Everything else — the handler, `reportDigestSend`, dayjs, envsafe and the SES
# client — goes through esbuild into one file. `@prisma/client` is marked
# external and its two directories are copied in verbatim instead, because the
# generated client finds its query engine with `__dirname` at runtime. Bundling
# it would rewrite that `__dirname` to the bundle's own location and move the
# file it is looking for, and the failure would appear only once the function
# ran in AWS. Copied, the layout inside the zip is byte-for-byte the layout that
# works locally:
#
#     index.js                               the bundle
#     node_modules/@prisma/client/           require('.prisma/client/index')
#     node_modules/.prisma/client/           the generated client + the engine
#
# Node resolves `.prisma/client` by walking up from `@prisma/client/index.js` to
# the task root's `node_modules`, exactly as it does in this repository.
#
# ## Why the engine is the `rhel-openssl-3.0.x` one
#
# The Lambda runtime in `template.yaml` is `nodejs22.x`, which runs on Amazon
# Linux 2023 and links OpenSSL 3. `rhel-openssl-1.0.x` — the target the schema
# already carried for Amplify's older Amazon Linux 2 image — will not load
# there. Both are generated; only the matching one is shipped, which keeps about
# 32 MB of engines for other platforms out of the package.

set -euo pipefail

die() { printf 'package-report-digest-lambda: %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  die "not inside a git repository."
cd "$repo_root"

[ -f "infra/report-digest/handler.ts" ] ||
  die "infra/report-digest/handler.ts is missing; is this the right checkout?"

ENGINE="libquery_engine-rhel-openssl-3.0.x.so.node"
OUT="build/report-digest-lambda"
DIST="$OUT/dist"
ZIP="$OUT/report-digest-lambda.zip"

step "clean"
rm -rf "$OUT"
mkdir -p "$DIST"
note "$DIST"

# The engine for the Lambda's platform only exists once `binaryTargets` in
# prisma/schema.prisma has been generated, and a fresh checkout has generated
# nothing. Running generate here rather than telling the operator to is what
# makes this script work on a clean clone.
step "prisma generate"
yarn --silent prisma generate >/dev/null
[ -f "node_modules/.prisma/client/$ENGINE" ] ||
  die "$ENGINE was not generated. Check that binaryTargets in prisma/schema.prisma still lists rhel-openssl-3.0.x."
note "$ENGINE present."

step "bundle"
yarn --silent esbuild infra/report-digest/handler.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --sourcemap \
  --external:@prisma/client \
  --external:.prisma/client \
  --outfile="$DIST/index.js"
note "$(du -h "$DIST/index.js" | cut -f1) index.js"

step "prisma client"
mkdir -p "$DIST/node_modules/@prisma/client" "$DIST/node_modules/.prisma/client"
cp -R node_modules/@prisma/client/. "$DIST/node_modules/@prisma/client/"
cp -R node_modules/.prisma/client/. "$DIST/node_modules/.prisma/client/"

# Everything the runtime does not read. The type declarations are the larger
# saving of the two - index.d.ts alone is about 900 KB - and the engines for
# other platforms are the rest.
find "$DIST/node_modules" -name '*.d.ts' -delete
find "$DIST/node_modules/.prisma/client" -name 'libquery_engine-*' \
  ! -name "$ENGINE" -delete
rm -rf "$DIST/node_modules/.prisma/client/deno" \
  "$DIST/node_modules/@prisma/client/generator-build" \
  "$DIST/node_modules/@prisma/client/scripts"

[ -f "$DIST/node_modules/.prisma/client/$ENGINE" ] ||
  die "the engine did not survive the copy."
note "$(du -sh "$DIST/node_modules" | cut -f1) node_modules"

step "zip"
# `cd` into the tree so paths inside the archive are relative to the task root;
# Lambda unpacks the archive at /var/task and resolves `index.js` from there.
(cd "$DIST" && zip -qr "../../../$ZIP" .)
note "$(du -h "$ZIP" | cut -f1) $ZIP"

step "done"
note "sam deploy reads $DIST (CodeUri in infra/report-digest/template.yaml)."
note "See infra/report-digest/README.md for the deploy steps."
