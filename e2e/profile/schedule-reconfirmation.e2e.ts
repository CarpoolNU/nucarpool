/**
 * SCRUM-733, through the real stack: a production build, a real session
 * cookie, real tRPC over HTTP, and a real MySQL row.
 *
 * The jsdom suite (`profileScheduleReconfirmation.test.tsx`) proves the page's
 * decisions against a stubbed `user.edit`. What it cannot prove is what this
 * file is for:
 *
 *  - **"Never writes" holds on the wire.** Confirming or snoozing sends no
 *    mutation at all, and the stored row is byte-for-byte what it was.
 *  - **A correction is the user's own authenticated save.** It goes through
 *    `user.edit` with the session's identity, lands in the row, and the
 *    notice then goes away by itself on the real `user.me` refetch. That
 *    refetch is inert in the jsdom harness.
 *  - **An answer survives a real reload.**
 *
 * Every test seeds its own user, so the suite stays parallel. The antd panel
 * is driven by role and text, never by a class name. See the rule on `e2e/`
 * in `CLAUDE.md`.
 */

import type { Page, Request } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { CURRENT_TERMS_VERSION } from "../../src/utils/termsAcceptance";
import { expect, test } from "../support/fixtures";

/** Stored values as Prisma reads `TIME(0)` back: epoch-dated UTC times of day. */
const stored = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));

/**
 * A complete, live RIDER whose stored schedule is 9:00 AM to 5:00 AM (stored
 * `14:00`-`10:00`; Boston is UTC-5 at the anchor date). Complete because a
 * correction must survive `user.edit`'s validation, which wants both co-op
 * dates, working days and resolved addresses.
 *
 * Terms accepted too: without them the app opens its Terms and Conditions
 * dialog over every page, and that modal, not the notice, has the page.
 */
const seedMisPickedRider = async (
  prisma: PrismaClient,
  userId: string,
): Promise<string> => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      licenseSigned: true,
      licenseSignedAt: new Date(),
      licenseVersion: CURRENT_TERMS_VERSION,
    },
  });
  const search = await prisma.carpoolSearch.findUniqueOrThrow({
    where: { userId },
  });
  const year = new Date().getUTCFullYear();

  await prisma.location.update({
    where: { id: search.homeLocationId },
    data: {
      streetAddress: "360 Huntington Ave, Boston, MA 02115",
      street: "360 Huntington Ave",
      city: "Boston",
      state: "MA",
      coordLng: -71.0892,
      coordLat: 42.3398,
    },
  });
  await prisma.location.update({
    where: { id: search.companyLocationId },
    data: {
      streetAddress: "1 City Hall Sq, Boston, MA 02201",
      street: "1 City Hall Sq",
      city: "Boston",
      state: "MA",
      coordLng: -71.0589,
      coordLat: 42.3601,
    },
  });
  await prisma.carpoolSearch.update({
    where: { id: search.id },
    data: {
      status: "ACTIVE",
      companyName: "Acme",
      daysWorking: "0,1,1,1,1,1,0",
      startTime: stored(14),
      endTime: stored(10),
      startDate: new Date(Date.UTC(year, 0, 31)),
      // Next year, so the co-op is live whenever this runs.
      endDate: new Date(Date.UTC(year + 1, 5, 30)),
    },
  });

  return search.id;
};

const storedSchedule = async (prisma: PrismaClient, searchId: string) => {
  const row = await prisma.carpoolSearch.findUniqueOrThrow({
    where: { id: searchId },
    select: { startTime: true, endTime: true },
  });
  return {
    startTime: row.startTime?.toISOString(),
    endTime: row.endTime?.toISOString(),
  };
};

/** Every tRPC mutation the page sends from now on. Queries are GETs. */
const recordMutations = (page: Page): Request[] => {
  const sent: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/trpc/")) {
      sent.push(request);
    }
  });
  return sent;
};

const notice = (page: Page) =>
  page.getByRole("region", { name: "Please confirm your work schedule" });

/**
 * The profile has rendered from `user.me`, and nothing modal is over it. The
 * notice is planned in the same render, so an absence asserted after this is
 * not vacuous. The tab reads "Carpool" on mobile and "Carpool Details" on
 * desktop. The dialog check is what caught the Terms dialog covering the page.
 */
