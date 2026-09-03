/**
 * The shared server-side SES client.
 *
 * `createContext` used to call `new SESClient(...)` inline, and it runs once
 * per tRPC HTTP request — so a client with its own connection pool was built
 * and thrown away for every `user.me`, map query and unread-count poll, none
 * of which send mail. These tests pin the two things the move has to preserve:
 * one client per process however many requests arrive, and credentials still
 * passed explicitly from `serverEnv` rather than resolved from the ambient
 * environment.
 *
 * `@aws-sdk/client-ses` is mocked, so nothing here opens a socket to SES.
 */

import { serverEnv } from "../utils/env/server";

const mockSESClientConstructor = jest.fn(
  (_config: Record<string, unknown>) => ({
    send: jest.fn(),
  }),
);

jest.mock("@aws-sdk/client-ses", () => ({
  __esModule: true,
  SESClient: mockSESClientConstructor,
}));

/** A fresh copy of the module, so each test starts before construction. */
const load = async () => {
  jest.resetModules();
  return import("./ses");
};

beforeEach(() => {
  mockSESClientConstructor.mockClear();
});

describe("sesClient", () => {
  it("constructs exactly one client when the module loads", async () => {
    await load();

    expect(mockSESClientConstructor).toHaveBeenCalledTimes(1);
  });

  it("hands every importer the same instance instead of one client each", async () => {
    const { sesClient } = await load();
    const second = await import("./ses");

    expect(second.sesClient).toBe(sesClient);
    expect(mockSESClientConstructor).toHaveBeenCalledTimes(1);
  });

  it("takes its credentials from serverEnv, not from the ambient environment", async () => {
    // The file this replaced also imported `fromEnv`, which it never called;
    // the import implied AWS_* process variables were the source when the
    // repository's names are suffixed and read through envsafe instead.
    await load();

    const config = mockSESClientConstructor.mock.calls[0]?.[0];
    expect(config?.region).toBe(serverEnv.AWS_REGION);
    expect(config?.credentials).toEqual({
      accessKeyId: serverEnv.AWS_ACCESS_KEY_ID,
      secretAccessKey: serverEnv.AWS_SECRET_ACCESS_KEY,
    });
  });
});

describe("createContext", () => {
  it("puts the shared client on every context rather than building one per request", async () => {
    const { sesClient } = await load();
    const { createContext } = await import("./router/context");

    // No req/res, so no session lookup — this exercises only the wiring.
    const first = await createContext();
    const second = await createContext();

    expect(first.sesClient).toBe(sesClient);
    expect(second.sesClient).toBe(first.sesClient);
    expect(mockSESClientConstructor).toHaveBeenCalledTimes(1);
  });
});
