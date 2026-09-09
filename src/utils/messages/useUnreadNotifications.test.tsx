import { act, renderHook } from "@testing-library/react";
import { trpc } from "../trpc";
import { acquirePusherClient, releasePusherClient } from "../pusherClient";
import { useUnreadNotifications } from "./useUnreadNotifications";

/**
 * The unread-count notification subscription (SCRUM-383).
 *
 * This effect lived inside `Header`, where nothing could reach it: the
 * component needs a router, a tRPC client, a portal and a `GroupPage` to
 * render at all. That is why the increment it performed *inside a `setState`
 * updater* survived to be found by an audit rather than by a test.
 *
 * `trpc` and `pusherClient` are mocked as shapes rather than driven through a
 * real client and a real socket, the pattern `useGroupDetails.test.tsx`
 * established: the hook's contract is "subscribe to my own notification
 * channel, and invalidate the unread count when one arrives", and a real
 * QueryClient here would be testing @tanstack/react-query instead.
 *
 * **These run under `<StrictMode>`** — `jest.setup.dom.ts` configures it
 * globally, and cites this very bug as the reason. So every effect below
 * mounts, tears down and mounts again, exactly as it does in development.
 * Assertions are written against that: the invariant is never "subscribed
 * once" in absolute terms but "a re-render adds no subscription", which is the
 * property that actually matters and the one StrictMode cannot fake.
 */

jest.mock("../trpc", () => ({
  trpc: {
    useUtils: jest.fn(),
  },
}));

jest.mock("../pusherClient", () => ({
  acquirePusherClient: jest.fn(),
  releasePusherClient: jest.fn(),
}));

const mockedTrpc = trpc as unknown as { useUtils: jest.Mock };
const mockedAcquire = acquirePusherClient as unknown as jest.Mock;
const mockedRelease = releasePusherClient as unknown as jest.Mock;

/** `invalidate` on `user.messages.getUnreadMessageCount`. */
const invalidate = jest.fn(() => Promise.resolve());

const bind = jest.fn();
const unbind = jest.fn();
const subscribe = jest.fn((_channelName: string) => ({ bind, unbind }));
const unsubscribe = jest.fn((_channelName: string) => undefined);

beforeEach(() => {
  jest.clearAllMocks();

  /**
   * A **fresh object on every call**, deliberately. The real
   * `trpc.useUtils()` is memoized on the tRPC context, so it is probably
   * stable — but `utils.user.messages.getUnreadMessageCount` is a new proxy on
   * every property access, so a hook that put the accessor in a dependency
   * array would churn. Returning a new object here puts the hook under the
   * worst case, which is what makes "does not re-subscribe" mean something.
   */
  mockedTrpc.useUtils.mockImplementation(() => ({
    user: { messages: { getUnreadMessageCount: { invalidate } } },
  }));

  mockedAcquire.mockReturnValue({ subscribe, unsubscribe });
});

/** The handler currently bound for `sendNotification` — the live one. */
const liveNotificationHandler = (): (() => void) => {
  const bound = bind.mock.calls.filter(
    ([event]) => event === "sendNotification",
  );
  const last = bound[bound.length - 1];

  if (!last) throw new Error("nothing was bound for sendNotification");
  return last[1] as () => void;
};

/** One `sendNotification` delivered to the subscription that is actually live. */
const receiveNotification = () => {
  const handler = liveNotificationHandler();
  act(() => {
    handler();
  });
};

