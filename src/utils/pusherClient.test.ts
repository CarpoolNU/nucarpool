/**
 * Shared Pusher client lifecycle.
 *
 * Both subscriptions used to construct their own client inside a `useEffect`
 * and only `unsubscribe` on cleanup — never `disconnect` — so every
 * construction leaked a WebSocket for the lifetime of the tab. Pusher meters
 * peak concurrent connections, so the leak cost money as well as sockets.
 *
 * These tests pin the reference counting, which is the whole of the fix: one
 * client however many holders, and exactly one disconnect when the last of them
 * lets go. `pusher-js` is mocked, so nothing here opens a connection.
 */

// Marks this file as a module. Without it TypeScript treats the file as a
// global script and every top-level declaration below becomes a program-wide
// global, so the next test file to declare a name this one uses fails to
// compile — with most of the errors reported against *this* file rather than
// the new one. The `jest.mock` + `jest.resetModules()` + dynamic-`import()`
// idiom is why no ordinary import already does the job: the module under test
// must not be imported before its mock is registered. Keep it. See SCRUM-355.
export {};

const mockDisconnect = jest.fn();
// Parameters are declared so `mock.calls[n][1]` is typed; without them the call
// tuple is empty and `tsc` rejects the index, even though jest is happy.
const mockPusherConstructor = jest.fn(
  (_key: string, _options: Record<string, unknown>) => ({
    disconnect: mockDisconnect,
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
  }),
);

jest.mock("pusher-js", () => ({
  __esModule: true,
  default: mockPusherConstructor,
}));

/** A fresh copy of the module, so each test starts with no holders. */
const load = async () => {
  jest.resetModules();
  return import("./pusherClient");
};

beforeEach(() => {
  mockPusherConstructor.mockClear();
  mockDisconnect.mockClear();
});

describe("acquirePusherClient", () => {
  it("constructs a client on first acquire", async () => {
    const { acquirePusherClient } = await load();

    acquirePusherClient();

    expect(mockPusherConstructor).toHaveBeenCalledTimes(1);
  });

  it("reuses the same client across holders instead of opening a second socket", async () => {
    const { acquirePusherClient } = await load();

    const first = acquirePusherClient();
    const second = acquirePusherClient();

    expect(mockPusherConstructor).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("subscribes through the auth endpoint, since both channels are private", async () => {
    // Without authEndpoint, pusher-js would use its own default and the
    // private-channel subscriptions would never be signed.
    const { acquirePusherClient } = await load();

    acquirePusherClient();

    const options = mockPusherConstructor.mock.calls[0]?.[1];
    expect(options?.authEndpoint).toBe("/api/pusher/auth");
    expect(options?.cluster).toBeTruthy();
  });

  it("does not construct anything at import time", async () => {
    // The module is imported by components Next also renders on the server,
    // where `new Pusher(...)` must not run.
    await load();

    expect(mockPusherConstructor).not.toHaveBeenCalled();
  });
});

describe("releasePusherClient", () => {
  it("does not disconnect while another holder remains", async () => {
    const { acquirePusherClient, releasePusherClient } = await load();

    acquirePusherClient();
    acquirePusherClient();
    releasePusherClient();

    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("disconnects exactly once when the last holder releases", async () => {
    const { acquirePusherClient, releasePusherClient } = await load();

    acquirePusherClient();
    acquirePusherClient();
    releasePusherClient();
    releasePusherClient();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("builds a new client if one is acquired again after a full release", async () => {
    const { acquirePusherClient, releasePusherClient } = await load();

    acquirePusherClient();
    releasePusherClient();
    acquirePusherClient();

    expect(mockPusherConstructor).toHaveBeenCalledTimes(2);
  });

  it("tolerates an unbalanced release without going negative", async () => {
    // A stray release must not drive the count below zero, which would leave a
    // later client impossible to disconnect.
    const { acquirePusherClient, releasePusherClient, pusherClientHolders } =
      await load();

    releasePusherClient();
    releasePusherClient();
    expect(pusherClientHolders()).toBe(0);

    acquirePusherClient();
    expect(pusherClientHolders()).toBe(1);

    releasePusherClient();
    expect(pusherClientHolders()).toBe(0);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("does nothing when released with no client ever acquired", async () => {
    const { releasePusherClient } = await load();

    expect(() => releasePusherClient()).not.toThrow();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
});

describe("holder count tracks the two real subscribers", () => {
  it("stays at one socket with both the header and a conversation mounted", async () => {
    // The shape this fix exists for: Header plus MessageContent, one socket.
    const { acquirePusherClient, releasePusherClient, pusherClientHolders } =
      await load();

    acquirePusherClient(); // Header mounts
    acquirePusherClient(); // MessageContent mounts
    expect(pusherClientHolders()).toBe(2);
    expect(mockPusherConstructor).toHaveBeenCalledTimes(1);

    releasePusherClient(); // conversation closed
    expect(mockDisconnect).not.toHaveBeenCalled();

    releasePusherClient(); // navigated away
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
