import {
  DEFAULT_S3_BUCKET_NAME,
  DEFAULT_S3_REGION,
  resolveS3Config,
  s3BucketHost,
} from "./s3Config";

/**
 * The bucket configuration, and the invariant that makes it worth sharing
 * from one place.
 *
 * `next.config.js` derives both the CSP `img-src` and the
 * `images.remotePatterns` host from this configuration. Those two are the
 * dangerous pair to let drift apart: the CSP is
 * `Content-Security-Policy-Report-Only` today, so a host Next is allowed to
 * optimise but the CSP does not permit is only a console violation — until
 * someone switches enforcement on. The second describe below pins them to the
 * same value.
 */

describe("resolveS3Config", () => {
  it("falls back to the default bucket and region when neither is set", () => {
    // The whole change is inert in a deployment that sets neither variable,
    // which is what keeps existing objects reachable.
    const { bucket, region } = resolveS3Config({});

    expect(bucket).toBe("carpoolnubucket");
    expect(region).toBe("us-east-2");
  });

  it("prefers the environment over the defaults", () => {
    const { bucket, region, host } = resolveS3Config({
      S3_BUCKET_NAME: "some-other-bucket",
      S3_REGION: "eu-west-1",
    });

    expect(bucket).toBe("some-other-bucket");
    expect(region).toBe("eu-west-1");
    expect(host).toBe("some-other-bucket.s3.eu-west-1.amazonaws.com");
  });

  it("treats an empty value as unset rather than building a broken host", () => {
    // envsafe does this for the validated copies; this path has no envsafe, so
    // it has to agree on its own.
    const { bucket, region } = resolveS3Config({
      S3_BUCKET_NAME: "",
      S3_REGION: "",
    });

    expect(bucket).toBe(DEFAULT_S3_BUCKET_NAME);
    expect(region).toBe(DEFAULT_S3_REGION);
  });

  it("builds the virtual-hosted endpoint the SDK signs", () => {
    // Path-style would be s3.<region>.amazonaws.com/<bucket>, which would not
    // match a presigned URL and so would not match what the browser requests.
    expect(s3BucketHost("b", "r")).toBe("b.s3.r.amazonaws.com");
  });
});

describe("next.config.js derives both hosts from the same place", () => {
  const nextConfig = require("../../../next.config.js");
  const { host } = resolveS3Config();

  it("permits the bucket host in the image allow-list", () => {
    const hostnames = (
      nextConfig.images.remotePatterns as { hostname: string }[]
    ).map((pattern) => pattern.hostname);

    expect(hostnames).toContain(host);
  });

  it("permits the same host in the Content-Security-Policy", async () => {
    const headerGroups = await nextConfig.headers();
    const csp = headerGroups[0].headers.find(
      (entry: { key: string }) =>
        entry.key === "Content-Security-Policy-Report-Only",
    );

    expect(csp).toBeDefined();

    const imgSrc = csp.value
      .split("; ")
      .find((directive: string) => directive.startsWith("img-src "));

    // The invariant: whatever host the image optimiser may fetch, the CSP
    // permits.
    expect(imgSrc).toContain(`https://${host}`);
  });
});
