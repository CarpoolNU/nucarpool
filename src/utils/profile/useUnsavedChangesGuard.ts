import { useCallback, useEffect, useRef } from "react";
import type { NextRouter } from "next/router";

/**
 * Catches the ways off the profile page that no component can be made to ask
 * about first.
 *
 * The page already had an unsaved-changes guard, but an **opt-in** one:
 * `checkForChanges` ran only where some component remembered to call it, and
 * four controls did. Everything else left silently - an ordinary `next/link`
 * on the page itself, the header's admin button, browser back, refresh. The
 * detection was never the problem; `hasProfileChanges` has been correct and
 * tested throughout. What was missing is that interception lived at the call
 * sites, so protecting a new control meant remembering to wire it, and the
 * cost of forgetting was invisible - a user's edits, discarded with no
 * warning, on a page whose other exits all warned.
 *
 * Moving interception to the router inverts that. A link added to this page
 * tomorrow is guarded because it is a navigation, not because somebody
 * remembered. That is the entire point of the file, and the reason it is a
 * hook rather than four more `checkChanges` props.
 *
 * **It decides nothing about what changed.** Every listener below asks
 * `hasUnsavedChanges`, which the page implements with the same
 * `hasProfileChanges` call its modal already used. A second opinion about
 * dirtiness is exactly the thing that would drift.
 *
 * Three listeners, because the three exits are genuinely different mechanisms:
 *
 * | Exit                  | Mechanism          | Can show the modal? |
 * | --------------------- | ------------------ | ------------------- |
 * | `next/link`, `push`   | `routeChangeStart` | yes                 |
 * | back / forward        | `beforePopState`   | yes                 |
 * | refresh, tab close    | `beforeunload`     | no - native only    |
 */

/**
 * Thrown to abort a route change, and compared by identity.
 *
 * Aborting a Pages Router navigation means throwing from a `routeChangeStart`
 * listener - there is no documented return value that cancels. Next emits that
 * event **outside** its own `try` (`next/dist/shared/lib/router/router.js:844`,
 * where the `try` opens two lines later), so the throw escapes `change()` and
 * rejects the promise `router.push` returned. That rejection is the abort.
 *
 * It also means `routeChangeError` is **not** emitted on this path, which is
 * why `allowNavigation` releases the bypass itself rather than waiting for an
 * event that never arrives.
 *
 * `cancelled` matches the shape of Next's own `buildCancellationError`
 * (`router.js:65`), so anything already written to recognise a cancelled route
 * change recognises this one.
 */
export const ROUTE_CHANGE_ABORTED = Object.assign(
  new Error("Route change aborted: the profile form has unsaved changes."),
  { cancelled: true },
);

export type UnsavedChangesGuardOptions = {
  router: NextRouter;
  /** Whether anything would be lost by leaving right now. */
  hasUnsavedChanges: () => boolean;
  /** Whether a save is in flight. */
  isSaving: () => boolean;
  /**
   * Opens the unsaved-changes modal, holding `proceed` as the destination.
   *
   * A callback rather than a URL so the page can pass it straight to
   * `checkForChanges`, whose existing contract this already is.
   */
  onIntercept: (proceed: () => Promise<void>) => void;
};

export type UnsavedChangesGuard = {
  /**
   * Runs a navigation the page has decided on, without this guard catching it.
   *
   * Needed because answering the modal does not clean the form. Discard drops
   * the pending picture and leaves all fourteen fields as they were, so the
   * navigation that Discard then performs is still, to every listener here, a
   * navigation away from unsaved changes - and without this it would reopen
   * the modal it was dismissing, forever.
   */
  allowNavigation: (run: () => void | Promise<void>) => Promise<void>;
};

export const useUnsavedChangesGuard = ({
  router,
  hasUnsavedChanges,
  isSaving,
  onIntercept,
}: UnsavedChangesGuardOptions): UnsavedChangesGuard => {
  /**
   * The live options, re-pointed on every render.
   *
   * The listeners have to read current values - `hasUnsavedChanges` closes
   * over form state that changes on every keystroke - but resubscribing that
   * often would be wasteful and, if a cleanup were ever wrong, would leave a
   * pile of live handlers rather than one. A ref keeps the effect's
   * dependencies to `router` alone.
   */
  const options = useRef({ hasUnsavedChanges, isSaving, onIntercept });
  options.current = { hasUnsavedChanges, isSaving, onIntercept };

  /** Set while the page is performing a navigation it has already decided on. */
  const bypass = useRef(false);

  /**
   * Set between blocking a pop and the pop our own restore provokes.
   *
   * `router.forward()` moves the history stack, which fires `popstate` again
   * and re-enters the handler below. Without this the restore would be read as
   * a fresh attempt to leave, prompt a second time, and restore again.
   */
  const restoringHistory = useRef(false);

  const allowNavigation = useCallback(
    async (run: () => void | Promise<void>) => {
      bypass.current = true;
      try {
        await run();
      } finally {
        // In `finally` rather than after the await: a navigation that rejects
        // - a refused `push`, or one this guard itself aborted - must still
        // re-arm, or the page would be left permanently unguarded.
        bypass.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    /** Whether leaving right now would lose something. */
    const armed = () =>
      options.current.hasUnsavedChanges() || options.current.isSaving();

    /**
     * @param url the destination, taken from the event rather than from
     *   `router.asPath` - by the time the modal is answered the router has
     *   unwound to the page the user is still on.
     */
    const onRouteChangeStart = (url: string) => {
      if (bypass.current) return;

      // A save in flight blocks without prompting. The page is already behind
      // its full-screen spinner, so there is no control to have produced this,
      // and a modal offering to save again is an invitation to submit twice.
      if (options.current.isSaving()) throw ROUTE_CHANGE_ABORTED;

      if (!options.current.hasUnsavedChanges()) return;

      options.current.onIntercept(async () => {
        await router.push(url);
      });
      throw ROUTE_CHANGE_ABORTED;
    };

    /**
     * Next hands a blocked pop back to us: "the downstream application returns
     * falsy, return. They will then be responsible for handling the event"
     * (`router.js:1694`). Responsible includes the address bar, which the
     * browser has already changed - returning `false` only stops the render.
     */
    const onBeforePopState = ({ as }: { as: string }) => {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        // False, not true: the URL now matches the page already on screen, so
        // there is nothing to render and no reason to re-enter `change()`.
        return false;
      }

      if (bypass.current || !armed()) return true;

      restoringHistory.current = true;
      router.forward();

      if (!options.current.isSaving()) {
        options.current.onIntercept(async () => {
          await router.push(as);
        });
      }
      return false;
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bypass.current || !armed()) return;
      // `preventDefault` is what the current specification asks for;
      // `returnValue` is what older browsers still read. Neither chooses the
      // wording - the browser's own text is all a page can get here, which is
      // why requirement and implementation both stop at the native dialog.
      event.preventDefault();
      event.returnValue = "";
    };

    /**
     * Keeps the abort out of the console.
     *
     * `next/link` calls `router.push` without a `.catch` (`client/link.js:110`),
     * so every interception would otherwise surface as an unhandled rejection.
     * Matched by identity, so a genuine navigation failure is still reported.
     */
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (event.reason === ROUTE_CHANGE_ABORTED) event.preventDefault();
    };

    router.events.on("routeChangeStart", onRouteChangeStart);
    router.beforePopState(onBeforePopState);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      router.events.off("routeChangeStart", onRouteChangeStart);
      // Next holds one callback rather than a list, so releasing it means
      // restoring the permissive default.
      router.beforePopState(() => true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [router]);

  return { allowNavigation };
};
