/**
 * The shared fake of `react-toastify/unstyled`.
 *
 * The app calls `toast.error`, `toast.success`, `toast.warning` and
 * `toast.info`. A mock that pins only a subset of those breaks the moment a
 * component starts reporting something through a method it never pinned, as
 * `toast.info is not a function` thrown from inside a mutation callback -
 * which reads like a broken component rather than like a stub nobody
 * updated, the failure `mixpanelBrowserStub.js` is shaped to prevent. Pinning
 * the whole surface once makes the subset impossible to get wrong.
 *
 * ---
 *
 * **`require` inside the factory is the only call form that works** - see
 * `trpcHarness.ts` for why.
 *
 *     jest.mock("react-toastify/unstyled", () =>
 *       require("../../testing/toastStub").buildToastMock(),
 *     );
 *
 * Both ways of reaching the spies keep working. `jest.requireMock(
 * "react-toastify/unstyled").toast` is what three files already do and is
 * untouched by this; `toastSpies()` is the shorter equivalent and does not
 * need a cast.
 *
 * ---
 *
 * **Note the specifier.** It is `react-toastify/unstyled`, not
 * `react-toastify`. The app imports the unstyled entry point everywhere, and
 * mocking the bare package name would leave the real module loaded and the
 * mock unused - a mock that silently does nothing rather than one that fails.
 */

/** The `toast` methods the app calls, plus the two that dismiss one. */
export type ToastSpies = {
  success: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
  warning: jest.Mock;
  dismiss: jest.Mock;
  update: jest.Mock;
};

/** Populated by `buildToastMock`; see `trpcHarness.ts` on why this is safe. */
let spies: ToastSpies | null = null;

/** The spies this module owns. Throws when `buildToastMock` has not run. */
export const toastSpies = (): ToastSpies => {
  if (!spies) {
    throw new Error(
      "toastSpies: buildToastMock has not run. Add " +
        'jest.mock("react-toastify/unstyled", () => ' +
        'require("<path>/testing/toastStub").buildToastMock()) to this file.',
    );
  }
  return spies;
};

/** Clears call records on every spy. For `beforeEach`. */
export const resetToastSpies = (): void => {
  if (!spies) return;
  for (const spy of Object.values(spies)) spy.mockClear();
};

/**
 * Builds the module object `jest.mock("react-toastify/unstyled")` must return.
 *
 * `ToastContainer` is included because `_app` renders one; it draws nothing,
 * since a suite asserting on a toast reads the spy rather than the DOM.
 */
export const buildToastMock = () => {
  spies = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
    update: jest.fn(),
  };

  return {
    __esModule: true,
    toast: spies,
    ToastContainer: () => null,
  };
};
