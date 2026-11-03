/**
 * Stop jsdom logging `Not implemented: navigation` when a test clicks a link.
 *
 * jsdom implements no navigation, so a `userEvent.click` on any anchor with a
 * real `href` writes a stack trace to the console. A suite that clicks links
 * to assert on something else - analytics, in every current caller - buries
 * its own output in them.
 *
 * **Anchors only.** The obvious version cancels every click, and that is a
 * trap worth naming: `preventDefault` on a `<button type="submit">` stops the
 * form submitting, so a blanket listener silently breaks any test that
 * submits a form in the same file. `ReportDialog.test.tsx` failed exactly
 * that way. The `closest("a")` check is what keeps this to the links.
 *
 * **Capture phase.** A bubble-phase listener on `document` misses anchors
 * inside a Headless UI dialog, which stops the click propagating before it
 * gets there. Capture runs on the way down, ahead of any of that.
 *
 * Capturing does not weaken what a suite asserts: `preventDefault` cancels
 * the browser's default action only and never stops a listener running, so a
 * component's own `onClick` still fires and is still observable. That is also
 * why it belongs here rather than in a component - a link's handler must
 * never cancel its own navigation, and hiding that in production code would
 * make the tests that check it meaningless.
 *
 *     beforeEach(suppressLinkNavigation.install);
 *     afterEach(suppressLinkNavigation.uninstall);
 */

const onClick = (event: MouseEvent) => {
  const target = event.target;
  if (target instanceof Element && target.closest("a")) {
    event.preventDefault();
  }
};

export const suppressLinkNavigation = {
  install: () => document.addEventListener("click", onClick, true),
  uninstall: () => document.removeEventListener("click", onClick, true),
};
