/**
 * `communityPageGuard`'s four outcomes, and the order it reaches them in.
 *
 * The flag and the session are both stubbed at the module boundary, so this
 * drives the exported guard itself, with no factory needed for testing.
 * `browserEnv` is replaced by an object with a getter so each test can choose
 * the flag. The getter reads the `mock`-prefixed variable when the guard
 * calls it, not when the mock is built.
 */
import type { GetServerSidePropsContext } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { communityPageGuard } from "./pageGuard";

let mockCommunityEnabled = false;

jest.mock("../env/browser", () => ({
  browserEnv: {
    get NEXT_PUBLIC_COMMUNITY_ENABLED() {
      return mockCommunityEnabled;
    },
  },
}));

/** A marker object, so the test can check that this is the one passed through. */
const mockAuthOptions = { marker: "authOptions" };
jest.mock("../../pages/api/auth/[...nextauth]", () => ({
  get authOptions() {
    return mockAuthOptions;
  },
}));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

const readSession = jest.mocked(getServerSession);

const context = {
  req: { marker: "req" },
  res: { marker: "res" },
} as unknown as GetServerSidePropsContext;

const sessionFor = (isOnboarded: boolean): Session =>
  ({
    user: { id: "user-1", isOnboarded },
    expires: "2099-01-01T00:00:00.000Z",
  }) as unknown as Session;

const SIGNED_OUT = null;
const ONBOARDED = sessionFor(true);
const NOT_ONBOARDED = sessionFor(false);

beforeEach(() => {
  readSession.mockReset();
});

describe("communityPageGuard while Community is off", () => {
  beforeEach(() => {
    mockCommunityEnabled = false;
  });

  /*
   * Each case stubs a session the guard must never read. If the guard did
   * read it, the signed-out case would redirect to `/sign-in` and the
   * not-onboarded case to `/profile/setup`. Both of those show the route
   * exists, so they would fail here as well as on the call count.
   */
  it.each([
    ["a signed-out visitor", SIGNED_OUT],
    ["a signed-in, onboarded user", ONBOARDED],
    ["a signed-in user who is not onboarded", NOT_ONBOARDED],
  ])("is a 404 for %s, without reading the session", async (_who, session) => {
    readSession.mockResolvedValue(session);

    await expect(communityPageGuard(context)).resolves.toEqual({
      notFound: true,
    });
    expect(readSession).not.toHaveBeenCalled();
  });
});

describe("communityPageGuard while Community is on", () => {
  beforeEach(() => {
    mockCommunityEnabled = true;
  });

  it("sends a signed-out visitor to sign in", async () => {
    readSession.mockResolvedValue(SIGNED_OUT);

    await expect(communityPageGuard(context)).resolves.toEqual({
      redirect: { destination: "/sign-in", permanent: false },
    });
  });

  it("treats a session with no user as signed out", async () => {
    readSession.mockResolvedValue({
      expires: "2099-01-01T00:00:00.000Z",
    } as Session);

    await expect(communityPageGuard(context)).resolves.toEqual({
      redirect: { destination: "/sign-in", permanent: false },
    });
  });

  it("sends a user who is not onboarded to finish setup", async () => {
    readSession.mockResolvedValue(NOT_ONBOARDED);

    await expect(communityPageGuard(context)).resolves.toEqual({
      redirect: { destination: "/profile/setup", permanent: false },
    });
  });

  it("renders the page for a signed-in, onboarded user", async () => {
    readSession.mockResolvedValue(ONBOARDED);

    await expect(communityPageGuard(context)).resolves.toEqual({ props: {} });
  });

  it("reads the session from this request with the app's auth options", async () => {
    readSession.mockResolvedValue(ONBOARDED);

    await communityPageGuard(context);

    expect(readSession).toHaveBeenCalledTimes(1);
    expect(readSession).toHaveBeenCalledWith(
      context.req,
      context.res,
      mockAuthOptions,
    );
  });
});
