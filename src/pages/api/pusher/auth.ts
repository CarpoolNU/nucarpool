import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";

import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "../../../server/db/client";
import { pusherServer } from "../../../server/pusher";
import { canSubscribe } from "../../../server/pusherChannelAuth";

/**
 * Pusher private-channel authorization (SCRUM-224).
 *
 * `pusher-js` calls this before joining a `private-` channel. Returning a
 * signature admits the subscriber; anything else and Pusher refuses the
 * subscription, which is what stops a client subscribing to a stranger's
 * conversation or notification feed.
 *
 * One of two non-tRPC endpoints in the app, alongside `api/csp-report.ts`, and
 * for the same underlying reason: something outside this codebase defines the
 * contract. Here it is Pusher, which requires a form-encoded POST of
 * `socket_id` and `channel_name`, answered with the signed payload.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const socketId = req.body?.socket_id;
  const channelName = req.body?.channel_name;

  if (typeof socketId !== "string" || typeof channelName !== "string") {
    return res
      .status(400)
      .json({ message: "socket_id and channel_name are required" });
  }

  if (!(await canSubscribe(prisma, userId, channelName))) {
    // Deliberately not distinguishing "no such conversation" from "not yours":
    // the caller learns only that they may not have it.
    return res.status(403).json({ message: "Forbidden" });
  }

  return res
    .status(200)
    .json(pusherServer.authorizeChannel(socketId, channelName));
}
