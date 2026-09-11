/**
 * That `/admin` keeps `Header` out of its server HTML.
 *
 * `Header` branches on `useIsMobile`, and the server cannot know the device,
 * so it emits the desktop branch - and React reads that same server snapshot
 * again during hydration. Every other page that renders `Header` escaped this
 * for free, because `trpc` is configured `ssr: false` and `/` and `/profile`
 * hold a spinner until `user.me` resolves. This page took its `userPermission`
 * from `getServerSideProps` instead, so its `Header` was in the server HTML and
 * hydrated the desktop branch once on a phone - mounting `DropDownMenu` behind
 * the bottom navigation that immediately replaced it.
 *
 * The two assertions are a pair and mean nothing apart: absent from the server
 * render, *and* present once hydrated. A page that simply stopped rendering
 * its header would pass the first alone.
 *
 * **Deliberately not co-located.** Under `src/pages/` a filename is also a
 * route - `pageExtensions` lists `tsx` first, so `admin.test.tsx` beside the
 * page would be compiled and shipped as `/admin.test`, and
 * `scripts/check-page-routes.js` fails the build for it. This sits beside the
 * components the page composes, which is where `pusherAuthEndpoint.test.ts`
 * put the same problem's solution: next to the other half of the feature.
 *
 * The page's children are mocked to markers. The subject is one conditional,
 * and rendering the real `UserManagement` and `AdminData` would put it behind
 * antd, JSZip, four chart components and a set of tRPC queries.
 */

import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * `authOptions` is imported by the page for `getServerSideProps`, which this
 * file does not exercise. Left unmocked it would pull the NextAuth server
 * config, its Prisma adapter and the AWS clients behind it into a component
 * test.
 */
jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

/**
 * A marker, so "is the header here" is one string search. Its text is what is
 * matched, which lets the hydrated side be read through `textContent` rather
 * than `innerHTML`.
 */
jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: () => <header>DESKTOP HEADER</header>,
}));

jest.mock("../../components/Admin/AdminSidebar", () => ({
  __esModule: true,
  default: () => <div>sidebar</div>,
}));
jest.mock("../../components/Admin/UserManagement", () => ({
  __esModule: true,
  default: () => <div>management</div>,
}));
jest.mock("../../components/Admin/AdminData", () => ({
  __esModule: true,
  default: () => <div>data</div>,
}));

/**
 * A marker like the rest. The notice's own behaviour - that its "Back to map"
 * button exists and navigates - is covered in `AdminMobileNotice.test.tsx`;
 * the subject here is only which of the two the page chooses.
 */
jest.mock("../../components/Admin/AdminMobileNotice", () => ({
  __esModule: true,
  default: () => <div>mobile notice</div>,
}));

import Admin from "../../pages/admin";
import { Permission } from "@prisma/client";

restoreViewportAfterEach();

const headerIsIn = (html: string) => html.includes("DESKTOP HEADER");

/** Server-render the page, then hydrate that HTML the way a page load does. */
const hydrateAdminAt = async (width: number) => {
  setViewportWidth(width);

  const page = <Admin userPermission={Permission.ADMIN} />;
  const serverHtml = renderToString(page);

  const container = document.createElement("div");
  /*
   * See the same disable in `utils/useProfileImage.test.tsx`: this markup is
   * `renderToString`'s own output for the page under test, and `hydrateRoot`
   * needs real DOM to reconcile against. The rule is about values that could
   * carry attacker-authored markup, which this is not.
   */
  // eslint-disable-next-line no-restricted-syntax
  container.innerHTML = serverHtml;
  document.body.appendChild(container);

  const consoleError = jest.spyOn(console, "error").mockImplementation();
  try {
    await act(async () => {
      hydrateRoot(container, page);
    });
  } finally {
    consoleError.mockRestore();
  }

  return { serverHtml, hydratedText: container.textContent ?? "" };
};

describe("/admin's header", () => {
  it("is absent from the server render, so nothing hydrates it", async () => {
    const { serverHtml } = await hydrateAdminAt(MOBILE_WIDTH);

    // The pre-fix page rendered `<Header admin={true} />` unconditionally,
    // above its own spinner branch, so this contained the desktop header at
    // every width.
    expect(headerIsIn(serverHtml)).toBe(false);
  });

  it("mounts on the client, where the viewport is known", async () => {
    const { hydratedText } = await hydrateAdminAt(DESKTOP_WIDTH);

    // The other half. Gating on a value that is false during hydration is
    // only correct if it becomes true immediately afterwards.
    expect(headerIsIn(hydratedText)).toBe(true);
  });

  it("still renders the page's own content while the header is deferred", async () => {
    const { serverHtml } = await hydrateAdminAt(DESKTOP_WIDTH);

    // The deferral is scoped to the header. The admin tool itself is server
    // rendered as before - this is not `next/dynamic` around the page.
    expect(serverHtml).toContain("sidebar");
    expect(serverHtml).toContain("management");
  });
});

describe("/admin's layout below the mobile breakpoint", () => {
  it("shows the notice instead of the dashboard on a phone", async () => {
    const { hydratedText } = await hydrateAdminAt(MOBILE_WIDTH);

    // The dashboard is a 175px sidebar beside four charts, which left them
    // about 200px at this width. The ticket's choice was to say so rather
    // than render into it.
    expect(hydratedText).toContain("mobile notice");
    expect(hydratedText).not.toContain("sidebar");
    expect(hydratedText).not.toContain("management");
  });

  it("leaves the desktop dashboard exactly as it was", async () => {
    const { hydratedText } = await hydrateAdminAt(DESKTOP_WIDTH);

    // The other half of the pair. A page that simply stopped rendering its
    // dashboard would pass the assertion above on its own.
    expect(hydratedText).toContain("sidebar");
    expect(hydratedText).toContain("management");
    expect(hydratedText).not.toContain("mobile notice");
  });

  it("keeps the dashboard in the server HTML even for a phone", async () => {
    const { serverHtml } = await hydrateAdminAt(MOBILE_WIDTH);

    /*
     * Not an oversight, and the reason the branch is gated on `useIsHydrated`
     * rather than on `useIsMobile` alone. The server cannot know the device,
     * so React renders - and re-reads during hydration - the desktop
     * snapshot; the notice replaces it on the pass after that. Asserting the
     * dashboard is still here is what pins the page to that shape, and keeps
     * the deferral scoped the way the header's already is above.
     *
     * **This is not a layout assertion.** jsdom does no layout, so nothing
     * here observes that the charts did not fit - see
     * `src/testing/viewport.ts`.
     */
    expect(serverHtml).toContain("sidebar");
    expect(serverHtml).not.toContain("mobile notice");
  });
});
