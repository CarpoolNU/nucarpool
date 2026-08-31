import Pusher from "pusher-js";
import { browserEnv } from "./env/browser";

/**
 * The one browser-side Pusher client.
 *
 * Both subscriptions used to call `new Pusher(...)` inside their own
 * `useEffect` and, on cleanup, only `unsubscribe` — never `disconnect`. Each
 * construction opens a WebSocket, so unsubscribing left the socket open and
 * connections accumulated for the lifetime of the tab. In `Header` the effect
 * also depended on an object literal rebuilt on every parent render, so it tore
 * down and re-ran continuously, opening a fresh socket each time. Pusher meters
 * peak concurrent connections, so that was a running cost as well as a leak.
 *
 * Callers now acquire the shared client and release it on cleanup. The client is
 * built on first acquire and disconnected when the last holder lets go, so a
 * page with both the header and an open conversation uses exactly one socket.
 *
 * Construction is deliberately lazy rather than at module scope: this module is
 * imported by client components that Next also renders on the server, and
 * `new Pusher(...)` must not run there. Every caller acquires from inside an
 * effect, which is client-only.
 */

let client: Pusher | null = null;
let holders = 0;

/** Returns the shared client, creating it if this is the first holder. */
export const acquirePusherClient = (): Pusher => {
  if (!client) {
    client = new Pusher(browserEnv.NEXT_PUBLIC_PUSHER_KEY, {
      cluster: browserEnv.NEXT_PUBLIC_PUSHER_CLUSTER,
      // Required for the `private-` channels both callers use.
      authEndpoint: "/api/pusher/auth",
    });
  }

  holders += 1;
  return client;
};

/**
 * Releases one hold. Disconnects only when the last holder lets go, so a
 * component unmounting does not cut the socket out from under another.
 */
export const releasePusherClient = (): void => {
  // Clamped so an unbalanced release cannot drive the count negative and leave
  // the client permanently un-disconnectable.
  holders = Math.max(0, holders - 1);

  if (holders === 0 && client) {
    client.disconnect();
    client = null;
  }
};

/** Number of live holders. Exported for tests and debugging only. */
export const pusherClientHolders = (): number => holders;
