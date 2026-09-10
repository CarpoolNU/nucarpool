import mixpanel from "mixpanel-browser";
import { browserEnv } from "./env/browser";

/**
 * No local "is the token set" check, and that is not an oversight
 * (SCRUM-417). There used to be one here that threw at module scope, and it
 * was **unreachable**: `browserEnv` declares this variable with `str({ input })`
 * and no default, so `envsafe` rejects a missing or empty value when
 * `env/browser.ts` is imported - which is the line above. The token is a
 * non-empty string by the time it is read here, or nothing got this far.
 *
 * A second check could therefore only ever fire in a world where the first
 * already had, while adding an import-time failure mode of its own.
 *
 * Note what this does *not* change: a missing token still stops the app at
 * import, from `envsafe`. Making Mixpanel genuinely optional is a different
 * decision - it would mean relaxing the env contract, which `check:env` and
 * `amplify.yml` also encode.
 */
const mixpanelToken = browserEnv.NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN;

mixpanel.init(mixpanelToken, {
  debug: process.env.NODE_ENV !== "production",
  track_pageview: true,
  persistence: "localStorage",
});

export const trackEvent = (
  eventName: string,
  properties?: Record<string, any>,
) => {
  mixpanel.track(eventName, properties);
};

export const trackFTUECompletion = (role: string) => {
  trackEvent("FTUE Completed", { role });
};
export const trackFTUEStep = (step: number) => {
  const name = "FTUE Step " + step;
  trackEvent(name);
};
// Add this new function
export const trackProfileCompletion = (role: string, status: string) => {
  trackEvent("Profile Completed", { role, status });
};

// Add this new function
export const trackViewRoute = (role: string) => {
  trackEvent("View Route Clicked", {
    role,
  });
};

export const trackRequestResponse = (
  action: "accept" | "decline",
  role: string,
) => {
  trackEvent("Request Response", {
    action,
    role,
  });
};
