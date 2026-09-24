/**
 * Who the blocking terms dialog is put in front of.
 *
 * The gate now asks `needsTermsAcceptance` rather than reading
 * `user.licenseSigned` directly, and the risk that introduces is a regression
 * nobody would notice in review: a version comparison that accidentally
 * ignores the policy flag would re-prompt every user who accepted before the
 * version column existed - ~3,341 production rows - on their next page load.
 * These tests pin the shipped behaviour as *identical* to the old boolean
 * check. SCRUM-280.
 *
 * `ComplianceModal` is stubbed rather than rendered. What is under test is the
 * decision, not the dialog, and the real modal is a `next/dynamic` import that
 * would otherwise have to resolve before anything could be asserted. The
 * dialog's own contents and accessibility are covered by
 * `CompliancePortal.test.tsx`.
 */

import { render, screen } from "@testing-library/react";
import { ComplianceGate } from "./ComplianceGate";
import { CURRENT_TERMS_VERSION } from "../utils/termsAcceptance";

const MODAL_TEXT = "compliance modal rendered";

// `next/dynamic` returns a lazily-loaded component. Replacing it with an
// identity-ish loader keeps the gate's own import working while letting the
// stub below stand in for the payload.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <div>{MODAL_TEXT}</div>;
  return Stub;
});

const useSession = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => useSession(),
}));

const useQuery = jest.fn();
jest.mock("../utils/trpc", () => ({
  trpc: {
    user: { me: { useQuery: (...args: unknown[]) => useQuery(...args) } },
  },
}));

type MeOverrides = {
  licenseSigned: boolean;
  licenseVersion: string | null;
};

const signedIn = () => useSession.mockReturnValue({ status: "authenticated" });

const meReturns = (data: MeOverrides | undefined) =>
  useQuery.mockReturnValue({ data });

const modalShown = () => screen.queryByText(MODAL_TEXT) !== null;

beforeEach(() => {
  jest.clearAllMocks();
  signedIn();
  meReturns({ licenseSigned: true, licenseVersion: CURRENT_TERMS_VERSION });
});

describe("ComplianceGate", () => {
  it("shows the terms to a signed-in user who has never accepted them", () => {
    meReturns({ licenseSigned: false, licenseVersion: null });

    render(<ComplianceGate />);

    // The positive control for every negative assertion below. Without it,
    // a gate that rendered nothing under all conditions would pass the rest
    // of this file.
    expect(modalShown()).toBe(true);
  });

  it("does not show the terms to a user who has accepted the current version", () => {
    render(<ComplianceGate />);

    expect(modalShown()).toBe(false);
  });

  it("does not re-prompt the legacy cohort, whose version is null", () => {
    // The regression this file exists for. These rows accepted before the
    // column existed; they are indistinguishable from a real acceptance and
    // must stay unprompted while the re-consent policy is off.
    meReturns({ licenseSigned: true, licenseVersion: null });

    render(<ComplianceGate />);

    expect(modalShown()).toBe(false);
  });

  it("does not re-prompt a user holding a superseded version", () => {
    meReturns({ licenseSigned: true, licenseVersion: "2024-10-20" });

    render(<ComplianceGate />);

    expect(modalShown()).toBe(false);
  });

  it("renders nothing while user.me is still in flight", () => {
    // Guessing "not consented" here would flash a blocking dialog at users who
    // have already agreed, on every page load.
    meReturns(undefined);

    render(<ComplianceGate />);

    expect(modalShown()).toBe(false);
  });

  it("renders nothing, and does not query, for a signed-out visitor", () => {
    useSession.mockReturnValue({ status: "unauthenticated" });
    meReturns(undefined);

    render(<ComplianceGate />);

    expect(modalShown()).toBe(false);
    // The query is still called as a hook - it cannot be conditional - but it
    // must be disabled, or `/sign-in` issues an authenticated request.
    expect(useQuery).toHaveBeenCalledWith(undefined, { enabled: false });
  });
});
