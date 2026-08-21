import type { NextApiRequest, NextApiResponse } from "next";

/**
 * HTTP contract of the Pusher auth endpoint (SCRUM-224).
 *
 * `pusherChannelAuth.test.ts` covers the authorization decision itself. This
 * covers the endpoint around it — that an unauthenticated or unauthorized
 * caller is turned away *before* anything is signed, and that a signature is
 * only ever produced for a caller who passed the check.
 *
 * `next-auth`, the Prisma client and the Pusher server client are all mocked,
 * so no session store, database or Pusher credential is touched.
 */

const mockGetServerSession = jest.fn();
const mockAuthorizeChannel = jest.fn(() => ({ auth: "signature" }));
const mockCanSubscribe = jest.fn();

jest.mock("next-auth", () => ({
  __esModule: true,
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("../auth/[...nextauth]", () => ({
  __esModule: true,
  authOptions: {},
}));

jest.mock("../../../server/db/client", () => ({
  __esModule: true,
  prisma: {},
}));

jest.mock("../../../server/pusher", () => ({
  __esModule: true,
  pusherServer: {
    authorizeChannel: (...args: unknown[]) => mockAuthorizeChannel(),
  },
}));

jest.mock("../../../server/pusherChannelAuth", () => ({
  __esModule: true,
  canSubscribe: (...args: unknown[]) => mockCanSubscribe(...args),
}));

import handler from "./auth";

const USER = "user-alice";
const CHANNEL = "private-notification-user-alice";

const buildRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
  };
};

const call = async (req: Partial<NextApiRequest>) => {
  const res = buildRes();
  await handler(
    { method: "POST", body: {}, ...req } as NextApiRequest,
    res as NextApiResponse,
  );
  return res;
};

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockAuthorizeChannel.mockClear();
  mockCanSubscribe.mockReset();
  mockGetServerSession.mockResolvedValue({ user: { id: USER } });
  mockCanSubscribe.mockResolvedValue(true);
});

describe("POST /api/pusher/auth", () => {
  it("signs the subscription for an authorized caller", async () => {
    const res = await call({
      body: { socket_id: "123.456", channel_name: CHANNEL },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ auth: "signature" });
    expect(mockCanSubscribe).toHaveBeenCalledWith({}, USER, CHANNEL);
  });

  it("refuses an unauthenticated caller without signing anything", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await call({
      body: { socket_id: "123.456", channel_name: CHANNEL },
    });

    expect(res.statusCode).toBe(401);
    expect(mockAuthorizeChannel).not.toHaveBeenCalled();
    expect(mockCanSubscribe).not.toHaveBeenCalled();
  });

  it("refuses a session that carries no user id", async () => {
    mockGetServerSession.mockResolvedValue({ user: undefined });

    const res = await call({
      body: { socket_id: "123.456", channel_name: CHANNEL },
    });

    expect(res.statusCode).toBe(401);
    expect(mockAuthorizeChannel).not.toHaveBeenCalled();
  });

  it("refuses an unauthorized channel without signing anything", async () => {
    // The property that matters: a rejected check must never reach the signer.
    mockCanSubscribe.mockResolvedValue(false);

    const res = await call({
      body: {
        socket_id: "123.456",
        channel_name: "private-notification-someone-else",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(mockAuthorizeChannel).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await call({ body: { channel_name: CHANNEL } });

    expect(res.statusCode).toBe(400);
    expect(mockAuthorizeChannel).not.toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const res = await call({ method: "GET" });

    expect(res.statusCode).toBe(405);
    expect(mockGetServerSession).not.toHaveBeenCalled();
    expect(mockAuthorizeChannel).not.toHaveBeenCalled();
  });
});
