/**
 * A driveable `IntersectionObserver` for jsdom, which has none.
 *
 * ---
 *
 * **Read this before believing a green run proves viewability.** jsdom does no
 * layout: every element reports a zero `getBoundingClientRect()`, no stylesheet
 * is evaluated, and `display: none` is indistinguishable from a visible box.
 * A faithful `IntersectionObserver` is therefore *impossible* here — there is
 * no geometry for one to observe. The same limitation `src/testing/viewport.ts`
 * records at length.
 *
 * So this stub does not simulate intersection. It lets a test **state** what
 * the observer reports, and what it buys is the half of the behaviour that is
 * real logic rather than browser geometry:
 *
 *  - that the component observes the element at all;
 *  - that it does not act until the observer says the element is on screen;
 *  - that it acts exactly once when the observer says it is.
 *
 * Whether the mobile sheet's `h-0` collapse actually produces a non-intersecting
 * entry is a browser question, and nothing in this file answers it. See
 * `docs/testing.md`.
 *
 * ## Why the stub never fires on its own
 *
 * A real observer invokes its callback once per `observe` with the element's
 * initial state. Were this stub to do that with `isIntersecting: true`, every
 * gate built on it would pass its test while being wired to nothing — the
 * precise shape of the vacuous-assertion trap recorded for `queryByRole`
 * inside an inert subtree. It therefore stays silent until a test drives it,
 * and a test asserting that something *does* happen has to say so explicitly.
 */

import { act } from "@testing-library/react";

/**
 * The elements currently under observation, in observe order.
 *
 * An array rather than a `Set`, deliberately: a component that observes the
 * same element twice without disconnecting is leaking an observer, and a `Set`
 * would silently dedupe exactly the symptom worth catching.
 */
export type IntersectionObserverStub = {
  /** Every element passed to `observe`, in order, including repeats. */
  readonly observed: Element[];
  /** Elements whose observation was explicitly stopped. */
  readonly unobserved: Element[];
  /** How many observers are still live — never disconnected. */
  readonly liveObservers: number;
  /**
   * Report `isIntersecting` for every observed element, wrapped in `act` so
   * the resulting state update is flushed before the assertion that follows.
   */
  intersect: (isIntersecting: boolean) => void;
  /** Restore whatever `IntersectionObserver` was there before, if any. */
  restore: () => void;
};

type Callback = (entries: IntersectionObserverEntry[]) => void;

/**
 * Replace `window.IntersectionObserver` for the duration of a test.
 *
 * Call inside `beforeEach`, or at the top of the one test that needs it, and
 * `restore()` afterwards — or use `stubIntersectionObserverForEach`, which
 * wires both ends up for a whole file.
 */
export const installIntersectionObserverStub = (): IntersectionObserverStub => {
  const observed: Element[] = [];
  const unobserved: Element[] = [];
  const live = new Set<FakeObserver>();

  class FakeObserver {
    constructor(private readonly callback: Callback) {
      live.add(this);
    }

    private readonly targets: Element[] = [];

    observe(target: Element) {
      observed.push(target);
      this.targets.push(target);
    }

    unobserve(target: Element) {
      unobserved.push(target);
    }

    disconnect() {
      live.delete(this);
    }

    takeRecords() {
      return [];
    }

    /** Drive this observer's callback for everything it holds. */
    fire(isIntersecting: boolean) {
      if (this.targets.length === 0) {
        return;
      }
      this.callback(
        this.targets.map(
          (target) =>
            ({
              target,
              isIntersecting,
              /* Enough of an entry for a threshold-0 consumer. The remaining
                   fields are geometry, which jsdom cannot produce and which no
                   consumer here reads. */
              intersectionRatio: isIntersecting ? 1 : 0,
            }) as unknown as IntersectionObserverEntry,
        ),
      );
    }
  }

  const original = Object.getOwnPropertyDescriptor(
    window,
    "IntersectionObserver",
  );

  Object.defineProperty(window, "IntersectionObserver", {
    value: FakeObserver,
    writable: true,
    configurable: true,
  });

  return {
    observed,
    unobserved,
    get liveObservers() {
      return live.size;
    },
    intersect: (isIntersecting: boolean) => {
      act(() => {
        live.forEach((observer) => observer.fire(isIntersecting));
      });
    },
    restore: () => {
      if (original) {
        Object.defineProperty(window, "IntersectionObserver", original);
      } else {
        delete (window as { IntersectionObserver?: unknown })
          .IntersectionObserver;
      }
    },
  };
};

/**
 * Install a fresh stub before each test in a file and restore it after.
 *
 * Returns a getter rather than the stub itself, because the stub is rebuilt
 * per test — holding the value from the first one would quietly assert against
 * a dead observer for the rest of the file.
 */
export const stubIntersectionObserverForEach = () => {
  let current: IntersectionObserverStub | null = null;

  beforeEach(() => {
    current = installIntersectionObserverStub();
  });

  afterEach(() => {
    current?.restore();
    current = null;
  });

  return () => {
    if (!current) {
      throw new Error(
        "IntersectionObserver stub read outside a test — stubIntersectionObserverForEach installs it in beforeEach.",
      );
    }
    return current;
  };
};
