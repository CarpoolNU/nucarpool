/**
 * That the presigned PUT URL is obtained at the moment of the upload, not at
 * the moment the file is chosen.
 *
 * The URL is a credential with an hour on it (`PRESIGNED_UPLOAD_EXPIRY_SECONDS`),
 * and the gap this file exists for is the one between cropping a photo and
 * pressing Save. Held as query data it could never be refreshed while the user
 * stayed on `/profile`: the app's `defaultQueryOptions` set `refetchOnMount`
 * and `refetchOnWindowFocus` to `false`, the observer never unmounted so
 * `gcTime` never elapsed, and the key is derived from the unchanged file. One
 * fetch, ever - so a save an hour later PUT to a dead signature, and the retry
 * the failure toast invites replayed that same dead signature from cache every
 * time (SCRUM-665).
 *
 * **The `QueryClient` below is built from the application's own
 * `defaultQueryOptions`**, reached with `requireActual` because the module is
 * mocked. That is load-bearing rather than tidiness: with those defaults in
 * force a cached URL is exactly what the old shape handed back, so a fix that
 * only set `staleTime` on a still-mounted query would go on failing here
 * unless something also triggered the refetch.
 *
 * What is counted is `queryFn`, which fires from inside React Query rather
 * than at render, so it records what the client actually ran. A render-time
 * spy cannot tell a cache read from a fetch, and neither could a stub of
 * `fetch` that resolved a literal - see `src/testing/trpcHarness.ts`.
 */

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useUploadFile } from "./useUploadFile";
import { resetTrpcSpies, trpcSpies } from "../../testing/trpcHarness";

jest.mock("../trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    // These stub bodies read consts declared below this call. `jest.mock` is
    // hoisted above them, but a stub is not invoked until the client runs it,
    // which is after the module has finished evaluating. The harness's own
    // documentation covers the rule.
    "user.getPresignedUrl": { query: () => ({ url: nextSignedUrl() }) },
    "user.recordProfilePictureUpload": { mutation: () => record("record") },
    // Declared for two reasons. `useInvalidateProfileImage` reaches for this
    // path's `invalidate`, and absent from the spec `useUtils()` has no such
    // branch, so the hook dies on a TypeError long before the PUT. And the
    // ordering case needs the call recorded - which has to happen here rather
    // than through `mockImplementation` in a test body, because the harness
    // re-installs this implementation on every `useUtils()` call and would
    // overwrite anything a test set before rendering.
    "user.getPresignedDownloadUrl": { invalidate: () => record("invalidate") },
  }),
);

/**
 * A different URL per signature, so "did the second attempt use a fresh
 * credential" has an answer in the PUT itself and not only in a call count.
 * Two independent readings of one fact: a count that moved, and a URL that
 * changed.
 */
let signatureCount = 0;
const nextSignedUrl = () =>
  `https://bucket.s3.example.com/profile-pictures/u1?sig=${++signatureCount}`;

/** The two post-PUT steps, in the order the hook actually ran them. */
const callOrder: string[] = [];
const record = (step: string) => {
  callOrder.push(step);
};

/** A real `File`: `isUploadableProfileImage` reads `type` and `size`. */
const croppedPhoto = () =>
  new File([new Uint8Array(1024)], "crop.jpg", { type: "image/jpeg" });

/**
 * The PUT. The hook uploads with the global `fetch`, so replacing the global
 * is what lets a case decide whether S3 accepted the signature it was given.
 */
const putResponses: Array<{ ok: boolean; statusText: string }> = [];
const putUrls: string[] = [];
const putSpy = jest.fn(async (url: string) => {
  putUrls.push(url);
  return putResponses.shift() ?? { ok: true, statusText: "OK" };
});

let queryClient: QueryClient;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  resetTrpcSpies();
  signatureCount = 0;
  callOrder.length = 0;
  putResponses.length = 0;
  putUrls.length = 0;
  putSpy.mockClear();
  (global as unknown as { fetch: unknown }).fetch = putSpy;

  const { defaultQueryOptions } = jest.requireActual("../trpc");
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        ...defaultQueryOptions,
        // The single departure from production, and it only makes the counts
        // below stricter: production's retry rule would re-run `queryFn` up to
        // three more times on a failure, which would blur a fetch count
        // without changing what is being asked.
        retry: false,
      },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  queryClient.clear();
});

describe("useUploadFile", () => {
  it("signs a fresh URL for a retry rather than replaying the one that just failed", async () => {
    // S3 refuses the first PUT the way it refuses an expired signature.
    putResponses.push({ ok: false, statusText: "Forbidden" });

    const { result } = renderHook(() => useUploadFile(croppedPhoto()), {
      wrapper,
    });

    await expect(result.current.uploadFile()).rejects.toThrow(
      /Failed to upload file/,
    );

    // The user presses Save again with the crop they already chose, which is
    // exactly what the failure toast invites them to do.
    await expect(result.current.uploadFile()).resolves.toBeUndefined();

    expect(putUrls).toHaveLength(2);
    expect(putUrls[1]).not.toBe(putUrls[0]);
    expect(trpcSpies("user.getPresignedUrl").queryFn).toHaveBeenCalledTimes(2);
  });

  it("signs nothing until an upload is actually attempted", () => {
    renderHook(() => useUploadFile(croppedPhoto()), { wrapper });

    expect(trpcSpies("user.getPresignedUrl").queryFn).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("records the upload before invalidating the cached download URL", async () => {
    // The ordering `useUploadFile` documents, and that SCRUM-276 established:
    // the invalidation's refetch reads the column the mutation writes, so
    // invalidating first could race the write and refetch the old state.
    const { result } = renderHook(() => useUploadFile(croppedPhoto()), {
      wrapper,
    });

    await result.current.uploadFile();

    expect(callOrder).toEqual(["record", "invalidate"]);
  });

  it("records nothing when the PUT fails", async () => {
    putResponses.push({ ok: false, statusText: "Forbidden" });

    const { result } = renderHook(() => useUploadFile(croppedPhoto()), {
      wrapper,
    });

    await expect(result.current.uploadFile()).rejects.toThrow(
      /Failed to upload file/,
    );

    expect(callOrder).toEqual([]);
  });

  it("refuses a file the endpoint would not sign for, without reaching S3", async () => {
    const { result } = renderHook(
      () =>
        useUploadFile(
          new File([new Uint8Array(8)], "doc.svg", { type: "image/svg+xml" }),
        ),
      { wrapper },
    );

    await expect(result.current.uploadFile()).rejects.toThrow(
      /Profile pictures must be one of/,
    );
    expect(trpcSpies("user.getPresignedUrl").queryFn).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });
});
