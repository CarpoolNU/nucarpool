import Pusher from "pusher";
import { serverEnv } from "../utils/env/server";

/**
 * The one server-side Pusher client. Previously constructed inline in the
 * message router; the auth endpoint added for SCRUM-224 needs the same
 * credentials to sign subscriptions, and two separately configured clients
 * would be a silent way for the two to drift apart.
 */
export const pusherServer = new Pusher({
  appId: serverEnv.PUSHER_APP_ID,
  key: serverEnv.NEXT_PUBLIC_PUSHER_KEY,
  secret: serverEnv.PUSHER_SECRET,
  cluster: serverEnv.NEXT_PUBLIC_PUSHER_CLUSTER,
  useTLS: true,
});
