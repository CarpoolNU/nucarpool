/**
 * Journey: a signed-out visitor reaching a protected page is sent to sign-in,
 * and a seeded session is what changes that.
 *
 * This is the walking skeleton. It is the cheapest journey in SCRUM-264's list
 * on purpose — no map, no WebGL, no Pusher, no SES, no seed data beyond one
 * row — so that the chain it proves is the infrastructure and nothing else:
 *
 *     build -> boot -> approve + migrate a disposable database -> seed a
 *     session row -> inject the cookie -> assert -> tear down
 *
 * Every other journey in that ticket rests on exactly this chain and adds its
 * own stubbing decisions on top. They are separate tickets for that reason.
 *
 * **Selectors here are roles and accessible names, never classes.** Tailwind v4
 * scans this file, so naming a utility in it — in a selector or in a comment —
 * ships that utility as CSS. See the header of `e2e/support/environment.ts`.
 */

import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from "../support/environment";
import { expect, test } from "../support/fixtures";

/**
 * What `getServerSideProps` returns for `redirect: { permanent: false }`.
 * Asserted rather than merely followed, because "the status was a redirect at
 * all" is half of what these guards are.
 */
const TEMPORARY_REDIRECT = 307;

test.describe("signed-out visitor reaching a protected page", () => {
  test("is redirected to the sign-in page, which renders", async ({ page }) => {
    await page.goto("/");

    // The destination, not merely "some redirect happened". `/` has two
    // redirect arms — unauthenticated to `/sign-in`, un-onboarded to
    // `/profile/setup` — and only one of them is this journey.
    await expect(page).toHaveURL(/\/sign-in$/);

    // By accessible name. The provider is Azure AD in every environment; the
    // Google button exists only when `NEXT_PUBLIC_ENV` is `staging`, so it is
    // deliberately not asserted on either way.
    await expect(
      page.getByRole("button", { name: /sign in with northeastern/i }),
    ).toBeVisible();
  });

  /**
   * The one assertion in this skeleton that jsdom could not make at any
   * viewport, and the reason running these journeys at two widths buys
   * anything rather than just doubling the runtime.
   *
   * jsdom performs no layout — every element measures zero — and evaluates no
   * media queries, so "is this control actually on screen" is not expressible
   * there at any width. Here it is a measurement taken from a real layout.
   *
   * **`scrollWidth` is the wrong instrument on this application, and that was
   * measured rather than reasoned about.** `globals.css` sets
   * `html, body { overflow: hidden }`, so a 4000px element appended to `body`
   * leaves `document.documentElement.scrollWidth` at exactly the viewport
   * width — 1280 and 639 respectively. A document-overflow assertion therefore
   * cannot fail on any page of this app, and would have shipped as a test that
   * looked like geometry and asserted nothing. The same `overflow: hidden` is
   * why this matters to a user: a control pushed outside the viewport here is
   * not scrollable-to, it is **unreachable**.
   *
   * So the measurement is the control's own box against the viewport. The
   * inverse was confirmed to fail: forcing the button out moved its box to
   * x=1512 at desktop and x=1191.5 at mobile, against viewports of 1280 and
   * 639.
   *
   * It is a modest geometry assertion, deliberately. The one SCRUM-264 names —
   * the mobile bottom navigation's measured height against
   * `MOBILE_NAV_HEIGHT_PX` plus an overridden safe-area inset — needs an
   * onboarded user on the map page, and therefore needs Mapbox handled. It is
   * tracked separately, along with the `Emulation.setSafeAreaInsetsOverride`
   * CDP call it requires. **Nothing here sets or claims a safe-area inset**;
   * see `src/testing/layoutFixtures.ts:1753` for why a device descriptor
   * cannot produce one.
   */
  test("keeps the sign-in control inside the viewport at this width", async ({
    page,
  }) => {
    await page.goto("/sign-in");

    const button = page.getByRole("button", {
      name: /sign in with northeastern/i,
    });
    await expect(button).toBeVisible();

    const box = await button.boundingBox();
    if (box === null) {
      throw new Error(
        "the sign-in button has no box: it is not rendered, or it is detached",
      );
    }

    const viewport = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));

    // Asserted as one object so a failure prints every edge and the viewport
    // it was measured against, rather than the first edge that happened to go
    // out and nothing to compare it to.
    expect({
      overflowsLeft: box.x < 0,
      overflowsTop: box.y < 0,
      overflowsRight: box.x + box.width > viewport.width,
      overflowsBottom: box.y + box.height > viewport.height,
      box,
      viewport,
    }).toMatchObject({
      overflowsLeft: false,
      overflowsTop: false,
      overflowsRight: false,
      overflowsBottom: false,
    });
  });

  /**
   * That the two projects are the two widths they claim to be.
   *
   * Without this, a project misconfigured to the same viewport as its sibling
   * would run every journey twice at one width and report a full green run —
   * the exact shape of a suite that costs double and proves single. The mobile
   * figure is derived from `MOBILE_BREAKPOINT_PX`, so this also fails if the
   * app's own boundary moves and the suite is not moved with it.
   */
  test("runs at the viewport its project declares", async ({
    page,
  }, testInfo) => {
    await page.goto("/sign-in");

    const measured = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    const expected =
      testInfo.project.name === "mobile"
        ? MOBILE_VIEWPORT.width
        : DESKTOP_VIEWPORT.width;

    expect(measured).toBe(expected);
  });
});