describe("useUnreadNotifications — subscribing", () => {
  it("subscribes to the caller's own notification channel", () => {
    renderHook(() => useUnreadNotifications("user-1"));

    // The private channel, so Pusher refuses it until /api/pusher/auth signs
    // it for this session.
    expect(subscribe).toHaveBeenCalledWith("private-notification-user-1");
  });

  it("opens nothing before the user id is known", () => {
    renderHook(() => useUnreadNotifications(undefined));

    expect(mockedAcquire).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("subscribes once the user id arrives", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useUnreadNotifications(id),
      { initialProps: { id: undefined as string | undefined } },
    );

    expect(subscribe).not.toHaveBeenCalled();

    rerender({ id: "user-1" });

    expect(subscribe).toHaveBeenCalledWith("private-notification-user-1");
  });

  it("does not re-subscribe when the user id is unchanged", () => {
    // SCRUM-383's acceptance criterion, and the churn fix this hook inherited.
    // `Header` used to depend on `props.data` — an object literal `Home`
    // rebuilds on every filter change, query settle, map event and hover — so
    // the effect tore down and re-ran continuously and opened a fresh
    // WebSocket each time. Pusher meters peak concurrent connections.
    //
    // Compared against the count after mount rather than against 1, because
    // StrictMode legitimately mounts twice.
    const { rerender } = renderHook(() => useUnreadNotifications("user-1"));
    const afterMount = subscribe.mock.calls.length;

    rerender();
    rerender();
    rerender();

    expect(subscribe.mock.calls.length).toBe(afterMount);
  });

  it("moves to the new channel when the user changes", () => {
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useUnreadNotifications(id),
      { initialProps: { id: "user-1" } },
    );

    rerender({ id: "user-2" });

    expect(unsubscribe).toHaveBeenCalledWith("private-notification-user-1");
    expect(subscribe).toHaveBeenCalledWith("private-notification-user-2");
  });

  it("unbinds and releases the shared client on unmount", () => {
    // The client is shared with `MessageContent`, so releasing rather than
    // disconnecting is the contract: the socket goes only when the last holder
    // lets go.
    const { unmount } = renderHook(() => useUnreadNotifications("user-1"));
    const releasesAtMount = mockedRelease.mock.calls.length;

    unmount();

    expect(unbind).toHaveBeenCalledWith("sendNotification");
    expect(unsubscribe).toHaveBeenCalledWith("private-notification-user-1");
    expect(mockedRelease.mock.calls.length).toBe(releasesAtMount + 1);
  });

  it("reports a subscription error rather than failing silently", () => {
    // Without this the badge would just appear to have stopped working.
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      renderHook(() => useUnreadNotifications("user-1"));

      const errorHandler = bind.mock.calls.find(
        ([event]) => event === "pusher:subscription_error",
      )?.[1] as (status: unknown) => void;

      errorHandler({ status: 403 });

      expect(consoleError).toHaveBeenCalledWith(
        "Could not subscribe to private-notification-user-1",
        { status: 403 },
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("useUnreadNotifications — receiving a notification", () => {
  it("invalidates the unread count", () => {
    // The fix. This used to increment a local counter that the badge then
    // displayed *instead of* the server's count, so five unread plus one
    // notification read `1`.
    renderHook(() => useUnreadNotifications("user-1"));

    receiveNotification();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("counts one notification once, even though StrictMode mounts twice", () => {
    // The third defect in the ticket: the increment ran inside an updater
    // handed to `setSidebar`, and updaters must be pure because React may call
    // them twice — which `reactStrictMode: true` guarantees in development. The
    // badge therefore moved by two per message locally.
    //
    // The first assertion is what stops this being a restatement of the test
    // above: it establishes that the double-invocation really is happening
    // here, so the second assertion is measuring idempotence rather than an
    // environment that quietly turned StrictMode off.
    renderHook(() => useUnreadNotifications("user-1"));

    expect(subscribe.mock.calls.length).toBeGreaterThan(1);

    receiveNotification();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates however many arrive, without accumulating state", () => {
    renderHook(() => useUnreadNotifications("user-1"));

    receiveNotification();
    receiveNotification();
    receiveNotification();

    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("invalidates regardless of which tab is open", () => {
    // Deliberate departure from the old `prev !== "requests"` condition, which
    // suppressed the bump while the Requests tab was open. The notification
    // channel is per *user*, not per conversation, so a message in another
    // thread is real unread mail. The hook is not given the sidebar at all —
    // that is the point, and it is why no `setState` updater has to be read
    // from any more.
    renderHook(() => useUnreadNotifications("user-1"));

    expect(mockedTrpc.useUtils).toHaveBeenCalled();
    receiveNotification();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("still invalidates after a re-render has replaced the utils object", () => {
    // The ref that keeps the subscription effect on `[userId]` has to stay
    // current, or the notification would invalidate through a stale closure.
    // `useUtils` returns a fresh object per call here, so this fails if the
    // ref is never updated.
    const { rerender } = renderHook(() => useUnreadNotifications("user-1"));

    rerender();
    rerender();
    receiveNotification();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
