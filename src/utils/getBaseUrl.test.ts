import { getBaseUrl } from "./getBaseUrl";

/**
 * `getBaseUrl` decides where tRPC sends its requests.
 *
 * The server-side branches are unreachable while `ssr: false` is set, so
 * nothing in the running app would notice if they regressed. That is exactly
 * why they are pinned here: the defect this replaced was a dead `VERCEL_URL`
 * check whose fallback pointed a deployed server-side call at
 * `http://localhost:3000`, and it survived because no test and no code path
 * ever looked.
 */
describe("getBaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // A fresh copy per test, so setting one variable cannot leak into the next.
    process.env = { ...originalEnv };
    delete process.env.NEXTAUTH_URL;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
    delete (globalThis as { window?: unknown }).window;
  });

  describe("in the browser", () => {
    beforeEach(() => {
      (globalThis as { window?: unknown }).window = {};
    });

    it("returns an empty string so the request stays on the current origin", () => {
      expect(getBaseUrl()).toBe("");
    });

    it("ignores NEXTAUTH_URL, which is a server concern", () => {
      process.env.NEXTAUTH_URL = "https://nucarpool.example.com";
      expect(getBaseUrl()).toBe("");
    });
  });

  describe("on the server", () => {
    it("uses NEXTAUTH_URL when it is set", () => {
      process.env.NEXTAUTH_URL = "https://nucarpool.example.com";
      expect(getBaseUrl()).toBe("https://nucarpool.example.com");
    });

    it("strips a trailing slash, which would otherwise produce a double slash", () => {
      process.env.NEXTAUTH_URL = "https://nucarpool.example.com/";
      expect(getBaseUrl()).toBe("https://nucarpool.example.com");
      expect(`${getBaseUrl()}/api/trpc`).toBe(
        "https://nucarpool.example.com/api/trpc",
      );
    });

    it("strips repeated trailing slashes", () => {
      process.env.NEXTAUTH_URL = "https://nucarpool.example.com///";
      expect(getBaseUrl()).toBe("https://nucarpool.example.com");
    });

    it("falls back to localhost when NEXTAUTH_URL is unset", () => {
      expect(getBaseUrl()).toBe("http://localhost:3000");
    });

    it("honours PORT in the fallback", () => {
      process.env.PORT = "4000";
      expect(getBaseUrl()).toBe("http://localhost:4000");
    });

    it("treats a blank NEXTAUTH_URL as unset rather than returning an empty origin", () => {
      process.env.NEXTAUTH_URL = "   ";
      expect(getBaseUrl()).toBe("http://localhost:3000");
    });

    // The regression this ticket exists for.
    it("does not point a deployed environment at localhost", () => {
      process.env.NEXTAUTH_URL = "https://nucarpool.example.com";
      expect(getBaseUrl()).not.toContain("localhost");
    });

    it("no longer consults VERCEL_URL", () => {
      process.env.VERCEL_URL = "nucarpool.vercel.app";
      expect(getBaseUrl()).toBe("http://localhost:3000");
      expect(getBaseUrl()).not.toContain("vercel");
    });
  });
});
