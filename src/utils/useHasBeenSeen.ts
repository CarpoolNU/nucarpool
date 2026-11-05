import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether an element has ever actually been on screen.
 *
 * Built for impression analytics, where "rendered" and "seen" are different
 * questions and only the second one is worth counting. The explore page is
 * what forces the distinction: its mobile sheet expresses every detent as a
 * class on a wrapper that never unmounts its children, so a notice inside it
 * is mounted — and its effects run — in the `hidden` (`display: none`) and
 * `collapsed` (`h-0`) states alike. React effects do not consult CSS, so an
 * effect is not evidence of an impression. See `src/pages/index.tsx`.
 *
 * **Latched, not live.** Once seen, always seen: an impression is a thing that
 * happened, and a reader who scrolls the notice back off screen has still seen
 * it. That also makes the value safe as an effect dependency, because it
 * transitions at most once.
 *
 * ## A callback ref, not a `useRef`
 *
 * The consumer renders nothing until it has something to show, so the element
 * does not exist on the first render. A `useEffect` reading a `RefObject`
 * would therefore run against `null` and never re-run, because assigning
 * `.current` is not a state change and schedules nothing. A callback ref is
 * invoked by React exactly when the node attaches and again when it detaches,
 * which is the signal this needs.
 *
 * It is wrapped in `useCallback` with an empty dependency list so its identity
 * is stable: React re-invokes a callback ref whose identity changed on every
 * render, which would tear down and rebuild the observer continuously.
 *
 * **StrictMode attaches, detaches and re-attaches**, so the ref callback runs
 * more than once per mount in development and in every component test. Each
 * invocation disconnects whatever it replaced, so there is one live observer
 * per mounted element rather than one per invocation. The stub in
 * `src/testing/intersectionObserverStub.ts` exposes `liveObservers` precisely
 * so a test can hold that line.
 *
 * ## It fails open
 *
 * Where `IntersectionObserver` does not exist the element counts as seen
 * immediately, which is the behaviour this hook replaced. That is the right
 * default for a measurement: a missing browser API must not silently zero an
 * instrument, because the result is indistinguishable from a feature nobody
 * ever looked at, and it is the reading that would be acted on. In practice
 * this path is jsdom — every browser this app supports has had the API since
 * 2019 — which is why a test asserting the gate has to install the stub.
 *
 * @returns `ref` to attach to the element, and `hasBeenSeen`
 */
export const useHasBeenSeen = <T extends Element>() => {
  const [hasBeenSeen, setHasBeenSeen] = useState(false);

  /**
   * The live observer, so each ref invocation can retire the one before it.
   * A ref rather than state: nothing renders from it, and writing state here
   * would loop through the callback ref that set it.
   */
  const observerRef = useRef<IntersectionObserver | null>(null);

  /**
   * The latch, duplicated out of state so the ref callback can read it
   * synchronously. A re-attach after the element has been seen must not start
   * a second observer, and `hasBeenSeen` from the closure would be stale at
   * exactly that moment.
   */
  const seenRef = useRef(false);

  const disconnect = () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  };

  const ref = useCallback((node: T | null) => {
    disconnect();

    if (node === null || seenRef.current) {
      return;
    }

    if (
      typeof window === "undefined" ||
      typeof window.IntersectionObserver === "undefined"
    ) {
      seenRef.current = true;
      setHasBeenSeen(true);
      return;
    }

    const observer = new window.IntersectionObserver((entries) => {
      /* Matched on the target rather than taking `entries[0]`: one observer
         watches one node here, but a callback that assumed so would be wrong
         the first time it did not. */
      const entry = entries.find((candidate) => candidate.target === node);
      if (!entry?.isIntersecting) {
        return;
      }

      seenRef.current = true;
      /* Unobserve *and* disconnect. Either alone would do, and the pair is
         what makes the intent legible to the test that checks for a leak. */
      observer.unobserve(node);
      disconnect();
      setHasBeenSeen(true);
    });

    observer.observe(node);
    observerRef.current = observer;
  }, []);

  /* An unmount between attaching and intersecting leaves an observer holding
     a detached node, which keeps it alive. Nothing else tears that one down:
     the ref callback's own `null` invocation covers a detach, but not every
     path to unmount runs one first. */
  useEffect(() => disconnect, []);

  return { ref, hasBeenSeen };
};

export default useHasBeenSeen;
