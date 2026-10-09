/**
 * The first-run driver.js tour, and the two reasons a dependency on the
 * wrong value would destroy it on every render.
 *
 * `handleComplete` is a `useCallback` over the object
 * `trpc.user.completeTutorial.useMutation()` returns. React Query v5's
 * `useMutation` ends in `return { ...result, mutate, mutateAsync: result.mutate }`
 * - a fresh object literal on *every* render - so that object is never
 * referentially stable. If the tour effect depended on it directly, the
 * effect's cleanup-plus-setup pair would run on every render of the
 * component, not once per mount.
 *
 * The cleanup is `driverInstance.destroy()`, and driver.js's public `destroy`
 * is bound to `h(false)`. The `false` is what makes it skip the
 * `onDestroyStarted` guard and fall straight through to the real teardown,
 * which still invokes `onDestroyed` - wired to `handleComplete`. So that
 * dependency would tear the live tour down, mark the tutorial complete in the
 * database, and start a new tour from step 1, on every single render.
 *
 * ---
 *
 * **Why the driver.js fake is shaped the way it is.** The risk lives in the
 * interaction between React's effect lifecycle and driver.js's teardown, so the
 * fake has to reproduce driver.js's teardown faithfully or the test proves
 * nothing. Read off `node_modules/driver.js/dist/driver.js.cjs` v1.8.0:
 *
 *   - `destroy: () => h(!1)` - the public method. `h(e = !0)` returns early
 *     into `onDestroyStarted` only `if (e && a)`, so `e === false` bypasses the
 *     guard and reaches `s = t.getConfig("onDestroyed"); ... s(...)`.
 *   - Escape (`escapePress`), an overlay click and the popover's *default*
 *     close button all call `h()` - i.e. `h(true)` - which runs
 *     `onDestroyStarted` and nothing else. Whether anything is destroyed is
 *     then up to that hook.
 *   - A configured `onCloseClick` *replaces* that default: `z()` resolves
 *     `step.popover.onCloseClick || config.onCloseClick`, and the popover's
 *     click handler is `onCloseClick: g || n.onCloseClick` with the configured
 *     hook `g` winning. Its return value is discarded.
 *
 * `simulateGuardedExit` and `simulateCloseButton` below are those three
 * sentences in code.
 *
 * **Why two StrictMode regimes.** `jest.setup.dom.ts` renders every component
 * test under `<StrictMode>`, because production does. StrictMode deliberately
 * double-invokes effects on mount - setup, cleanup, setup - so "exactly one
 * driver.js instance is constructed" is not a statement that can be true
 * there, however correct the component is. The acceptance criteria are counts
 * of *constructions*, so they are asserted with `reactStrictMode: false`,
 * which matches what production actually runs. The last block puts
 * StrictMode back and asserts the thing that does survive the double-invoke:
 * one *live* tour and zero mutations. Both matter - the first catches a
 * construction-count regression, the second proves the cleanup does not
 * complete the tutorial even when React is the one calling it.
 */

import { act, configure, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { trpcSpies } from "../testing/trpcHarness";
import useIsMobile from "../utils/useIsMobile";
import {
  detentHeightPx,
  type SheetDetent,
} from "../utils/explore/sheetDetents";
import WelcomeTutorial, {
  MOBILE_STEP_DETENTS,
  SAFETY_STEP_DESCRIPTION,
  SAFETY_STEP_TITLE,
} from "./WelcomeTutorial";

/**
 * A driver.js instance as the fake models it. `destroyed` is the live/dead
 * flag the StrictMode assertions count, since call counts there are doubled by
 * React and say nothing.
 */
interface FakeDriver {
  config: Record<string, any>;
  destroyed: boolean;
  drive: jest.Mock;
  destroy: jest.Mock;
  hasNextStep: jest.Mock<boolean, []>;
  /** driver.js `h(true)`: Escape, an overlay click, or the default ✕. */
  simulateGuardedExit: () => void;
  /** The popover's ✕, which a configured `onCloseClick` takes over. */
  simulateCloseButton: () => void;
}

const mockDriverInstances: FakeDriver[] = [];

jest.mock("driver.js", () => ({
  driver: jest.fn((config: Record<string, any>) => {
    const instance: FakeDriver = {
      config,
      destroyed: false,
      drive: jest.fn(),
      destroy: jest.fn(() => {
        // `h(false)`: no `onDestroyStarted`, but `onDestroyed` still fires.
        instance.destroyed = true;
        config.onDestroyed?.(undefined, undefined, {});
      }),
      hasNextStep: jest.fn(() => true),
      simulateGuardedExit: () => {
        config.onDestroyStarted?.(undefined, undefined, {});
      },
      simulateCloseButton: () => {
        if (config.onCloseClick) {
          config.onCloseClick(undefined, undefined, {});
        } else {
          instance.simulateGuardedExit();
        }
      },
    };
    mockDriverInstances.push(instance);
    return instance;
  }),
}));

// The component imports driver.js's stylesheet for its side effect. Jest has no
// transform for `.css`, so it would be handed to `ts-jest` and fail the suite at
// load time. The path is a real export of the package, so this is an ordinary
// mock rather than a virtual one.
jest.mock("driver.js/dist/driver.css", () => ({}));

jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock(),
);

