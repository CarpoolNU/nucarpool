"use strict";

/**
 * Where profile pictures live (SCRUM-282).
 *
 * The bucket and its region were hardcoded in four places — three commands in
 * `uploadToS3.ts` plus the S3 client, and twice more in `next.config.js`, once
 * for the CSP `img-src` and once for the `images.remotePatterns` host. A second
 * environment could not use its own bucket without a code change, and the two
 * copies in the Next config had to be kept in step with the client by hand.
 *
 * This module is deliberately CommonJS JavaScript rather than TypeScript,
 * because `next.config.js` is loaded by Node before any TypeScript exists and
 * has to `require` it. `server.ts` imports the same constants for its envsafe
 * defaults, so the fallbacks are defined exactly once.
 *
 * Both variables default to the values that were hardcoded, which is what makes
 * this change inert: nothing in a deployed environment has to be set for the
 * existing bucket to keep being used, and no stored object moves.
 */

const DEFAULT_S3_BUCKET_NAME = "carpoolnubucket";
const DEFAULT_S3_REGION = "us-east-2";

/**
 * The virtual-hosted-style endpoint for a bucket, which is the form that
 * appears in a presigned URL and therefore the host the browser actually
 * fetches. Path-style (`s3.region.amazonaws.com/bucket`) is not used: the AWS
 * SDK v3 signs virtual-hosted URLs by default.
 *
 * @param {string} bucket
 * @param {string} region
 * @returns {string}
 */
const s3BucketHost = (bucket, region) => `${bucket}.s3.${region}.amazonaws.com`;

/**
 * Resolves the bucket configuration from an environment-like object, applying
 * the defaults above. Used by `next.config.js`, which runs outside envsafe;
 * application code reads the validated values from `serverEnv` instead.
 *
 * @param {Record<string, string | undefined>} [env]
 */
const resolveS3Config = (env = process.env) => {
  const bucket = env.S3_BUCKET_NAME || DEFAULT_S3_BUCKET_NAME;
  const region = env.S3_REGION || DEFAULT_S3_REGION;
  return { bucket, region, host: s3BucketHost(bucket, region) };
};

module.exports = {
  DEFAULT_S3_BUCKET_NAME,
  DEFAULT_S3_REGION,
  s3BucketHost,
  resolveS3Config,
};
