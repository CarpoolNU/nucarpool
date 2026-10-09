/**
 * The router-level half of the unsaved-changes guard.
 *
 * `hasProfileChanges` decides *whether* there is something to lose and is
 * tested on its own; this file is only about *interception* - the three exits
 * from the profile page that no component can wrap in a `checkChanges` call,
 * and the one re-entrancy problem interception creates.
 *
 * The hook is exercised through a host component rather than `renderHook` so
 * that unmount tears down real subscriptions, which is the only way the
 * registry assertions below mean anything.
 */

import { render } from "@testing-library/react";
import { act } from "react";
import type { NextRouter } from "next/router";

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);

import { useRouter } from "next/router";
import {
  resetRouterSpies,
  routeHandlers,
  routerSpies,
} from "../../testing/nextRouterStub";
import {
  ROUTE_CHANGE_ABORTED,
  useUnsavedChangesGuard,
} from "./useUnsavedChangesGuard";

type HostProps = {
  hasUnsavedChanges: () => boolean;
  isSaving?: () => boolean;
  onIntercept: (proceed: () => Promise<void>) => void;
};

/**
 * Hands the hook's return value out to the test.
 *
 * Reassigned on every render, so a test that calls it after an interaction
 * gets the current closure rather than the one from mount.
 */
let allowNavigation: (run: () => void | Promise<void>) => Promise<void>;

const Host = (props: HostProps) => {
  const guard = useUnsavedChangesGuard({
    router: useRouter() as NextRouter,
    hasUnsavedChanges: props.hasUnsavedChanges,
    isSaving: props.isSaving ?? (() => false),
    onIntercept: props.onIntercept,
  });
  allowNavigation = guard.allowNavigation;
  return null;
};

const dirty = () => true;
const clean = () => false;

/** Fires `routeChangeStart` the way Next's router does, and reports the abort. */
const startRouteChange = (url = "/safety"): { aborted: boolean } => {
  try {
    routerSpies().events.emit("routeChangeStart", url);
    return { aborted: false };
  } catch (error) {
    expect(error).toBe(ROUTE_CHANGE_ABORTED);
    return { aborted: true };
  }
};

/** Invokes the `beforePopState` callback the hook registered. */
const popState = (as = "/") => {
  const calls = routerSpies().beforePopState.mock.calls;
  const callback = calls[calls.length - 1]?.[0] as (state: {
    as: string;
  }) => boolean;
  return callback({ as });
};

/** Dispatches `beforeunload` and reports whether the handler asked to prompt. */
const beforeUnload = (): boolean => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => {
  resetRouterSpies();
});

describe("useUnsavedChangesGuard: internal navigation", () => {
  it("aborts a route change and hands the destination to the page", () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    expect(startRouteChange("/safety").aborted).toBe(true);
    expect(onIntercept).toHaveBeenCalledTimes(1);
  });

  it("navigates to the intercepted destination when the page proceeds", async () => {
    let proceed: (() => Promise<void>) | undefined;
    render(
      <Host
        hasUnsavedChanges={dirty}
        onIntercept={(callback) => {
          proceed = callback;
        }}
      />,
    );

    startRouteChange("/safety");
    await act(async () => {
      await allowNavigation(() => proceed!());
    });

    // The destination that was intercepted, not the map fallback.
    expect(routerSpies().push).toHaveBeenCalledWith("/safety");
  });

  it("lets a route change through when nothing is unsaved", () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={clean} onIntercept={onIntercept} />);

    expect(startRouteChange().aborted).toBe(false);
    expect(onIntercept).not.toHaveBeenCalled();
  });

  it("does not re-intercept the navigation the modal itself performs", async () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    // Discarding leaves the form dirty - only the picture is dropped - so the
    // guard would catch its own navigation without the bypass.
    await act(async () => {
      await allowNavigation(() => {
        expect(startRouteChange("/").aborted).toBe(false);
      });
    });
    expect(onIntercept).not.toHaveBeenCalled();
  });

  it("re-arms once the modal's navigation is finished", async () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    await act(async () => {
      await allowNavigation(() => undefined);
    });

    expect(startRouteChange().aborted).toBe(true);
    expect(onIntercept).toHaveBeenCalledTimes(1);
  });

  it("re-arms even when the navigation it allowed throws", async () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    await act(async () => {
      await expect(
        allowNavigation(() => {
          throw new Error("push failed");
        }),
      ).rejects.toThrow("push failed");
    });

    expect(startRouteChange().aborted).toBe(true);
  });
});

