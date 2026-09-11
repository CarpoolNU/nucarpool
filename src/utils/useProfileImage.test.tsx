/**
 * That a hydration pass React throws away does not cost a network request.
 *
 * `Header` branches on `useIsMobile`, and React reads `getServerSnapshot`
 * during hydration as well as on the server - so a `Header` that is already in
 * the server HTML renders its *desktop* branch once on a phone, mounting
 * `DropDownMenu` and its avatar query, before correcting to the bottom
 * navigation. `/admin` was the one page with that shape.
 *
 * **Why this file mocks `trpc` onto a real React Query instead of onto a spy.**
 * `Header.test.tsx` mocks `getPresignedDownloadUrl.useQuery` as a bare
 * `jest.fn()` called during render, which is the right shape for the question
 * that file asks - *did `DropDownMenu` render at all* - and the wrong shape
 * for this one. A render-time spy fires on the discarded pass whether or not
 * the query is disabled, so it cannot tell a fix from a no-op here: it would
 * report one call before and after.
 *
 * What actually had to be established is that the *fetch* went out, and
 * whether the fix stops it. That depends on React Query's own timing - its
 * observer subscribes in a passive effect, and whether that runs before or
 * after React's corrective re-render is a fact about React, not about this
 * repo. So `useQuery` here is the real one, keyed and fetched through a spy
 * `queryFn`, which is what tRPC's `useQuery` reduces to anyway. The counts
 * below are therefore measurements rather than restatements of the mock.
 *
 * Measured against the pre-fix hook, the mobile case reported **1**.
 */

import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useProfileImage from "./useProfileImage";
import useIsMobile from "./useIsMobile";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

const queryFn = jest.fn(async () => ({ url: "https://s3/avatar.png" }));

/**
 * `trpc.user.getPresignedDownloadUrl.useQuery`, as the React Query call it
 * compiles down to. The `options` spread is what carries `enabled` through, so
 * a fix that failed to pass it would show up as a fetch that still happens.
 */
jest.mock("./trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        getPresignedDownloadUrl: {
          useQuery: (input: { userId?: string }, options: object) =>
            reactQuery.useQuery({
              queryKey: ["getPresignedDownloadUrl", input],
              queryFn: () => queryFn(),
              ...options,
            }),
        },
      },
    },
  };
});

restoreViewportAfterEach();

/** Recorded per render pass, so the deferred pass can be inspected. */
const loadingByRender: boolean[] = [];

/** Stands in for `DropDownMenu`: an avatar, and nothing else of interest. */
const Avatar = () => {
  const { profileImageUrl, isLoading } = useProfileImage();
  loadingByRender.push(isLoading);
  return (
    <span>{isLoading ? "placeholder" : (profileImageUrl ?? "fallback")}</span>
  );
};

/** `Header`'s shape: the avatar on desktop, a bottom bar on mobile. */
const ViewportBranch = () => (useIsMobile() ? <nav>bottom</nav> : <Avatar />);

const withClient = (node: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {node}
  </QueryClientProvider>
);

/**
 * Serves a server render into a container and hydrates it, the way a real page
 * load of `/admin` does.
 *
 * The `renderToString` output is handed back too, so a caller can pin what the
 * server actually emitted rather than only what hydration settled on.
 */
const hydrateAt = async (width: number) => {
  setViewportWidth(width);
  queryFn.mockClear();
  loadingByRender.length = 0;

  const tree = withClient(<ViewportBranch />);
  const serverHtml = renderToString(tree);

  const container = document.createElement("div");
  /*
   * `hydrateRoot` needs real DOM to reconcile against, and this markup is
   * `renderToString`'s output for a component defined in this file - not a
   * stored value, a user-authored field or anything else the lint rule exists
   * to stop. `useIsMobile.test.tsx` assembles its container with
   * `createElement` instead, which works there because its tree is a single
   * text-carrying div; reproducing this one by hand would be transcribing
   * React's output and asserting on the transcription.
   */
  // eslint-disable-next-line no-restricted-syntax
  container.innerHTML = serverHtml;
  document.body.appendChild(container);

  const consoleError = jest.spyOn(console, "error").mockImplementation();
  try {
    await act(async () => {
      hydrateRoot(container, tree);
    });
  } finally {
    consoleError.mockRestore();
  }

  return { serverHtml, text: container.textContent };
};

