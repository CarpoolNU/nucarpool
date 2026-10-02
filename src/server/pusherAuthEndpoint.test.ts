import type { NextApiRequest, NextApiResponse } from "next";

/**
 * HTTP contract of the Pusher auth endpoint.
 *
 * `pusherChannelAuth.test.ts` covers the authorization decision itself. This
 * covers the endpoint around it — that an unauthenticated or unauthorized
 * caller is turned away *before* anything is signed, and that a signature is
 * only ever produced for a caller who passed the check.
 *
 * `next-auth`, the Prisma client and the Pusher server client are all mocked,
 * so no session store, database or Pusher credential is touched.
 *
 * Deliberately NOT co-located with the handler it covers. Every
 * other test in this repository sits next to its module, but under
 * src/pages/ a filename is also a route: Next's default `pageExtensions`
 * includes `.ts`, so `auth.test.ts` was compiled and shipped as
 * `/api/pusher/auth.test`. It lives here instead, beside the
 * `pusherChannelAuth` half of the same feature. `scripts/check-page-routes.js`
 * enforces that no test file moves back under src/pages/.
 */

const mockGetServerSession = jest.fn();
const mockCanSubscribe = jest.fn();

/**
 * Stands in for `Pusher.prototype.authorizeChannel`, *including its
 * validation* — it validates before it signs, and a validation failure is a
 * thrown `Error` rather than a return value.
 *
 * Reproduced here rather than faked as a bare success because the defect this
 * covers is precisely that the endpoint's own `typeof === "string"` checks say
 * nothing about shape, so a malformed `socket_id` reached the signer and threw.
 * A mock that always succeeds cannot express that, and a mock that throws
 * unconditionally would pass even if the handler stopped forwarding the
 * caller's values. These are the real regexes, from
 * `node_modules/pusher/lib/pusher.js`.
 */
const mockAuthorizeChannel = jest.fn((...args: unknown[]) => {
  const [socketId, channel] = args as [string, string];

  if (typeof socketId !== "string" || !/^\d+\.\d+$/.test(socketId)) {
    throw new Error(`Invalid socket id: '${socketId}'`);
  }
  if (typeof channel !== "string" || channel === "") {
    throw new Error(`Invalid channel name: '${channel}'`);
  }
  if (channel.length > 200) {
    throw new Error(`Channel name too long: '${channel}'`);
  }

  return { auth: "signature" };
});

jest.mock("next-auth", () => ({
  __esModule: true,
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  __esModule: true,
  authOptions: {},
}));

jest.mock("./db/client", () => ({
  __esModule: true,
  prisma: {},
}));

jest.mock("./pusher", () => ({
  __esModule: true,
  pusherServer: {
    authorizeChannel: (...args: unknown[]) => mockAuthorizeChannel(...args),
  },
}));

jest.mock("./pusherChannelAuth", () => ({
  __esModule: true,
  canSubscribe: (...args: unknown[]) => mockCanSubscribe(...args),
}));

import handler from "../pages/api/pusher/auth";

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

/**
 * A malformed `socket_id` on a channel the caller genuinely owns.
 *
 * The two checks above it both pass — it is a string, and `canSubscribe` says
 * the channel is theirs — so the value reached `authorizeChannel`, which threw
 * on the shape. Nothing caught it, so Next turned an ordinary bad request into
 * an unhandled rejection and a 500, which the client then retried.
 */
describe("POST /api/pusher/auth — a malformed socket_id is a 400, not a 500", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    // The handler logs the underlying error. Silenced so a deliberate failure
    // path does not look like a broken test run, and asserted on below.
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("passes the caller's values through to the signer, which is how this arises", async () => {
    // The control for the fake: if the handler did not forward what the caller
    // sent, every assertion below would hold for the wrong reason.
    await call({ body: { socket_id: "123.456", channel_name: CHANNEL } });

    expect(mockAuthorizeChannel).toHaveBeenCalledWith("123.456", CHANNEL);
  });

  it("answers 400 rather than letting the validation error escape", async () => {
    const res = await call({ body: { socket_id: "x", channel_name: CHANNEL } });

    expect(res.statusCode).toBe(400);
    // Reached the signer, which is the point: the handler's own type check
    // admits any string, so the shape is only caught here.
    expect(mockAuthorizeChannel).toHaveBeenCalledWith("x", CHANNEL);
  });

  it("logs the underlying error instead of returning it", async () => {
    // Pusher quotes the offending value back ("Invalid socket id: 'x'"). The
    // client gets a fixed string; the detail goes to the log.
    const res = await call({ body: { socket_id: "x", channel_name: CHANNEL } });

    expect(res.body).toEqual({
      message: "socket_id or channel_name is malformed",
    });
    expect(JSON.stringify(res.body)).not.toContain("Invalid socket id");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("refuses an empty socket_id, which the type check alone admits", async () => {
    // `typeof "" === "string"`, so the required-fields branch passes it.
    const res = await call({ body: { socket_id: "", channel_name: CHANNEL } });

    expect(res.statusCode).toBe(400);
  });

  it("still answers 200 for a well-formed socket_id", async () => {
    // The positive control: the catch must not have turned the success path
    // into a blanket refusal.
    const res = await call({
      body: { socket_id: "123.456", channel_name: CHANNEL },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ auth: "signature" });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