describe("useUnsavedChangesGuard: an in-flight save", () => {
  it("refuses a route change without opening a second modal", () => {
    const onIntercept = jest.fn();
    render(
      <Host
        hasUnsavedChanges={dirty}
        isSaving={() => true}
        onIntercept={onIntercept}
      />,
    );

    expect(startRouteChange().aborted).toBe(true);
    expect(onIntercept).not.toHaveBeenCalled();
  });

  it("still prompts on unload, because the save is not yet durable", () => {
    render(
      <Host
        hasUnsavedChanges={clean}
        isSaving={() => true}
        onIntercept={jest.fn()}
      />,
    );

    expect(beforeUnload()).toBe(true);
  });
});

describe("useUnsavedChangesGuard: browser back and forward", () => {
  it("blocks the pop, restores the URL and offers the destination", () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    expect(popState("/previous")).toBe(false);
    // `beforePopState` returning false stops Next rendering, but the address
    // bar has already moved - Next hands that back to the application.
    expect(routerSpies().forward).toHaveBeenCalledTimes(1);
    expect(onIntercept).toHaveBeenCalledTimes(1);
  });

  it("does not re-prompt on the pop its own restore causes", () => {
    const onIntercept = jest.fn();
    render(<Host hasUnsavedChanges={dirty} onIntercept={onIntercept} />);

    popState("/previous");
    onIntercept.mockClear();

    expect(popState("/profile")).toBe(false);
    expect(onIntercept).not.toHaveBeenCalled();
    // Still one: the restore must not drive the history stack again.
    expect(routerSpies().forward).toHaveBeenCalledTimes(1);
  });

  it("lets a pop through when nothing is unsaved", () => {
    render(<Host hasUnsavedChanges={clean} onIntercept={jest.fn()} />);

    expect(popState("/previous")).toBe(true);
    expect(routerSpies().forward).not.toHaveBeenCalled();
  });
});

describe("useUnsavedChangesGuard: refresh and tab close", () => {
  it("asks the browser to confirm when there are unsaved changes", () => {
    render(<Host hasUnsavedChanges={dirty} onIntercept={jest.fn()} />);

    expect(beforeUnload()).toBe(true);
  });

  it("does not when there are none", () => {
    render(<Host hasUnsavedChanges={clean} onIntercept={jest.fn()} />);

    expect(beforeUnload()).toBe(false);
  });

  it("does not during a navigation the page itself chose", async () => {
    render(<Host hasUnsavedChanges={dirty} onIntercept={jest.fn()} />);

    // The mobile bottom navigation leaves with a full page load, which fires
    // `beforeunload`. Discarding must not then be second-guessed by the
    // browser's own prompt.
    await act(async () => {
      await allowNavigation(() => {
        expect(beforeUnload()).toBe(false);
      });
    });
  });
});

describe("useUnsavedChangesGuard: subscriptions", () => {
  it("subscribes once and tears everything down on unmount", () => {
    const { unmount, rerender } = render(
      <Host hasUnsavedChanges={dirty} onIntercept={jest.fn()} />,
    );

    // Re-rendering with a new callback identity - which is what every
    // keystroke in the form does - must not add a second subscription.
    rerender(<Host hasUnsavedChanges={() => true} onIntercept={jest.fn()} />);
    expect(routeHandlers("routeChangeStart")).toHaveLength(1);

    unmount();
    expect(routeHandlers("routeChangeStart")).toHaveLength(0);
    expect(beforeUnload()).toBe(false);
    // Next keeps one `beforePopState` callback, so releasing it means
    // restoring the no-op rather than removing a listener.
    expect(popState("/previous")).toBe(true);
  });
});
