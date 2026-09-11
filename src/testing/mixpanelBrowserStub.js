/*
 * Stands in for `mixpanel-browser` in the jsdom test project.
 *
 * `src/utils/mixpanel.ts` calls `mixpanel.init(...)` at **module scope**, so
 * importing anything that tracks an event starts an analytics session as a
 * side effect of being loaded. `UserCard` imports it for `trackViewRoute`,
 * which puts it under most of the card and sidebar tree - so the first
 * component test to reach that tree initialized Mixpanel inside jsdom.
 *
 * What that cost, before this stub: a queued `$identify`, a page of `debug`
 * logging, and two errors that are pure noise in this environment -
 * `indexedDB is not supported in this browser`, twice. Mocking the module in
 * one test file took that suite from 9.3s to 1.8s.
 *
 * **It did not, however, make any network requests.** That was an open
 * question on the ticket and is now measured rather than assumed: with
 * `XMLHttpRequest.open`/`send`, `fetch` and `navigator.sendBeacon` all
 * instrumented, importing the module and then tracking an event produced
 * *zero* calls across a four-second window. Mixpanel queues events pending an
 * `$identify` that never resolves here. The image-tag transport is closed too,
 * since Jest sets no `testEnvironmentOptions` and jsdom's default is
 * `resources: "none"`, so an `<img src>` never fetches. So this stub buys
 * silence and speed, not containment - the suite was not talking to Mixpanel
 * before it either.
 *
 * ---
 *
 * **Why this stubs the third-party module rather than our own wrapper.**
 * Mapping `utils/mixpanel` to a stub would work, and was the obvious move, but
 * it means maintaining a fake with one entry per exported helper -
 * `trackEvent`, `trackFTUEStep`, `trackViewRoute` and three more today. Add a
 * seventh helper and forget the stub, and a component test fails with
 * `trackX is not a function`, which reads like a broken component.
 *
 * Stubbing `mixpanel-browser` instead lets `utils/mixpanel` load *for real*.
 * Its exports cannot drift from themselves, and the surface pinned here is two
 * methods of a third-party contract rather than six of ours. `init` and
 * `track` are all that module uses.
 *
 * Plain no-ops rather than `jest.fn()`, deliberately: this module is required
 * once per suite and `clearMocks` is not configured, so shared spies would
 * accumulate calls across the tests in a file and read as flakiness. A test
 * that wants to assert on tracking should `jest.mock` locally, which takes
 * precedence over `moduleNameMapper`.
 *
 * CommonJS because `moduleNameMapper` targets are required directly, without
 * transformation - the same reason `staticImageStub.js` is. `utils/mixpanel`
 * uses a default import, and with no `__esModule` marker the interop helper
 * hands it this object.
 */
module.exports = {
  init: () => undefined,
  track: () => undefined,
};