/**
 * The same request, differing only in whether a seeded session cookie is
 * attached. That pairing is the point: it is what makes the seeding helper
 * demonstrably the cause, rather than something that happens to run before an
 * assertion that would have passed anyway.
 *
 * These assert on the redirect itself rather than navigating, because both
 * destinations are expensive pages this skeleton has no business loading —
 * `/` is the map and `/profile/setup` pulls in address lookup. `page.request`
 * shares cookie storage with the browser context, so the cookie under test is
 * the same one a navigation would send.
 */
test.describe("the seeded session cookie is what authenticates the context", () => {
  test("without it, the map page redirects to sign-in", async ({ page }) => {
    const response = await page.request.get("/", { maxRedirects: 0 });

    expect(response.status()).toBe(TEMPORARY_REDIRECT);
    expect(response.headers()["location"]).toBe("/sign-in");
  });

  test("with it, the same page redirects by onboarding state instead", async ({
    page,
    signInAs,
  }) => {
    await signInAs({ isOnboarded: false });

    const response = await page.request.get("/", { maxRedirects: 0 });

    expect(response.status()).toBe(TEMPORARY_REDIRECT);
    // Not `/sign-in`: the request is authenticated, so it falls through the
    // first guard to the onboarding one.
    expect(response.headers()["location"]).toBe("/profile/setup");
  });

  test("an onboarded user is sent off the sign-in page", async ({
    page,
    prisma,
    signInAs,
  }) => {
    // `role` is on `CarpoolSearch` rather than on `User`, so passing one
    // exercises the helper's nested-write path against a real MySQL — which is
    // the half of it the redirect alone would leave unproven.
    const user = await signInAs({ isOnboarded: true, role: "VIEWER" });

    const search = await prisma.carpoolSearch.findFirst({
      where: { userId: user.id },
    });
    expect(search?.role).toBe("VIEWER");

    const response = await page.request.get("/sign-in", { maxRedirects: 0 });

    expect(response.status()).toBe(TEMPORARY_REDIRECT);
    expect(response.headers()["location"]).toBe("/");
  });

  test("permission is parameterised, and reaches the row", async ({
    prisma,
    signInAs,
  }) => {
    // `adminRouter` admits anything but `USER`, and
    // `admin.updateUserPermission` requires `MANAGER` specifically, so the
    // admin journeys need this knob. Asserted here rather than left until then,
    // so the helper is not shipped with an untested parameter.
    const manager = await signInAs({ permission: "MANAGER" });

    const stored = await prisma.user.findUnique({ where: { id: manager.id } });
    expect(stored?.permission).toBe("MANAGER");
  });
});
