/** @type {import('next').NextConfig} */

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
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://carpoolnubucket.s3.us-east-2.amazonaws.com https://*.mapbox.com",
  "connect-src 'self' https://*.mapbox.com https://*.mixpanel.com https://*.pusher.com wss://*.pusher.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
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
        hostname: "carpoolnubucket.s3.us-east-2.amazonaws.com",
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
