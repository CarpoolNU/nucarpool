/**
 * That a *disabled* React Query reports `ready`, not `loading`.
 *
 * This is the one fact `HELD_QUERY_STATE` exists for, and it is a fact about
 * @tanstack/react-query rather than about this repo: v5 defines `isLoading` as
 * `isPending && isFetching`, and a query held at `enabled: false` is pending
 * but not fetching. `toQueryState` therefore collapses it to `ready`.
 *
 * That is the behaviour `/`'s recommendations query depends on - a VIEWER is
 * shown a sentence, and a spinner there would be a lie about data that is never
 * coming. It is also the behaviour that would have put a blank frame on
 * `/admin` for a render pass, which is why `UserManagement` and `AdminData`
 * substitute `HELD_QUERY_STATE` while their own gate is closed.
 *
 * Asserted against a real `QueryClient` rather than a stub, because the whole
 * point is that nobody has to take the paragraph above on trust. A version bump
 * that changed `isLoading`'s definition would fail here, next to the constant
 * whose reason for existing would have evaporated.
 *
 * Pinned in `.tsx` because it renders a hook; `queryState.test.ts` holds the
 * pure collapse, including `HELD_QUERY_STATE`'s own behaviour.
 */

import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { toQueryState } from "./queryState";

const queryFn = jest.fn(async () => "payload");

const withClient = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const renderGated = (enabled: boolean) =>
  renderHook(
    () =>
      toQueryState(
        useQuery({ queryKey: ["gated", enabled], queryFn, enabled }),
      ),
    { wrapper: withClient },
  );

beforeEach(() => {
  queryFn.mockClear();
});

describe("a query held at enabled: false", () => {
  it("reads as ready, which is the trap HELD_QUERY_STATE covers", () => {
    const { result } = renderGated(false);

    // Not "loading" - and a component that rendered its spinner on `loading`
    // alone would therefore draw an empty frame instead.
    expect(result.current.status).toBe("ready");
    expect(queryFn).not.toHaveBeenCalled();
  });

  /**
   * The control. Without it the assertion above would pass just as well in a
   * harness where no query ever runs, which would make it meaningless.
   */
  it("control: the same query enabled does report loading, then ready", async () => {
    const { result } = renderGated(true);

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
