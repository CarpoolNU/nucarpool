const nextConfig = require("./next.config.js");

/**
 * The security headers, pinned (SCRUM-257).
 *
 * SCRUM-257 added six response headers, a report-only CSP, `remotePatterns` and
 * `poweredByHeader: false`. None of it was covered by a test, so any later edit
 * to `next.config.js` could drop a header silently — nothing else in the repo
 * would notice, and the failure mode of a missing security header is that
 * everything keeps working.
 *
 * These tests are deliberately about *why* each value is what it is, not just
 * that it is set. Several were reasoned decisions:
 *
 *  - HSTS omits `includeSubDomains` and `preload` on purpose; both reach
 *    hostnames beyond this app and `preload` is hard to reverse.
 *  - The CSP ships report-only on purpose; it has never been exercised in a
 *    browser against the map, chat or upload paths.
 *  - `'unsafe-inline'` and `'unsafe-eval'` are present because the Pages Router
 *    inlines `__NEXT_DATA__` and mapbox-gl evaluates style expressions.
 *
 * Where a test pins one of those, it says so — a future change that flips it
 * should have to update the test deliberately rather than by accident.
 */

type HeaderEntry = { key: string; value: string };

const headerGroups = async (): Promise<
  { source: string; headers: HeaderEntry[] }[]
> => nextConfig.headers();

const headersFor = async (): Promise<HeaderEntry[]> => {
  const groups = await headerGroups();
  return groups[0]!.headers;
};

const headerValue = async (key: string): Promise<string | undefined> =>
  (await headersFor()).find((entry) => entry.key === key)?.value;

/**
 * The CSP as a map of directive name -> the rest of the directive.
 *
 * Deliberately accepts either header name. The directive assertions below are
 * about what the app needs in order to work, and they hold whether the policy
 * is reported or enforced — so switching to enforcement should be a one-line
 * change to the report-only test, not a rewrite of every directive test.
 */
const cspDirectives = async (): Promise<Map<string, string>> => {
  const csp =
    (await headerValue("Content-Security-Policy-Report-Only")) ??
    (await headerValue("Content-Security-Policy"));

  if (csp === undefined) {
    throw new Error("no Content-Security-Policy header of either kind is set");
  }

  const directives = new Map<string, string>();

  for (const directive of csp.split("; ")) {
    const [name, ...rest] = directive.split(" ");
    directives.set(name!, rest.join(" "));
  }
  return directives;
};

