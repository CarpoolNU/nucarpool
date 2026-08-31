/** @type {import('next').NextConfig} */

const { resolveS3Config } = require("./src/utils/env/s3Config");

/**
 * The profile-picture bucket, resolved once and used for both the CSP `img-src`
 * entry and the `images.remotePatterns` host below (SCRUM-282). Those were two
 * separate copies of the same literal, and an image host the CSP did not permit
 * would have been a report-only violation nobody noticed until enforcement.
 *
 * This runs outside envsafe — `next.config.js` is loaded before any TypeScript
 * exists — but reads the same variables and the same defaults that
 * `serverEnv` validates, from `s3Config.js`.
 */
const { host: s3Host } = resolveS3Config();

/**
 * Where the browser sends CSP violation reports (SCRUM-283).
 *
 * A relative path on purpose. Both `report-uri` and `Reporting-Endpoints`
 * resolve their value against the document, so this reaches the app's own
 * collector without the deployed hostname having to be known at build time —
 * which it is not, since the same build runs on Amplify preview URLs, staging
 * and production.
 */
const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Content Security Policy (SCRUM-257).
 *
 * Sent as `Content-Security-Policy-Report-Only` on purpose: violations are
 * reported to the browser console without anything being blocked, so the policy
 * can be validated against real traffic before it is enforced. Switching the
 * header name to `Content-Security-Policy` is the enforcement step, and should
 * only happen once a deployed environment has been exercised — map, chat,
 * profile picture upload and sign-in — with no violations reported.
 *
 * Each non-obvious source is here for a reason:
 *
 * - `'unsafe-inline'` in script-src: the Pages Router inlines the
 *   `__NEXT_DATA__` hydration payload. Removing it needs per-request nonces,
 *   which this app has no middleware to generate.
 * - `'unsafe-eval'` in script-src: mapbox-gl evaluates style expressions.
 * - `'unsafe-inline'` in style-src: styled-components, MUI/emotion and Ant
 *   Design all inject inline <style> tags at runtime.
 * - fonts.googleapis.com / fonts.gstatic.com: Lato and Montserrat are loaded as
 *   remote stylesheets in src/pages/_document.tsx, not self-hosted.
 * - blob: in worker-src and img-src: mapbox-gl runs its renderer in a worker
 *   created from a blob URL.
 * - `*.pusher.com` over wss: the realtime cluster is configured through
 *   NEXT_PUBLIC_PUSHER_CLUSTER, so the subdomain is not fixed at build time.
 * - `*.mapbox.com` covers both api.mapbox.com (tiles, geocoding, directions)
 *   and events.mapbox.com (mapbox-gl telemetry).
 * - the S3 host in connect-src: `useUploadFile` PUTs the profile picture
 *   straight to a presigned URL with `fetch`, so the bucket is a connect target
 *   as well as an image source. It was in `img-src` only, which would have
 *   blocked every upload the moment the policy was enforced (SCRUM-305).
 *
 * Audited against the client bundle for SCRUM-305: the only `fetch` to an
 * external origin anywhere in browser-reachable code is that S3 upload;
 * everything else is same-origin tRPC. Mapbox, Pusher, Mixpanel and the Google
 * font hosts were already covered, and the Azure AD sign-in redirect is a
 * top-level navigation, which no directive here governs.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src 'self' data: blob: https://lh3.googleusercontent.com https://${s3Host} https://*.mapbox.com`,
  `connect-src 'self' https://${s3Host} https://*.mapbox.com https://*.mixpanel.com https://*.pusher.com wss://*.pusher.com`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Both reporting forms, because browsers split on which they implement
  // (SCRUM-283). `report-to` is the current standard and pairs with the
  // `Reporting-Endpoints` header below; `report-uri` is deprecated but is still
  // the only one Safari and Firefox support. They do not double-report: a
  // browser that understands `report-to` ignores `report-uri` when both are
  // present, which is exactly the precedence we want.
  `report-uri ${CSP_REPORT_PATH}`,
  "report-to csp-endpoint",
].join("; ");

const securityHeaders = [
  // No part of the app is meant to be framed, and it has no iframes of its own.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Browsers ignore this over plain HTTP, so it is inert in local development.
  // `includeSubDomains` and `preload` are deliberately omitted: both affect
  // hostnames beyond this app and are a decision for whoever owns the domain.
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  // The app requests none of these. Nothing uses navigator.geolocation, and the
  // map has no GeolocateControl.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // Defines the `csp-endpoint` group that `report-to` above refers to
  // (SCRUM-283). Without this header that directive names nothing and is
  // silently inert, which is the failure mode SCRUM-283 was filed about.
  {
    key: "Reporting-Endpoints",
    value: `csp-endpoint="${CSP_REPORT_PATH}"`,
  },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
];

const nextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework and its version.
  poweredByHeader: false,
  images: {
    // `images.domains` is deprecated in favour of remotePatterns.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: s3Host,
        pathname: "/**",
      },
    ],
  },
  compiler: {
    styledComponents: true,
  },
  async headers() {
    return [
      {
        // Every route, including /api and Next's own assets.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