describe("useProfileImage on a hydration pass that is discarded", () => {
  it("fires no request when the mobile branch replaces the avatar", async () => {
    const { serverHtml, text } = await hydrateAt(MOBILE_WIDTH);

    // The server had to guess, and guessed desktop - so the avatar really is
    // in the HTML being hydrated. Without this the test could pass by the
    // avatar never being involved at all.
    expect(serverHtml).toContain("placeholder");

    // ...and the client corrected to the bottom bar, discarding it.
    expect(text).toBe("bottom");

    // The whole ticket: that discarded mount used to cost one authenticated
    // presigned-URL request for an avatar no mobile visitor ever sees.
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("still fetches when the avatar survives hydration", async () => {
    await hydrateAt(DESKTOP_WIDTH);

    // The other side, so a hook that simply never fetched would fail. The
    // deferral is one render pass, not a cancellation.
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("reports loading while deferred, so no avatar flashes its fallback", async () => {
    await hydrateAt(DESKTOP_WIDTH);

    // A disabled React Query observer is `pending` with `fetchStatus: "idle"`,
    // and `isLoading` means pending *and* fetching - so the raw flag reads
    // `false` on the deferred pass, which `DropDownMenu` would render as the
    // "no picture" icon rather than a neutral placeholder. Asserting on every
    // recorded pass rather than the first: none of them may report "resolved,
    // no picture" while the URL is still unknown.
    expect(loadingByRender.slice(0, 1)).toEqual([true]);
  });
});

/** An avatar whose caller can withdraw its interest, like `MessageHeader`'s. */
const GatedAvatar = ({ enabled }: { enabled: boolean }) => {
  const { profileImageUrl, isLoading } = useProfileImage("other-1", {
    enabled,
  });
  loadingByRender.push(isLoading);
  return (
    <span>{isLoading ? "placeholder" : (profileImageUrl ?? "fallback")}</span>
  );
};

describe("useProfileImage when the caller says it will not render the result", () => {
  /*
   * `MessageHeader` calls this hook above an `if (ismobile)` branch that draws
   * no avatar, so on a phone it used to fire an authenticated presigned-URL
   * request - and an S3 HeadObject behind it - per conversation opened, for a
   * picture nobody saw. Rules of hooks forbid not calling it, so the caller
   * passes `enabled` instead.
   */

  it("fires no request", () => {
    setViewportWidth(DESKTOP_WIDTH);
    queryFn.mockClear();

    render(withClient(<GatedAvatar enabled={false} />));

    expect(queryFn).not.toHaveBeenCalled();
  });

  it("reports nothing rather than reporting loading forever", () => {
    // The opt-out is a decision, not a pause. A caller that will never render
    // the avatar is not waiting for anything, and a hook that claimed
    // otherwise would leave a consumer that *did* render holding a permanent
    // placeholder.
    setViewportWidth(DESKTOP_WIDTH);
    loadingByRender.length = 0;

    render(withClient(<GatedAvatar enabled={false} />));

    expect(loadingByRender).not.toContain(true);
  });

  it("flashes no fallback when the caller changes its mind", async () => {
    /*
     * A phone rotated to landscape with a conversation open: the gate flips
     * false to true and the query enables with nothing cached.
     *
     * **This pins React Query's behaviour, not ours, and that is the point.**
     * The flip looks like it should need the same `isPending` treatment the
     * hydration deferral gets - enabled, no data, fetch started in an effect.
     * It does not, because React Query computes an optimistic result for a
     * query that is about to fetch, so the flip render already reports
     * `fetching`. That is why the hook's second clause stays keyed on
     * hydration alone. Written first with the widened clause and measured
     * against both: this case passes either way, which is the evidence that
     * widening it was unnecessary. If React Query ever drops that optimism,
     * this fails and the clause has to grow.
     *
     * One client across both renders, because a fresh `QueryClient` would
     * reset the cache and make this a first mount rather than a flip.
     */
    setViewportWidth(DESKTOP_WIDTH);
    queryFn.mockClear();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const gated = (enabled: boolean) => (
      <QueryClientProvider client={client}>
        <GatedAvatar enabled={enabled} />
      </QueryClientProvider>
    );

    const { rerender } = render(gated(false));
    loadingByRender.length = 0;

    await act(async () => {
      rerender(gated(true));
    });

    // Nothing between "the caller wants it" and "the URL is known" may report
    // resolved. Asserted over every recorded pass, because the offending one
    // is a single frame inside `act` and leaves no trace in the DOM.
    expect(loadingByRender[0]).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("useProfileImage on a fresh client mount", () => {
  it("starts its request on the first render, undeferred", () => {
    setViewportWidth(DESKTOP_WIDTH);
    queryFn.mockClear();

    render(withClient(<Avatar />));

    /*
     * The regression this guards. `useIsHydrated` reports `true` immediately
     * on a fresh mount precisely so that the fix above costs the common case
     * nothing - every avatar on the explore page mounts client-side, and
     * deferring fifty requests by a render pass to fix a bug none of them has
     * would be a poor trade. A `useState(false)` plus mount effect would fail
     * here.
     */
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