jest.mock("../utils/useIsMobile", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("react-toastify/unstyled", () =>
  require("../testing/toastStub").buildToastMock(),
);

/**
 * `completeTutorial` is React Query's **real** `useMutation`, through
 * `testing/trpcHarness.ts`. Nothing here is hand-reproduced: the object whose
 * identity the effect must not depend on is the one React Query itself
 * builds, so the test's subject is a property of the real hook rather than
 * of a fake that could only ever be as faithful as its author made it.
 *
 * That buys two things. `onSuccess` genuinely fires, on React Query's own
 * timeline, so `handleComplete`'s completion path - `invalidate`, the session
 * `update`, the ref reset - is exercised rather than skipped. And
 * `mutationFn` counts mutations the client actually *ran*.
 *
 * `user.me` is declared with no hooks because the component never queries it.
 * It is here for `useUtils`, which mirrors the spec's paths: `onSuccess` reaches
 * `utils.user.me.invalidate`, and a path the spec omits is absent from
 * `useUtils` too. Its `invalidate` stays a recording no-op, which is the
 * harness's default - reaching the live cache would refetch mid-assertion.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock({
    "user.completeTutorial": { mutation: async () => undefined },
    "user.me": {},
  }),
);

const mockedUseSession = useSession as unknown as jest.Mock;
const mockedUseIsMobile = useIsMobile as unknown as jest.Mock;

/**
 * The `completeTutorial` mutation, counted from inside the client.
 *
 * `mutationFn` rather than the `mutateAsync` spy: the component calls
 * `mutateAsync` off the result object, and what matters is whether the mutation
 * was carried out, not whether a method was entered. With the real
 * `useMutation` the two can differ - a second call while the first is in flight
 * still reaches `mutateAsync`.
 */
const completeTutorial = () => trpcSpies("user.completeTutorial").mutationFn;

/**
 * Lets a fired mutation reach its `mutationFn`, and its `onSuccess` run.
 *
 * React Query dispatches a mutation through a retryer that starts on a
 * microtask, so nothing is recorded during the call that triggers it.
 *
 * Draining is what keeps the *negative* cases honest too. "Fired no mutation"
 * is trivially true of every one of these tests at the instant the trigger
 * returns, so without this they would pass against a component that completes
 * the tutorial on every teardown - which is exactly what this file guards
 * against.
 */
const settleMutations = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Total `drive()` calls across every instance the component constructed. */
const totalDriveCalls = () =>
  mockDriverInstances.reduce((n, d) => n + d.drive.mock.calls.length, 0);

/** Instances that have not been destroyed - i.e. tours still on screen. */
const liveInstances = () => mockDriverInstances.filter((d) => !d.destroyed);

/** The tour the component most recently constructed. */
const currentDriver = () =>
  mockDriverInstances[mockDriverInstances.length - 1] as FakeDriver;

/**
 * A parent whose re-renders are driven from the test. `tick` exists only to
 * give `rerender` a changed prop; `WelcomeTutorial` itself takes none, and is
 * not memoised, so it re-renders with its parent.
 */
const Harness: React.FC<{ tick: number }> = () => <WelcomeTutorial />;

/**
 * The provider the real `useMutation` and the harness's `useUtils` both need -
 * `useUtils` calls `useQueryClient()` unconditionally, as tRPC's own does, so a
 * component reaching for utils outside a provider fails here the way it would
 * in the app.
 *
 * One client per *test*, created fresh so a mutation left in flight by one
 * cannot be observed by the next, and **stable across a `rerender`**. Both
 * halves are load-bearing. A `rerender` replaces the whole element, so the
 * provider has to be part of what is re-rendered or the second pass finds no
 * client; and handing it a *new* client would rebuild the `MutationObserver`,
 * which is the one thing these tests must not do - a re-render that resets the
 * mutation's own state is not the re-render the defect needed.
 */
const withClient = (client: QueryClient, tick: number) => (
  <QueryClientProvider client={client}>
    <Harness tick={tick} />
  </QueryClientProvider>
);

/** `render`, plus a `rerender` that takes the tick and keeps the client. */
const renderHarness = () => {
  const client = new QueryClient();
  const result = render(withClient(client, 0));

  return {
    ...result,
    rerender: (tick: number) => result.rerender(withClient(client, tick)),
  };
};

let confirmSpy: jest.SpyInstance<boolean, [message?: string]>;

beforeEach(() => {
  mockDriverInstances.length = 0;
  jest.clearAllMocks();

  mockedUseIsMobile.mockReturnValue(false);
  mockedUseSession.mockReturnValue({
    data: { user: { name: "Ada Lovelace" } },
    update: jest.fn(async () => null),
  });
  confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe.each([
  ["desktop", false],
  ["mobile", true],
])("WelcomeTutorial on %s (StrictMode off)", (_platform, isMobile) => {
  beforeEach(() => {
    // See the file header: the acceptance criteria count constructions, and
    // StrictMode's double-invoke makes that count unstateable. Production
    // renders each component once per render pass; this is that regime.
    configure({ reactStrictMode: false });
    mockedUseIsMobile.mockReturnValue(isMobile);
  });

  afterEach(() => {
    configure({ reactStrictMode: true });
  });

  it("builds exactly one tour and drives it once, however often the parent re-renders", () => {
    const { rerender } = renderHarness();

    expect(mockDriverInstances).toHaveLength(1);
    expect(totalDriveCalls()).toBe(1);

    for (let tick = 1; tick <= 5; tick++) {
      rerender(tick);
    }

    expect(mockDriverInstances).toHaveLength(1);
    expect(totalDriveCalls()).toBe(1);
  });

  it("fires no completeTutorial mutation when the parent re-renders", async () => {
    const { rerender } = renderHarness();
    expect(completeTutorial()).not.toHaveBeenCalled();

    for (let tick = 1; tick <= 5; tick++) {
      rerender(tick);
    }
    await settleMutations();

    expect(completeTutorial()).not.toHaveBeenCalled();
  });

  it("fires no completeTutorial mutation when unmounted mid-tour", async () => {
    const { unmount } = renderHarness();
    const tour = currentDriver();

    unmount();
    await settleMutations();

    // The tour is still torn down - it just is not reported as finished.
    expect(tour.destroy).toHaveBeenCalled();
    expect(completeTutorial()).not.toHaveBeenCalled();
  });

  it("fires exactly one mutation when the user finishes the last step", async () => {
    renderHarness();
    const tour = currentDriver();
    tour.hasNextStep.mockReturnValue(false);

    tour.simulateGuardedExit();
    await settleMutations();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(tour.destroyed).toBe(true);
    expect(completeTutorial()).toHaveBeenCalledTimes(1);
  });

  it("fires exactly one mutation when the user closes the tour early and confirms", async () => {
    renderHarness();
    const tour = currentDriver();

    tour.simulateCloseButton();
    await settleMutations();

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to skip the tour?",
    );
    expect(tour.destroyed).toBe(true);
    expect(completeTutorial()).toHaveBeenCalledTimes(1);
  });

  it("leaves the tour running and fires nothing when the user declines the skip prompt", async () => {
    confirmSpy.mockReturnValue(false);
    renderHarness();
    const tour = currentDriver();

    tour.simulateCloseButton();
    await settleMutations();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(tour.destroyed).toBe(false);
    expect(completeTutorial()).not.toHaveBeenCalled();
  });

  it("does not re-complete when the tour is torn down twice in one tick", async () => {
    renderHarness();
    const tour = currentDriver();
    tour.hasNextStep.mockReturnValue(false);

    /*
     * Both teardowns before the drain, and the title says "in one tick"
     * because with the real mutation this is a distinction the test has to
     * make. `isCompletingRef` is what blocks the second completion, and it is
     * only held *while the first mutation is in flight* - `onSuccess` clears
     * it. Draining between the two calls would therefore see two mutations.
     *
     * That is not a defect, and the reason is the component's other guard:
     * `isCleaningUp` is set before the `destroy()` in React's cleanup, so the
     * unmount teardown - the only second `destroy()` that actually happens in
     * production, and the one that would land after a success - never reaches
     * `handleComplete` at all. `completes nothing on unmount` covers that
     * path. What is left here is two teardowns inside one tick, which is
     * exactly the case `isCompletingRef` exists for.
     */
    tour.simulateGuardedExit();
    tour.destroy();
    await settleMutations();

    expect(completeTutorial()).toHaveBeenCalledTimes(1);
  });
});

describe("WelcomeTutorial under StrictMode", () => {
  // No `configure` here: `jest.setup.dom.ts` already turns StrictMode on, and
  // this block is the one that wants it. React's development double-invoke
  // mounts, tears down and remounts the effect, so construction counts are
  // doubled by design and only the surviving state is meaningful.

  it("leaves exactly one live tour and completes nothing on mount", async () => {
    renderHarness();
    await settleMutations();

    expect(liveInstances()).toHaveLength(1);
    expect(completeTutorial()).not.toHaveBeenCalled();
  });

  it("still leaves exactly one live tour after the parent re-renders", async () => {
    const { rerender } = renderHarness();
    const constructedOnMount = mockDriverInstances.length;

    for (let tick = 1; tick <= 5; tick++) {
      rerender(tick);
    }
    await settleMutations();

    expect(mockDriverInstances).toHaveLength(constructedOnMount);
    expect(liveInstances()).toHaveLength(1);
    expect(completeTutorial()).not.toHaveBeenCalled();
  });

  it("completes nothing on unmount", async () => {
    const { unmount } = renderHarness();

    unmount();
    await settleMutations();

    expect(liveInstances()).toHaveLength(0);
    expect(completeTutorial()).not.toHaveBeenCalled();
  });
});

/**
 * The mobile tour's two steps that target something the sheet can cover or
 * hide, and the detent each is supposed to force before it is measured or
 * shown.
 *
 * `reactStrictMode: false` for the same reason the construction-count block
 * above uses it: these tests read `setSheetDetent`'s call history, and
 * StrictMode's extra mount-teardown-remount would add calls from a tour that
 * never really ran, muddying what a test is checking.
 */
describe("WelcomeTutorial mobile sheet detent", () => {
  beforeEach(() => {
    configure({ reactStrictMode: false });
    mockedUseIsMobile.mockReturnValue(true);
  });

  afterEach(() => {
    configure({ reactStrictMode: true });
  });

  const renderMobile = (sheetDetent: SheetDetent, setSheetDetent: jest.Mock) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WelcomeTutorial
          sheetDetent={sheetDetent}
          setSheetDetent={setSheetDetent}
        />
      </QueryClientProvider>,
    );

  it("expands the sheet to a nonzero height before highlighting the sidebar step", () => {
    const setSheetDetent = jest.fn();
    renderMobile("collapsed", setSheetDetent);
    const tour = currentDriver();

    tour.config.steps[1].onHighlightStarted();

    expect(setSheetDetent).toHaveBeenCalledWith(MOBILE_STEP_DETENTS[1]);
    // "expanded" is a nonzero fraction of the sheet's height; "collapsed" -
    // the detent this test starts from, and a VIEWER's opening detent - is
    // exactly zero. Same arithmetic `MOBILE_SIDEBAR_CLASSES` in `pages/
    // index.tsx` renders as `h-0 opacity-0`.
    expect(
      detentHeightPx({
        detent: MOBILE_STEP_DETENTS[1]!,
        expandedHeightPx: 100,
      }),
    ).toBeGreaterThan(0);
  });

  it("collapses the sheet to zero height before highlighting the map step, so it does not cover the map", () => {
    const setSheetDetent = jest.fn();
    renderMobile("expanded", setSheetDetent);
    const tour = currentDriver();

    tour.config.steps[3].onHighlightStarted();

    expect(setSheetDetent).toHaveBeenCalledWith(MOBILE_STEP_DETENTS[3]);
    expect(
      detentHeightPx({
        detent: MOBILE_STEP_DETENTS[3]!,
        expandedHeightPx: 100,
      }),
    ).toBe(0);
  });

  it("expands the sheet before the safety step too, so arriving backwards from the map does not anchor it to a zero-height element", () => {
    const setSheetDetent = jest.fn();
    renderMobile("collapsed", setSheetDetent);
    const tour = currentDriver();

    tour.config.steps[2].onHighlightStarted();

    expect(setSheetDetent).toHaveBeenCalledWith(MOBILE_STEP_DETENTS[2]);
    expect(
      detentHeightPx({
        detent: MOBILE_STEP_DETENTS[2]!,
        expandedHeightPx: 100,
      }),
    ).toBeGreaterThan(0);
  });

  /**
   * The guard the detent map's docblock promises. Its keys are step indices,
   * so inserting a step silently repoints every key after it - the exact edit
   * SCRUM-624 made. Asserting the *set* of hooked indices rather than a count
   * means a future insertion either updates the map or fails here.
   */
  it("gives a detent entry to exactly the steps that drive the sheet, and to no others", () => {
    renderMobile("collapsed", jest.fn());
    const steps = currentDriver().config.steps;

    const hooked = steps
      .map((step: any, index: number) => (step.onHighlightStarted ? index : -1))
      .filter((index: number) => index >= 0);

    expect(hooked).toEqual(Object.keys(MOBILE_STEP_DETENTS).map(Number));
    expect(steps[1].element).toBe('[data-testid="explore-sidebar"]');
    expect(steps[2].element).toBe('[data-testid="explore-sidebar"]');
    expect(steps[3].element).toBe("#map");
  });

  it("restores the opening detent when the tour finishes", () => {
    const setSheetDetent = jest.fn();
    renderMobile("expanded", setSheetDetent);
    const tour = currentDriver();
    tour.hasNextStep.mockReturnValue(false);

    tour.simulateGuardedExit();

    expect(setSheetDetent).toHaveBeenCalledWith("expanded");
  });

  it("restores the opening detent when the user skips and confirms", () => {
    const setSheetDetent = jest.fn();
    renderMobile("collapsed", setSheetDetent);
    const tour = currentDriver();

    tour.simulateCloseButton();

    expect(setSheetDetent).toHaveBeenCalledWith("collapsed");
  });

  it("restores the opening detent when unmounted mid-tour without finishing", () => {
    const setSheetDetent = jest.fn();
    const { unmount } = renderMobile("half", setSheetDetent);

    unmount();

    expect(setSheetDetent).toHaveBeenCalledWith("half");
  });

  it("does not assert the presence of drivers in the sidebar step's copy, which a VIEWER or a DRIVER is shown none of", () => {
    const setSheetDetent = jest.fn();
    renderMobile("collapsed", setSheetDetent);
    const tour = currentDriver();

    const sidebarStep = tour.config.steps[1];
    expect(sidebarStep.popover.title.toLowerCase()).not.toContain("driver");
    expect(sidebarStep.popover.description.toLowerCase()).not.toContain(
      "driver",
    );
  });

  it("leaves the desktop tour's steps and copy unchanged", () => {
    mockedUseIsMobile.mockReturnValue(false);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WelcomeTutorial />
      </QueryClientProvider>,
    );
    const tour = currentDriver();

    expect(tour.config.steps[1].popover.title).toBe("These are drivers");
    expect(tour.config.steps[1].onHighlightStarted).toBeUndefined();
    expect(tour.config.steps[2].onHighlightStarted).toBeUndefined();
    expect(tour.config.steps[3].popover.title).toBe("This is the map");
    expect(tour.config.steps[3].onHighlightStarted).toBeUndefined();
  });
});

