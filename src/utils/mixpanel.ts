import mixpanel from "mixpanel-browser";
import { browserEnv } from "./env/browser";

/**
 * No local "is the token set" check, and that is not an oversight.
 * A check here would be **unreachable**: `browserEnv` declares this variable
 * with `str({ input })` and no default, so `envsafe` rejects a missing or
 * empty value when `env/browser.ts` is imported - which is the line above.
 * The token is a non-empty string by the time it is read here, or nothing got
 * this far.
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

/**
 * Attach every subsequent event to a user rather than to a browser.
 *
 * Without this, each event carries an anonymous per-device distinct id.
 * `mixpanel-browser` collects `$initial_referrer`, `$initial_referring_domain`
 * and any `utm_*` parameters by itself, so the acquisition data is already
 * there - it just could not be joined to a signup, a role, or to whether the
 * person went on to form a carpool, without this. It would also mean one
 * person on a laptop and a phone counts as two users, which is enough to make
 * the FTUE funnel's drop-off rates wrong by an unknown amount.
 *
 * **`identify` is the whole stitch; `alias` is not needed and would be wrong.**
 * Reading `identify` in `mixpanel-browser` 2.82: it registers `$user_id` and
 * `$device_id`, then tracks an `$identify` event carrying
 * `$anon_distinct_id: <the previous anonymous id>`. That event is what merges
 * the pre-sign-in session - the one holding the first-touch referrer - into the
 * account, under both the original and the simplified ID-merge schemes.
 * `alias` predates ID merge and Mixpanel's own guidance is not to combine them.
 *
 * **The id, and only the id.** `User.id` is a cuid: a pseudonymous key that is
 * enough to join Mixpanel back to the database, and nothing on its own. Sending
 * an email address, a name, a preferred name or a bio would put personal data
 * into a third party, which is a separate decision nobody has taken. That is
 * also why there is no `people.set` here - a people profile is the natural
 * place for exactly those fields to start creeping in.
 *
 * Role and company are deliberately absent too, for a different reason: they
 * change over time, and the database join gives them more accurately than a
 * super property frozen at sign-in would.
 */
export const identifyUser = (userId: string) => {
  mixpanel.identify(userId);
};

/**
 * Forget who this browser belongs to, and start a fresh anonymous id.
 *
 * Called from `signOutWithGuard`, which is the one place a sign-out actually
 * happens. `persistence: "localStorage"` means the identity outlives the tab,
 * so without this the next person on a shared machine would keep emitting
 * events against the previous user's distinct id.
 *
 * **Do not call this on a `useSession` status of `"unauthenticated"`**, which
 * looks like the tidier trigger and is not. next-auth reports that status on
 * every signed-out page load, so resetting there would throw away the anonymous
 * distinct id - and with it the first-touch referrer - on every single visit to
 * `/sign-in`, destroying the attribution this pair of functions exists to make
 * possible. An explicit sign-out is the event; a signed-out page view is not.
 */
export const resetIdentity = () => {
  mixpanel.reset();
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

/**
 * How many candidates a search returned — the supply signal.
 *
 * **One event carrying a count, rather than a separate "empty" event.** Zero
 * results and two results are the same question asked of Mixpanel, and the
 * interesting cohort is not fixed at zero: a rider offered one driver 90 miles
 * away is barely better served than one offered none. A numeric property keeps
 * that a filter rather than a second instrumentation path.
 *
 * **`companyCity`/`companyState`, and deliberately nothing finer.** The
 * question this exists to answer is which corridor to recruit drivers in, and
 * a city answers it. The home coordinate would answer it slightly better and
 * is a home address; `companyAddress` is a street address too. Both are more
 * than a third party needs, so neither is sent.
 *
 * An object rather than this file's usual positional arguments: `companyCity`
 * and `companyState` are adjacent strings, and a call site that transposed
 * them would typecheck and be wrong for as long as anyone read the dashboard.
 *
 * Emitted through `useRecommendationsLoadedEvent`, which owns *when* it fires.
 */
export const trackRecommendationsLoaded = (properties: {
  resultCount: number;
  role: string;
  companyCity: string;
  companyState: string;
}) => {
  trackEvent("Recommendations Loaded", properties);
};

/**
 * The two events that make the rider-demand notice falsifiable.
 *
 * SCRUM-638 says outright that the feature "is a plausible intervention, not a
 * measured one" and that it "should ship in a form that can tell". These are
 * that form. Without them the notice would be a change nobody could evaluate,
 * and the honest version of shipping an unmeasured guess is shipping the
 * instrument alongside it.
 *
 * **The conversion funnel is these events plus one that already exists.** The
 * question is "did seeing the count make anyone drive", and the answer is
 * `Rider Demand Shown` → `Profile Completed` with `role: "DRIVER"`, which
 * `trackProfileCompletion` has emitted from the profile save path all along.
 * No third event and no new state: a funnel over events Mixpanel already
 * joins by distinct id answers it, and a bespoke "converted" event would be a
 * second thing to keep correct for no extra information.
 *
 * `Rider Demand Dismissed` is the counter-reading, and it is the one that can
 * kill the feature. A high dismissal rate against a flat driver count is the
 * evidence that this nags rather than informs — the exact risk the ticket
 * names — and is the signal to remove the notice rather than reword it.
 *
 * **`surface` is why both are one event with a property rather than four
 * events.** The empty recommendations list and the profile role selector are
 * the same intervention in two places, and the thing worth knowing is which
 * one converts; separate event names would make that a comparison across
 * funnels instead of a breakdown within one.
 *
 * **`count` rides along for the same reason `resultCount` does above.** The
 * interesting cohort is not fixed: a reader shown 3 and a reader shown 40 are
 * being offered very different arguments, and a numeric property keeps that a
 * filter rather than a second instrumentation path. Nothing finer than the
 * count and the role is sent — no city here, because unlike the supply signal
 * this is not a question about which corridor to recruit in.
 *
 * Emitted from `RiderDemandNotice`, which owns *when* they fire. The shown
 * event is once per mount of a visible notice, so a reader who opens the
 * filter panel and closes it again is counted twice; count unique users, not
 * raw events, for the same reason `trackRecommendationsLoaded` says so.
 */
export const trackRiderDemandShown = (properties: {
  count: number;
  role: string;
  surface: string;
}) => {
  trackEvent("Rider Demand Shown", properties);
};

export const trackRiderDemandDismissed = (properties: {
  count: number;
  role: string;
  surface: string;
}) => {
  trackEvent("Rider Demand Dismissed", properties);
};
