/**
 * That the onboarding wizard's `Previous`/`Continue` strip is a *sibling of the
 * card*, inside the same full-screen flex container, rather than an overlay
 * floating above it.
 *
 * This is the durable half of SCRUM-467. The defect was geometric - the fixed
 * strip covered the bottom 70px of every step's scroll area at 375x667 - and
 * **jsdom cannot see that**: no layout, no `getBoundingClientRect`, no `dvh`,
 * no paint order, and `env()` is actively mangled. See `src/testing/viewport.ts`
 * for the measurements behind each of those claims. So nothing here asserts
 * that the overlap is gone.
 *
 * What it asserts is the tree shape that *makes* the overlap impossible: the
 * strip and the card share a flex parent, so the browser sizes the two against
 * each other. A future edit that lifts the strip back out to the page root -
 * which is exactly what it used to be - restores the defect silently, and this
 * is the assertion that catches it. The geometry belongs in SCRUM-264's
 * Playwright suite.
 *
 * **Deliberately not co-located with the page.** Under `src/pages/` a filename
 * is also a route: `pageExtensions` includes `.ts`/`.tsx`, so
 * `setup.test.tsx` beside the page would be compiled and shipped as
 * `/profile/setup.test`, and `scripts/check-page-routes.js` fails the build for
 * it. This sits beside the step components the page composes, the way
 * `AdminPage.test.tsx` does.
 */

import { render, screen, act } from "@testing-library/react";
import {
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/*
 * `getServerSideProps` is not exercised here, and left unmocked these two pull
 * the NextAuth server config, its Prisma adapter and the AWS clients behind it
 * into a component test. Same reasoning as `AdminPage.test.tsx`.
 */
jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

/*
 * The page holds a spinner until `user.me` resolves, so the buttons do not
 * exist at all without this. The fields are only those the page reads back
 * into the form.
 *
 * `mapbox.search` is here because the page calls `useAddressSelection` twice at
 * the top level, before any step renders - so the address lookup is reached on
 * every step, not only step 2. It returns nothing: no step that queries it is
 * rendered unmocked, and a real call would spend Mapbox quota.
 */
jest.mock("../../utils/trpc", () => ({
  trpc: {
    mapbox: {
      search: { useQuery: () => ({ data: undefined, error: null }) },
    },
    user: {
      me: {
        useQuery: () => ({
          data: {
            role: "RIDER",
            seatAvail: 0,
            status: "ACTIVE",
            companyName: "",
            companyAddress: "",
            startAddress: "",
            preferredName: "",
            pronouns: "",
            daysWorking: "0,1,1,1,1,1,0",
            startTime: null,
            endTime: null,
            coopStartDate: null,
            coopEndDate: null,
            bio: "",
            startCoordLng: 0,
            startCoordLat: 0,
            companyCoordLng: 0,
            companyCoordLat: 0,
          },
        }),
      },
    },
  },
}));

jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: jest.fn(),
  trackFTUECompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: jest.fn(),
  useEditUserMutation: () => ({ mutate: jest.fn() }),
}));

/*
 * The step components are markers. The subject is where the navigation strip
 * sits in the tree, and rendering the real steps would put that behind a date
 * picker, a file upload and the Mapbox address combobox.
 *
 * `InitialStep` is the exception: it keeps a working trigger, because step 0 is
 * the one step that renders *no* strip (`step > 0` gates it), so the test has
 * to advance past it to have a subject at all.
 */
jest.mock("../../components/Setup/InitialStep", () => ({
  __esModule: true,
  default: ({ handleNextStep }: { handleNextStep: () => void }) => (
    <button type="button" onClick={handleNextStep}>
      advance
    </button>
  ),
}));
jest.mock("../../components/Setup/StepTwo", () => ({
  __esModule: true,
  default: () => <div>step two</div>,
}));
jest.mock("../../components/Setup/StepThree", () => ({
  __esModule: true,
  default: () => <div>step three</div>,
}));
jest.mock("../../components/Setup/StepFour", () => ({
  __esModule: true,
  default: () => <div>step four</div>,
}));
jest.mock("../../components/Setup/ProgressBar", () => ({
  __esModule: true,
  default: () => <div>progress</div>,
}));

import Setup from "../../pages/profile/setup";

restoreViewportAfterEach();

