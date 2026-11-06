/**
 * Seeding the session NextAuth would have created, without going near Azure AD.
 *
 * ## Why this exists rather than a scripted sign-in
 *
 * Sign-in is Northeastern SSO (Azure AD), with Google added only when
 * `NEXT_PUBLIC_ENV=staging`. Driving either from a browser test would need real
 * institutional credentials, would be subject to MFA and conditional-access
 * policy, and would make CI depend on a third party staying up. None of that is
 * testing this application.
 *
 * ## Why seeding a row is enough, and how that was established
 *
 * NextAuth is configured with the Prisma adapter and the **database** session
 * strategy, so a session is a row rather than a signed JWT. That is not an
 * assumption: the `session({ session, user })` callback in
 * `src/pages/api/auth/[...nextauth].ts` takes a `user` argument, and NextAuth
 * passes one only under the database strategy. The page guards are then plain
 * `getServerSession` calls in `getServerSideProps` — `src/pages/index.tsx`,
 * `src/pages/sign-in.tsx`, `src/pages/profile/setup.tsx`, `src/pages/admin.tsx`
 * — each of which reads the cookie and queries the `session` table directly.
 *
 * So an authenticated request is a `user` row, a `session` row, and a cookie
 * carrying that row's token. Nothing in `src/pages/api/auth/` or anywhere else
 * in the production tree is modified to make this work, and nothing here is
 * importable from the application: this file lives in `e2e/`.
 *
 * ## What is deliberately not here
 *
 * No `account` row. That is the provider link NextAuth writes when someone
 * signs in through Azure AD, and no guard in this application reads it. Adding
 * one would be inventing a shape the tests do not depend on.
 */

import { randomUUID } from "crypto";
import type { BrowserContext } from "@playwright/test";
import type { Permission, PrismaClient, Role } from "@prisma/client";
import { E2E_BASE_URL, SESSION_COOKIE_NAME } from "./environment";

/**
 * How long a seeded session is valid for.
 *
 * NextAuth's adapter treats an `expires` in the past as no session at all, so
 * this only has to outlast the run. An hour is far more than any suite needs
 * and short enough that a row left behind by an interrupted run is not a
 * standing login against a database somebody later reuses.
 */
const SESSION_LIFETIME_MS = 60 * 60 * 1000;

export type SeedSessionOptions = {
  /**
   * `USER`, `ADMIN` or `MANAGER`. `adminRouter` requires anything but `USER`,
   * and `admin.updateUserPermission` requires `MANAGER` specifically, so the
   * admin journeys need this parameterised rather than fixed.
   */
  permission?: Permission;

  /**
   * Whether the user has completed onboarding.
   *
   * This is the field the page guards branch on, so it decides where a
   * seeded user lands: `false` sends `/` to `/profile/setup`, `true` lets `/`
   * render and sends `/sign-in` to `/`.
   */
  isOnboarded?: boolean;

  /**
   * `RIDER`, `DRIVER` or `VIEWER` — and **not a property of the user**.
   *
   * Role lives on `CarpoolSearch`, alongside company, schedule, seats and group
   * membership; `User` carries none of it. Passing a role therefore creates a
   * `CarpoolSearch` and the two `Location` rows it points at, and omitting one
   * creates no search at all — which is the correct shape for a user who has
   * not onboarded, not an incomplete fixture.
   *
   * See "Data-model gotchas" in `CLAUDE.md`: the flattened shape the API
   * returns is a merge performed on read, not how any of this is stored.
   */
  role?: Role;

  /** Overrides the generated display name, when a test asserts on it. */
  name?: string;
};

export type SeededUser = {
  id: string;
  email: string;
  name: string;
  sessionToken: string;
};

/**
 * Creates the user, the session, and — when a role is given — the carpool
 * search behind it. Returns what a test needs to identify the user it just
 * made.
 *
 * Every identifier is random, so tests do not have to be serialised against
 * each other and the suite needs no truncation between tests. That is a
 * deliberate difference from the Jest integration suite, which truncates in
 * `beforeEach` and therefore runs `maxWorkers: 1`; a browser suite is slow
 * enough that giving up parallelism to reuse a fixed email would cost real
 * time. `e2e/global-setup.ts` empties the database once per run instead.
 */
export const seedSessionUser = async (
  prisma: PrismaClient,
  options: SeedSessionOptions = {},
): Promise<SeededUser> => {
  const { permission = "USER", isOnboarded = true, role, name } = options;

  // `randomUUID` rather than a counter: Playwright runs workers in separate
  // processes, so a counter would collide across them without a shared lock.
  const handle = randomUUID();
  const displayName = name ?? `E2E User ${handle.slice(0, 8)}`;

  const user = await prisma.user.create({
    data: {
      name: displayName,
      // `@example.com` is reserved by RFC 2606 and can never be delivered to.
      // It matters here beyond tidiness: `user.email.*` sends real mail through
      // SES, so a seeded address that could receive it is a loaded gun pointed
      // at whoever owns the domain.
      email: `e2e-${handle}@example.com`,
      permission,
      isOnboarded,
    },
  });

  if (role !== undefined) {
    // Two rows, because `CarpoolSearch` requires both a company and a home
    // location and neither is nullable. The coordinates are left at their
    // schema defaults of 0: this skeleton asserts nothing about matching, and
    // a fixture carrying plausible-looking coordinates invites a later test to
    // depend on numbers nobody chose.
    const [companyLocation, homeLocation] = await Promise.all([
      prisma.location.create({ data: {} }),
      prisma.location.create({ data: {} }),
    ]);

    await prisma.carpoolSearch.create({
      data: {
        userId: user.id,
        role,
        companyLocationId: companyLocation.id,
        homeLocationId: homeLocation.id,
      },
    });
  }

  const sessionToken = randomUUID();
  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + SESSION_LIFETIME_MS),
    },
  });

  return {
    id: user.id,
    email: user.email as string,
    name: displayName,
    sessionToken,
  };
};

/**
 * Puts a seeded session's token into the browser context, so every request it
 * makes — page navigations and `context.request` calls alike — is
 * authenticated as that user.
 *
 * `url` rather than an explicit domain and path: Playwright derives both from
 * it, which keeps the cookie's scope tied to {@link E2E_BASE_URL} instead of to
 * a second hand-written copy of the host.
 */
export const attachSessionCookie = async (
  context: BrowserContext,
  sessionToken: string,
): Promise<void> => {
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: sessionToken,
      url: E2E_BASE_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
};
