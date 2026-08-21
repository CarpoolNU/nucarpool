import { Permission } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";

/**
 * Contract tests for `user.getPresignedDownloadUrl` (SCRUM-242).
 *
 * The important assertion here is a negative one: this procedure must never
 * resolve `undefined`. React Query treats a query function that resolves
 * `undefined` as a *failure* — verified against @tanstack/query-core 4.41.0,
 * which dispatches `"<key> data is undefined"` — and a query sitting in the
 * error state refetches on every mount no matter what `staleTime` or
 * `refetchOnMount` say.
 *
 * That is what made every user *without* a profile picture uncacheable: their
 * avatar paid a tRPC round trip and an S3 HeadObject on every single mount,
 * forever. `{ url: null }` is a cacheable success and costs the same to
 * produce, so the shape is load-bearing rather than cosmetic.
 *
 * Follows `authorization.test.ts` and `user/favorites.test.ts`: the real
 * `appRouter` driven through `createCaller` with a fabricated session, with
 * S3 mocked out. No network, no AWS quota, no database.
 */

const mockGetPresignedImageUrl = jest.fn();

jest.mock("../../utils/uploadToS3", () => ({
  getPresignedImageUrl: (...args: unknown[]) =>
    mockGetPresignedImageUrl(...args),
  generatePresignedUrl: jest.fn(),
}));

const SESSION_USER = "session-user";
const OTHER_USER = "other-user";
const SIGNED = "https://carpoolnubucket.s3.us-east-2.amazonaws.com/x?sig=abc";

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (session: Session | null) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma: {},
    sesClient: { send: jest.fn() },
  } as unknown as Context);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("user.getPresignedDownloadUrl", () => {
  it("returns the signed URL for a user who has a picture", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: SIGNED });

    expect(mockGetPresignedImageUrl).toHaveBeenCalledWith(OTHER_USER);
  });

  it("resolves { url: null } — never undefined — for a user with no picture", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(null);
    const caller = callerFor(sessionFor(SESSION_USER));

    const result = await caller.user.getPresignedDownloadUrl({
      userId: OTHER_USER,
    });

    // Spelled out separately from toEqual: `expect(undefined).toEqual({...})`
    // would fail anyway, but the point of this test is the *shape*, and a
    // future refactor that reintroduces an implicit `return` should fail on a
    // line that says why.
    expect(result).not.toBeUndefined();
    expect(result).toEqual({ url: null });
  });

  it("falls back to the session user when no userId is supplied", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(caller.user.getPresignedDownloadUrl({})).resolves.toEqual({
      url: SIGNED,
    });

    expect(mockGetPresignedImageUrl).toHaveBeenCalledWith(SESSION_USER);
  });

  it("resolves { url: null } rather than undefined when there is no user id at all", async () => {
    // A session with no `user` is the only way to reach this branch. It should
    // still hand React Query something cacheable instead of an error.
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(caller.user.getPresignedDownloadUrl({})).resolves.toEqual({
      url: null,
    });

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    const caller = callerFor(null);

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
  });

  it("surfaces an S3 failure as INTERNAL_SERVER_ERROR", async () => {
    mockGetPresignedImageUrl.mockRejectedValueOnce(new Error("s3 exploded"));
    const caller = callerFor(sessionFor(SESSION_USER));

    const rejection = caller.user.getPresignedDownloadUrl({
      userId: OTHER_USER,
    });

    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