/**
 * Renders the wizard and advances to step 1, the first step that draws the
 * navigation strip.
 */
const renderAtStepOne = async () => {
  setViewportWidth(MOBILE_WIDTH);
  const view = render(<Setup />);

  await act(async () => {
    screen.getByRole("button", { name: "advance" }).click();
  });

  return view;
};

/**
 * The card, found by the class `SetupContainer` owns rather than by a test id.
 * `w-[90%]` is the width declaration that component's own comment describes as
 * having exactly one owner, which makes it a stable handle.
 */
const cardOf = (container: HTMLElement) =>
  container.querySelector(".w-\\[90\\%\\]");

describe("the onboarding wizard's navigation strip", () => {
  it("renders inside the same flex container as the card, not at the page root", async () => {
    const { container } = await renderAtStepOne();

    const continueButton = screen.getByRole("button", { name: /Continue/ });
    const card = cardOf(container);
    expect(card).not.toBeNull();

    // The shared parent is the point. Before the fix the strip was a `fixed`
    // element at the page root, so the card's nearest common ancestor with it
    // was the outermost `<div>` - and no height either one had was related to
    // the other's.
    const sharedParent = card!.parentElement;
    expect(sharedParent).not.toBeNull();
    expect(sharedParent!.contains(continueButton)).toBe(true);
  });

  it("is a flex sibling of the card, so the container sizes the two together", async () => {
    const { container } = await renderAtStepOne();

    const card = cardOf(container);
    const strip = screen.getByRole("button", {
      name: /Continue/,
    }).parentElement;

    // Siblings, not nested: the strip is not *inside* the scroll area either,
    // which would put it in the content it is supposed to sit below.
    expect(strip!.parentElement).toBe(card!.parentElement);
    expect(card!.contains(strip)).toBe(false);

    const wrapper = card!.parentElement!;
    expect(wrapper.className).toContain("flex-col");
    // Restores the original row direction above the breakpoint, which is what
    // keeps the 500px desktop card from shrinking on a short window: a flex
    // item only shrinks along the main axis.
    expect(wrapper.className).toContain("desktop:flex-row");
  });

  it("reserves the home-indicator inset below the buttons", async () => {
    const { container } = await renderAtStepOne();

    const wrapper = cardOf(container)!.parentElement!;

    /*
     * The `0px` fallback is load-bearing, for the reason `breakpoints.js`
     * spells out: `env()` with no fallback invalidates the whole `calc()` on a
     * browser that does not know the variable, dropping the padding entirely
     * rather than dropping the inset.
     *
     * This asserts the class is *requested*, and nothing more. jsdom mangles
     * `env()` and resolves no units, so whether the inset is honoured needs a
     * real device - see `src/testing/viewport.ts`.
     */
    expect(wrapper.className).toContain(
      "pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]",
    );
  });

  it("no longer clamps the card with a viewport unit", async () => {
    const { container } = await renderAtStepOne();

    const card = cardOf(container) as HTMLElement;

    /*
     * `maxHeight: "85vh"` used to sit here. `vh` resolves against the *large*
     * viewport on iOS Safari, so it clamped against space the user could not
     * see; the flex container now does the arithmetic instead.
     *
     * An inline style is one of the few things jsdom reports faithfully - it
     * echoes the declared value back - so this reads the declaration, not a
     * computed length.
     */
    expect(card.style.maxHeight).toBe("");
    expect(card.getAttribute("style") ?? "").not.toContain("vh");
  });

  it("lets the card shrink, which is what makes the flex cap work at all", async () => {
    const { container } = await renderAtStepOne();

    /*
     * A flex item's default `min-height: auto` would floor the card at the full
     * per-step height from `mobileHeights`, overflowing the column and pushing
     * the buttons off the bottom of the viewport - trading the overlap for
     * something worse.
     *
     * Both of these zero that automatic minimum, and in a browser either alone
     * is enough (`overflow-y-auto` zeroes it because the rule only applies to a
     * `visible` overflow). They are asserted as a pair because the page relies
     * on the card shrinking and this is the only place that records it - jsdom
     * resolves no layout, so neither is observed working here, only requested.
     */
    const cardClasses = (cardOf(container) as HTMLElement).className;
    expect(cardClasses).toContain("min-h-0");
    expect(cardClasses).toContain("overflow-y-auto");
  });
});