const profileLoaded = async (page: Page) => {
  await expect(
    page.getByRole("button", { name: /^Carpool( Details)?$/ }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
};

test.describe("/profile asks about a stored mis-pick shape", () => {
  test("shows the stored schedule exactly, and confirming writes nothing and holds across a reload", async ({
    page,
    prisma,
    signInAs,
  }) => {
    const user = await signInAs({ role: "RIDER" });
    const searchId = await seedMisPickedRider(prisma, user.id);
    const before = await storedSchedule(prisma, searchId);

    await page.goto("/profile");
    await profileLoaded(page);

    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText(
      "Your saved schedule is 9:00 AM to 5:00 AM the next day (20 hours).",
    );

    const mutations = recordMutations(page);
    await notice(page)
      .getByRole("button", { name: "Yes, these hours are correct" })
      .click();

    await expect(notice(page)).toBeHidden();
    expect(mutations.map((r) => r.url())).toEqual([]);
    expect(await storedSchedule(prisma, searchId)).toEqual(before);

    await page.reload();
    await profileLoaded(page);
    await expect(notice(page)).toHaveCount(0);
    expect(mutations.map((r) => r.url())).toEqual([]);
  });

  test("Remind me later writes nothing and holds across a reload", async ({
    page,
    prisma,
    signInAs,
  }) => {
    const user = await signInAs({ role: "RIDER" });
    const searchId = await seedMisPickedRider(prisma, user.id);
    const before = await storedSchedule(prisma, searchId);

    await page.goto("/profile");
    await profileLoaded(page);
    const mutations = recordMutations(page);
    await notice(page).getByRole("button", { name: "Remind me later" }).click();

    await expect(notice(page)).toBeHidden();
    await page.reload();
    await profileLoaded(page);
    await expect(notice(page)).toHaveCount(0);
    expect(mutations.map((r) => r.url())).toEqual([]);
    expect(await storedSchedule(prisma, searchId)).toEqual(before);
  });

  test("a correction is the user's own save, and the notice goes once the row changes", async ({
    page,
    prisma,
    signInAs,
  }) => {
    const user = await signInAs({ role: "RIDER" });
    const searchId = await seedMisPickedRider(prisma, user.id);

    await page.goto("/profile");
    await profileLoaded(page);
    await notice(page)
      .getByRole("button", { name: "Update my schedule" })
      .click();

    // The Carpool tab, with the notice still above it and focus on its
    // heading rather than lost to the page.
    await expect(
      page.getByRole("heading", { name: "Please confirm your work schedule" }),
    ).toBeFocused();
    const endTime = page.getByLabel("End Time");
    await expect(endTime).toHaveValue("5:00 AM");

    // Open the end picker and switch its meridiem. Each column of the panel is
    // a listbox of options, and a closed picker leaves its panel in the DOM,
    // so only the open picker's column is visible. A meridiem option is named
    // by its raw value ("pm"), not its "PM" text, so the name matches either
    // case.
    await endTime.click();
    await page
      .getByRole("listbox", { name: "Select a meridiem" })
      .filter({ visible: true })
      .getByRole("option", { name: /^pm$/i })
      .click();
    // A pick commits when the picker closes. Clicking away closes it.
    await page.getByRole("heading", { name: "Carpool Details" }).click();
    await expect(endTime).toHaveValue("5:00 PM");
    await expect(
      page.getByText("Your shift: 9:00 AM to 5:00 PM (8 hours)"),
    ).toBeVisible();

    const mutations = recordMutations(page);
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      page.getByText("User profile updated successfully!"),
    ).toBeVisible();
    expect(mutations.map((r) => new URL(r.url()).pathname)).toEqual([
      "/api/trpc/user.edit",
    ]);
    expect(await storedSchedule(prisma, searchId)).toEqual({
      startTime: "1970-01-01T14:00:00.000Z",
      endTime: "1970-01-01T22:00:00.000Z",
    });

    // The save refetched `user.me`, so the notice has nothing left to ask.
    await expect(notice(page)).toHaveCount(0);
    await page.reload();
    await profileLoaded(page);
    await expect(notice(page)).toHaveCount(0);
  });

  test("shows nothing for a real night shift", async ({
    page,
    prisma,
    signInAs,
  }) => {
    const user = await signInAs({ role: "RIDER" });
    const searchId = await seedMisPickedRider(prisma, user.id);
    // 10:30 PM to 6:30 AM.
    await prisma.carpoolSearch.update({
      where: { id: searchId },
      data: { startTime: stored(3, 30), endTime: stored(11, 30) },
    });

    await page.goto("/profile");
    await profileLoaded(page);

    await expect(notice(page)).toHaveCount(0);
  });
});
