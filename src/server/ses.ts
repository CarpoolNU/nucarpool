import { SESClient } from "@aws-sdk/client-ses";
import { serverEnv } from "../utils/env/server";

/**
 * The one server-side SES client, sharing its shape and its reasoning with
 * `pusher.ts` and `db/client.ts` so all three long-lived clients read as one
 * deliberate pattern.
 *
 * This was previously constructed inside `createContext`, which runs once per
 * tRPC HTTP request — so every `user.me`, map query and unread-count poll built
 * and discarded a client, with its own connection pool, for a service the
 * request never touched. Only the three `emails.*` procedures send mail, and
 * discarding the client with the request meant they could never reuse a warm
 * TLS connection to SES either.
 *
 * Credentials come from `serverEnv`, not from the ambient environment: envsafe
 * validates them at import time under the repository's suffixed names, so a
 * missing one still fails at startup exactly as it did before.
 */
export const sesClient = new SESClient({
  region: serverEnv.AWS_REGION,
  credentials: {
    accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
  },
});