/**
 * The safety step (SCRUM-624).
 *
 * The tour is the only place a first-time user is told that Report and Block
 * exist at all: the menu holding them is a three-dot icon whose accessible
 * name is "More actions for {name}", which says nothing about what is inside,
 * and no other surface mentions either tool until somebody has already used
 * one. So "the step is present, in both variants, naming both tools and where
 * they live" is the acceptance criterion, asserted here rather than left to
 * the copy being eyeballed.
 *
 * Both variants read the same two exported constants, so the assertions below
 * are about the step existing and being anchored correctly; the copy itself
 * cannot differ between a phone and a laptop by construction.
 */
describe.each([
  ["desktop", false],
  ["mobile", true],
])("WelcomeTutorial safety step on %s", (_platform, isMobile) => {
  beforeEach(() => {
    configure({ reactStrictMode: false });
    mockedUseIsMobile.mockReturnValue(isMobile);
  });

  afterEach(() => {
    configure({ reactStrictMode: true });
  });

  const safetyStep = () => {
    renderHarness();
    return currentDriver().config.steps.find(
      (step: any) => step.popover.title === SAFETY_STEP_TITLE,
    );
  };

  it("is in the tour", () => {
    expect(safetyStep()).toBeDefined();
  });

  it("names both tools and the menu holding them", () => {
    const description = safetyStep().popover.description;

    expect(description).toBe(SAFETY_STEP_DESCRIPTION);
    expect(description).toContain("Report");
    expect(description).toContain("Block");
    expect(description).toMatch(/card and conversation/i);
  });

  it("states the two facts a user is actually deciding on", () => {
    const description = safetyStep().popover.description;

    // A report is read by admins alone - `reports.create` tells the reported
    // user nothing - and a block is reversible from the profile.
    expect(description).toMatch(/admins only/i);
    expect(description).toMatch(/never told/i);
    expect(description).toMatch(/undo it from your profile/i);
  });

  it("anchors to the sidebar, where the cards carrying that menu are", () => {
    expect(safetyStep().element).toBe('[data-testid="explore-sidebar"]');
  });

  it("says nothing about drivers, which a VIEWER or a DRIVER is shown none of", () => {
    expect(safetyStep().popover.title.toLowerCase()).not.toContain("driver");
    expect(safetyStep().popover.description.toLowerCase()).not.toContain(
      "driver",
    );
  });
});

