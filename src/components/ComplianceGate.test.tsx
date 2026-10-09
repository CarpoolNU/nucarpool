/**
 * Who the blocking terms dialog is put in front of.
 *
 * The gate asks `needsTermsAcceptance` rather than reading
 * `user.licenseSigned` directly, and the risk that introduces is a regression
 * nobody would notice in review: a version comparison that accidentally
 * ignores the policy flag would re-prompt every user who accepted before the
 * version column existed - ~3,341 production rows - on their next page load.
 * These tests pin that those rows stay unprompted.
 *
 * `ComplianceModal` is stubbed rather than rendered. What is under test is the
 * decision, not the dialog, and the real modal is a `next/dynamic` import that
 * would otherwise have to resolve before anything could be asserted. The
 * dialog's own contents and accessibility are covered by
 * `CompliancePortal.test.tsx`.
 *
 * ---
 *
 * **`user.me` is a real React Query, through `testing/trpcHarness.ts`.** A
 * hand-written `jest.fn()` returning `{ data }` cannot distinguish a query
 * that is held back from one that answered with no data, so the signed-out
 * case would have to fall back to asserting that `useQuery` was *called with*
 * `{ enabled: false }` - an assertion about the argument list, not about the
 * request. That passes against a gate that computes the flag correctly and
 * then fails to pass it on, and it would have to be rewritten by hand for any
 * call site that reached the same decision differently. Fetched through the
 * harness, the same case is stated as the thing that actually matters: no
 * request left for `/sign-in`. The fetch counts below are measurements taken
 * from inside the client.
 *
 * Making the query real also makes "still in flight" real: a `queryFn` that
 * never settles, rather than a hand-written `{ data: undefined }` that is
 * indistinguishable from a query which resolved with nothing.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ComplianceGate } from "./ComplianceGate";
import { trpc } from "../utils/trpc";
import { trpcSpies } from "../testing/trpcHarness";
import { CURRENT_TERMS_VERSION } from "../utils/termsAcceptance";
import { nextAuthSpies } from "../testing/nextAuthStub";

const MODAL_TEXT = "compliance modal rendered";

// `next/dynamic` returns a lazily-loaded component. Replacing it with an
// identity-ish loader keeps the gate's own import working while letting the
// stub below stand in for the payload.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <div>{MODAL_TEXT}</div>;
  return Stub;
});

jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock(),
);

/*
 * The stub's own `useSession`, which this suite drives per test. Read after
 * the import section, by which point the factory above has run.
 */
const useSession = nextAuthSpies().useSession;

type MeOverrides = {
  licenseSigned: boolean;
  licenseVersion: string | null;
};

/**
 * What `user.me` resolves with, set per test.
 *
 * `null` means the request never settles, which is how the in-flight case is
 * expressed. Read inside the stub rather than in the spec object, because the
 * `jest.mock` factory below runs before this initialises.
 */
let meResolvesWith: MeOverrides | null = null;

jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock({
    "user.me": {
      query: () =>
        meResolvesWith === null
          ? new Promise(() => undefined)
          : Promise.resolve(meResolvesWith),
    },
  }),
);

/** The `user.me` fetch, counted from inside the client rather than at render. */
const meQueryFn = () => trpcSpies("user.me").queryFn;

const signedIn = () => useSession.mockReturnValue({ status: "authenticated" });

const meReturns = (data: MeOverrides | null) => {
  meResolvesWith = data;
};

const modalShown = () => screen.queryByText(MODAL_TEXT) !== null;

/**
 * A second observer on the gate's own query key, `enabled: false` so it never
 * fetches on its own account.
 *
 * It exists to make the negative assertions below non-vacuous. "The modal is
 * absent" is trivially true for the render before `user.me` answers, which is
 * the render every one of these tests would otherwise assert against - so each
 * negative case waits for this marker first, and is then asking whether the
 * gate stayed quiet *with the data in hand*. A disabled observer still
 * subscribes to the cache, so it sees the value the gate's own query put there
 * without adding a request of its own; the signed-out test below is what proves
 * it adds none.
 */
const MeSettled = () => {
  const { data } = trpc.user.me.useQuery(undefined, { enabled: false });
  return data ? <div data-testid="me-settled" /> : null;
};

const renderGate = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <ComplianceGate />
      <MeSettled />
    </QueryClientProvider>,
  );
};

/** Resolves once the gate has rendered with `user.me`'s answer. */
const meSettled = () =>
  waitFor(() => expect(screen.getByTestId("me-settled")).toBeInTheDocument());

beforeEach(() => {
  jest.clearAllMocks();
  signedIn();
  meReturns({ licenseSigned: true, licenseVersion: CURRENT_TERMS_VERSION });
});

describe("ComplianceGate", () => {
  it("shows the terms to a signed-in user who has never accepted them", async () => {
    meReturns({ licenseSigned: false, licenseVersion: null });

    renderGate();

    // The positive control for every negative assertion below. Without it,
    // a gate that rendered nothing under all conditions would pass the rest
    // of this file.
    await waitFor(() => expect(modalShown()).toBe(true));
  });

  it("does not show the terms to a user who has accepted the current version", async () => {
    renderGate();
    await meSettled();

    expect(modalShown()).toBe(false);
  });

  it("does not re-prompt the legacy cohort, whose version is null", async () => {
    // The regression this file exists for. These rows accepted before the
    // column existed; they are indistinguishable from a real acceptance and
    // must stay unprompted while the re-consent policy is off.
    meReturns({ licenseSigned: true, licenseVersion: null });

    renderGate();
    await meSettled();

    expect(modalShown()).toBe(false);
  });

  it("does not re-prompt a user holding a superseded version", async () => {
    meReturns({ licenseSigned: true, licenseVersion: "2024-10-20" });

    renderGate();
    await meSettled();

    expect(modalShown()).toBe(false);
  });

  it("renders nothing while user.me is still in flight", async () => {
    // Guessing "not consented" here would flash a blocking dialog at users who
    // have already agreed, on every page load.
    meReturns(null);

    renderGate();
    // The request is genuinely outstanding rather than never made, which is
    // what separates this case from the signed-out one below.
    await waitFor(() => expect(meQueryFn()).toHaveBeenCalledTimes(1));

    expect(modalShown()).toBe(false);
    expect(screen.queryByTestId("me-settled")).not.toBeInTheDocument();
  });

  it("renders nothing, and does not query, for a signed-out visitor", async () => {
    useSession.mockReturnValue({ status: "unauthenticated" });

    renderGate();
    // Drains the effects a fetch would have started in, so the assertion below
    // is about a request that was declined rather than one not yet issued.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(modalShown()).toBe(false);
    // The query is still called as a hook - it cannot be conditional - but no
    // request may go out, or `/sign-in` issues an authenticated one. Asserted
    // as the fetch rather than as `useQuery`'s argument list: the gate has to
    // compute the flag *and* hand it to the client, and only this sees both.
    expect(meQueryFn()).not.toHaveBeenCalled();
  });
});
