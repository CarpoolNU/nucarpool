import { useEffect, useRef } from "react";
import { useSession } from "next-auth/react";

/**
 * Tells Mixpanel who the signed-in user is, once per user, app-wide.
 *
 * Mounted in `_app` beside `ComplianceGate` rather than called from the pages
 * that happen to track events. Identification is not a property of any one
 * screen: an event fired from a component that forgot to identify first is
 * anonymous, and there is no way to tell afterwards which of the eight events
 * the app emits were attributed and which were not.
 *
 * Renders nothing. It is here for the effect, and it needs a session, so it has
 * to be a component inside `SessionProvider` rather than a call in `MyApp`.
 *
 * **Why `utils/mixpanel` is imported inside the effect rather than at the top
 * of the file.** This component is in the chunk every page loads, and a static
 * import would pull `mixpanel-browser` into the shared bundle along with it -
 * the exact cost `ComplianceGate` goes out of its way to avoid, and it
 * documents the measurement: importing that modal directly, which reaches
 * `mixpanel-browser` through `trackEvent`, added 143 kB of shared First Load
 * JS and charged it to `/sign-in` and `/404` as well.
 *
 * Deferring it also keeps the analytics session itself where it already is.
 * `utils/mixpanel` calls `mixpanel.init` at module scope with
 * `track_pageview: true`, so a static import here would start a session - and
 * fire a pageview - on `/404` and every other signed-out page, which does not
 * happen today. Behind the `authenticated` guard, the module only loads on
 * pages that already import it for their own tracking, so nothing new is
 * initialised anywhere.
 */
export const MixpanelIdentity = () => {
  const { data: session, status } = useSession();
  const userId = session?.user?.id;

  /**
   * The last id actually sent.
   *
   * `status` and `userId` alone are not enough to make this fire once.
   * `next.config.js` sets `reactStrictMode: true`, so in development React
   * mounts effects, tears them down and mounts them again - and `identify`
   * queues an `$identify` event each time the distinct id changes. A ref
   * survives that second pass where a dependency array does not.
   *
   * `null` rather than `undefined` as the "nobody yet" value, so that it cannot
   * compare equal to a `userId` that is itself missing. With `undefined` on
   * both sides, the first pass of a session carrying no id took this check
   * rather than the status guard above - which made that guard untestable, and
   * would have let a session that *later* lost its id reach
   * `identifyUser(undefined)`.
   */
  const identified = useRef<string | null>(null);

  useEffect(() => {
    // `loading` is the interesting one of the two rejected statuses: guessing
    // at it would identify nobody on the first render of every page.
    if (status !== "authenticated" || !userId) {
      return;
    }

    if (identified.current === userId) {
      return;
    }

    /*
     * Recorded before the import resolves, not after, so that a re-render
     * arriving in the meantime does not start a second one. The cost is that a
     * failed chunk load is not retried, which is the right trade for analytics.
     */
    identified.current = userId;

    void import("../utils/mixpanel")
      .then(({ identifyUser }) => identifyUser(userId))
      // Analytics must never be able to break a page. A chunk that fails to
      // load leaves the user anonymous, which is exactly where they were.
      .catch(() => undefined);
  }, [status, userId]);

  return null;
};
