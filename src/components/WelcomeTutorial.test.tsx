/**
 * The first-run driver.js tour, and the two things that used to destroy it.
 *
 * `WelcomeTutorial` built and started its tour inside a `useEffect` whose
 * dependency array contained `handleComplete`, a `useCallback` over the object
 * returned by `trpc.user.completeTutorial.useMutation()`. React Query v5's
 * `useMutation` ends in `return { ...result, mutate, mutateAsync: result.mutate }`
 * - a fresh object literal on *every* render - so that dependency never
 * compared equal and the effect's cleanup-plus-setup pair ran on every render
 * of the component, not once per mount.
 *
 * The cleanup was `driverInstance.destroy()`, and driver.js's public `destroy`
 * is bound to `h(false)`. The `false` is what makes it skip the
 * `onDestroyStarted` guard and fall straight through to the real teardown,
 * which still invokes `onDestroyed` - which was wired to `handleComplete`. So
 * every re-render tore the live tour down, marked the tutorial complete in the
 * database, and started a new tour from step 1. SCRUM-527.
 *
 * ---
 *
 * **Why the driver.js fake is shaped the way it is.** The defect lives in the
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
 * of *constructions*, so they are asserted with `reactStrictMode: false`, which
 * is what the ticket's original measurement used and what production actually
 * runs. The last block puts StrictMode back and asserts the thing that does
 * survive the double-invoke: one *live* tour and zero mutations. Both matter -
 * the first is the regression, the second is what proves the cleanup no longer
 * completes the tutorial even when React is the one calling it.
 */

import { configure, render } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { trpc } from "../utils/trpc";
import useIsMobile from "../utils/useIsMobile";
import WelcomeTutorial from "./WelcomeTutorial";

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

jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

jest.mock("../utils/useIsMobile", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

jest.mock("../utils/trpc", () => ({
  trpc: {
    useUtils: jest.fn(),
    user: {
      completeTutorial: { useMutation: jest.fn() },
    },
  },
}));

const mockedTrpc = trpc as unknown as {
  useUtils: jest.Mock;
  user: { completeTutorial: { useMutation: jest.Mock } };
};
const mockedUseSession = useSession as unknown as jest.Mock;
const mockedUseIsMobile = useIsMobile as unknown as jest.Mock;

/**
 * `mutateAsync` is `result.mutate` off the `MutationObserver`, which
 * `useMutation` holds in `useState` - so the *function* is stable across
 * renders while the object wrapping it is not. Reproducing exactly that split
 * is the point: a fake returning one frozen object would hide the defect.
 */
const mutateAsync = jest.fn(async () => undefined);

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

const renderHarness = () => render(<Harness tick={0} />);

let confirmSpy: jest.SpyInstance<boolean, [message?: string]>;

beforeEach(() => {
  mockDriverInstances.length = 0;
  jest.clearAllMocks();

  mockedUseIsMobile.mockReturnValue(false);
  mockedUseSession.mockReturnValue({
    data: { user: { name: "Ada Lovelace" } },
    update: jest.fn(async () => null),
  });
  mockedTrpc.useUtils.mockReturnValue({
    user: { me: { invalidate: jest.fn() } },
  });
  // A new object literal per call, exactly as React Query v5 returns.
  mockedTrpc.user.completeTutorial.useMutation.mockImplementation(() => ({
    mutateAsync,
    isPending: false,
  }));

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
      rerender(<Harness tick={tick} />);
    }

    expect(mockDriverInstances).toHaveLength(1);
    expect(totalDriveCalls()).toBe(1);
  });

  it("fires no completeTutorial mutation when the parent re-renders", () => {
    const { rerender } = renderHarness();
    expect(mutateAsync).not.toHaveBeenCalled();

    for (let tick = 1; tick <= 5; tick++) {
      rerender(<Harness tick={tick} />);
    }

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("fires no completeTutorial mutation when unmounted mid-tour", () => {
    const { unmount } = renderHarness();
    const tour = currentDriver();

    unmount();

    // The tour is still torn down - it just is not reported as finished.
    expect(tour.destroy).toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("fires exactly one mutation when the user finishes the last step", () => {
    renderHarness();
    const tour = currentDriver();
    tour.hasNextStep.mockReturnValue(false);

    tour.simulateGuardedExit();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(tour.destroyed).toBe(true);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("fires exactly one mutation when the user closes the tour early and confirms", () => {
    renderHarness();
    const tour = currentDriver();

    tour.simulateCloseButton();

    expect(confirmSpy).toHaveBeenCalledWith(
      "Are you sure you want to skip the tour?",
    );
    expect(tour.destroyed).toBe(true);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("leaves the tour running and fires nothing when the user declines the skip prompt", () => {
    confirmSpy.mockReturnValue(false);
    renderHarness();
    const tour = currentDriver();

    tour.simulateCloseButton();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(tour.destroyed).toBe(false);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not re-complete when the tour is torn down twice", () => {
    renderHarness();
    const tour = currentDriver();
    tour.hasNextStep.mockReturnValue(false);

    tour.simulateGuardedExit();
    tour.destroy();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("WelcomeTutorial under StrictMode", () => {
  // No `configure` here: `jest.setup.dom.ts` already turns StrictMode on, and
  // this block is the one that wants it. React's development double-invoke
  // mounts, tears down and remounts the effect, so construction counts are
  // doubled by design and only the surviving state is meaningful.

  it("leaves exactly one live tour and completes nothing on mount", () => {
    renderHarness();

    expect(liveInstances()).toHaveLength(1);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("still leaves exactly one live tour after the parent re-renders", () => {
    const { rerender } = renderHarness();
    const constructedOnMount = mockDriverInstances.length;

    for (let tick = 1; tick <= 5; tick++) {
      rerender(<Harness tick={tick} />);
    }

    expect(mockDriverInstances).toHaveLength(constructedOnMount);
    expect(liveInstances()).toHaveLength(1);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("completes nothing on unmount", () => {
    const { unmount } = renderHarness();

    unmount();

    expect(liveInstances()).toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("WelcomeTutorial without a signed-in name", () => {
  beforeEach(() => {
    mockedUseSession.mockReturnValue({
      data: null,
      update: jest.fn(async () => null),
    });
  });

  it("builds no tour at all", () => {
    renderHarness();

    expect(mockDriverInstances).toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