/**
 * The terminal step's buttons (SCRUM-657).
 *
 * `showButtons` is an allow-list of the *whole* set of buttons driver.js
 * v1.8.0 renders, not an addition to a default one. Its popover renderer ends
 * in `nextButton.style.display = showButtons.includes("next") ? "block" :
 * "none"`, so a list naming only `close` hides the footer's next button.
 *
 * On the last step that button *is* the finish: driver.js computes
 * `nextBtnText: hasNextStep ? undefined : doneBtnText` and tags the element
 * `driver-popover-done-btn`, so it renders as **Done**, and clicking it runs
 * the same `h(true)` that Escape and the default ✕ do - reaching
 * `onDestroyStarted`, which declines to confirm because `hasNextStep()` is
 * false, and destroys. Omitting `next` there therefore removed the tour's one
 * obvious way to finish and left the corner ✕ as the way out.
 *
 * jsdom cannot see the defect itself - driver.js writes that `display` inline
 * at runtime and jsdom lays nothing out - so the configuration is the whole of
 * what a unit test can hold. These assertions hold it.
 */
describe.each([
  ["desktop", false],
  ["mobile", true],
])("WelcomeTutorial terminal step on %s", (_platform, isMobile) => {
  beforeEach(() => {
    configure({ reactStrictMode: false });
    mockedUseIsMobile.mockReturnValue(isMobile);
  });

  afterEach(() => {
    configure({ reactStrictMode: true });
  });

  const terminalStep = () => {
    renderHarness();
    const steps = currentDriver().config.steps;
    return steps[steps.length - 1];
  };

  it("is the step that says the tour is over", () => {
    const step = terminalStep();

    expect(step.popover.title).toBe("You're all set!");
    // Unanchored, like the opening step - it describes nothing on the page.
    expect(step.element).toBeUndefined();
  });

  it("shows the next button, which driver.js renders here as Done", () => {
    expect(terminalStep().popover.showButtons).toContain("next");
  });

  it("keeps the ✕ alongside it", () => {
    expect(terminalStep().popover.showButtons).toContain("close");
  });

  it("leaves driver.js's own Done label in place", () => {
    // The raw step popover is spread *after* the computed defaults, so a
    // `nextBtnText` here would overwrite the "Done" driver.js derived from
    // the step being last.
    expect(terminalStep().popover.nextBtnText).toBeUndefined();
  });

  it("still hides Previous on the opening step, which has no previous", () => {
    renderHarness();

    expect(currentDriver().config.steps[0].popover.showButtons).toEqual([
      "next",
      "close",
    ]);
  });
});

describe("WelcomeTutorial without a signed-in name", () => {
  beforeEach(() => {
    mockedUseSession.mockReturnValue({
      data: null,
      update: jest.fn(async () => null),
    });
  });

  it("builds no tour at all", async () => {
    renderHarness();
    await settleMutations();

    expect(mockDriverInstances).toHaveLength(0);
    expect(completeTutorial()).not.toHaveBeenCalled();
  });
});