describe("security headers are sent on every route", () => {
  it("applies to one source that covers pages and API routes alike", async () => {
    const groups = await headerGroups();

    expect(groups).toHaveLength(1);
    // `/:path*` rather than `/(.*)`: it matches /api and Next's own assets too,
    // which is the point — an API response with no nosniff is still a response.
    expect(groups[0]!.source).toBe("/:path*");
  });

  it("sends every header SCRUM-257 introduced", async () => {
    const keys = (await headersFor()).map((entry) => entry.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Strict-Transport-Security",
        "Permissions-Policy",
      ]),
    );

    // Either kind counts here; which one is asserted on its own below, so that
    // enforcing the policy is a one-test change.
    expect(
      keys.filter((key) => key.startsWith("Content-Security-Policy")),
    ).toHaveLength(1);
  });

  it("refuses framing, and says so in both places", async () => {
    // The clickjacking pair. These two disagreeing is a classic mistake: older
    // browsers honour the header, newer ones prefer the CSP directive, so a
    // change to one has to be matched in the other.
    expect(await headerValue("X-Frame-Options")).toBe("DENY");
    expect((await cspDirectives()).get("frame-ancestors")).toBe("'none'");
  });

  it("sets nosniff and a referrer policy that does not leak paths", async () => {
    expect(await headerValue("X-Content-Type-Options")).toBe("nosniff");
    expect(await headerValue("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("sets HSTS without reaching beyond this hostname", async () => {
    const hsts = (await headerValue("Strict-Transport-Security"))!;

    expect(hsts).toContain("max-age=");
    expect(Number(hsts.match(/max-age=(\d+)/)![1])).toBeGreaterThanOrEqual(
      31536000,
    );

    // Deliberate omissions, not oversights: both affect hostnames other than
    // this app's, and `preload` is effectively irreversible. Adding either is
    // the domain owner's call (SCRUM-257).
    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("denies the device permissions the app never asks for", async () => {
    const permissions = (await headerValue("Permissions-Policy"))!;

    // Nothing calls navigator.geolocation and the map has no GeolocateControl.
    for (const feature of ["camera", "microphone", "geolocation"]) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });

  it("does not advertise the framework", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("the CSP is still report-only", () => {
  it("ships as Report-Only and not as an enforcing policy", async () => {
    const keys = (await headersFor()).map((entry) => entry.key);

    // Enforcement is a deliberate later step (SCRUM-257): the policy has never
    // been exercised in a browser against the map, chat or profile-picture
    // upload, so enforcing it could break Mapbox's workers or a third-party
    // origin in production. When that step happens, this test should be updated
    // as part of it rather than deleted.
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
  });
});

describe("the CSP allows what the app actually loads", () => {
  it("locks down the directives that have no legitimate use here", async () => {
    const directives = await cspDirectives();

    expect(directives.get("default-src")).toBe("'self'");
    // No <object>/<embed> anywhere, and these are classic injection sinks.
    expect(directives.get("object-src")).toBe("'none'");
    expect(directives.get("base-uri")).toBe("'self'");
    expect(directives.get("form-action")).toBe("'self'");
  });

  it("never widens default-src, whatever the specific directives allow", async () => {
    // The failure this catches: relaxing default-src rather than the one
    // directive that needed it silently relaxes every unlisted resource type.
    const defaultSrc = (await cspDirectives()).get("default-src")!;

    expect(defaultSrc).not.toContain("'unsafe-inline'");
    expect(defaultSrc).not.toContain("'unsafe-eval'");
    expect(defaultSrc).not.toContain("*");
  });

  it("permits the remote font origins the app depends on", async () => {
    const directives = await cspDirectives();

    // Lato and Montserrat are loaded as remote stylesheets, not self-hosted, so
    // a bare `style-src 'self'` would silently strip the app's typography.
    expect(directives.get("style-src")).toContain(
      "https://fonts.googleapis.com",
    );
    expect(directives.get("font-src")).toContain("https://fonts.gstatic.com");
  });

  it("permits Mapbox in every directive it needs", async () => {
    const directives = await cspDirectives();

    // Tiles and geocoding over XHR, sprites as images, and the renderer runs in
    // a worker created from a blob URL.
    expect(directives.get("connect-src")).toContain("https://*.mapbox.com");
    expect(directives.get("img-src")).toContain("https://*.mapbox.com");
    expect(directives.get("worker-src")).toContain("blob:");
    expect(directives.get("img-src")).toContain("blob:");
  });

  it("permits Pusher over both https and wss, by wildcard", async () => {
    const connectSrc = (await cspDirectives()).get("connect-src")!;

    // The cluster subdomain comes from NEXT_PUBLIC_PUSHER_CLUSTER, so it is not
    // fixed at build time and cannot be pinned to one host.
    expect(connectSrc).toContain("https://*.pusher.com");
    expect(connectSrc).toContain("wss://*.pusher.com");
  });

  it("permits Mixpanel for XHR only, since it is a package and not a CDN script", async () => {
    const directives = await cspDirectives();

    expect(directives.get("connect-src")).toContain("https://*.mixpanel.com");
    expect(directives.get("script-src")).not.toContain("mixpanel");
  });

  it("permits Google avatars and the profile-picture bucket as images", async () => {
    const imgSrc = (await cspDirectives()).get("img-src")!;

    expect(imgSrc).toContain("https://lh3.googleusercontent.com");
    expect(imgSrc).toContain("amazonaws.com");
    // Uploads are previewed from a data URL before they are sent.
    expect(imgSrc).toContain("data:");
  });
});

describe("remote image hosts", () => {
  it("uses remotePatterns rather than the deprecated domains option", async () => {
    expect(nextConfig.images.remotePatterns).toBeDefined();
    expect(nextConfig.images.domains).toBeUndefined();
  });

  it("allows exactly the two hosts the app renders images from", async () => {
    const patterns = nextConfig.images.remotePatterns as {
      protocol: string;
      hostname: string;
    }[];

    expect(patterns.map((pattern) => pattern.hostname)).toEqual([
      "lh3.googleusercontent.com",
      expect.stringContaining("amazonaws.com"),
    ]);

    // An http host here would let the optimiser fetch over plaintext.
    for (const pattern of patterns) {
      expect(pattern.protocol).toBe("https");
    }
  });

  it("permits every image host in the CSP as well", async () => {
    // The two lists are maintained separately, and the CSP being report-only
    // means a host missing from it fails silently today — and would start
    // breaking images the moment enforcement is switched on.
    const imgSrc = (await cspDirectives()).get("img-src")!;
    const patterns = nextConfig.images.remotePatterns as {
      hostname: string;
    }[];

    for (const { hostname } of patterns) {
      expect(imgSrc).toContain(hostname);
    }
  });
});
